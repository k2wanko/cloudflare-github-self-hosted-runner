import { DurableObject } from "cloudflare:workers";
import {
  createAppJwt,
  type GitHubApiOptions,
  getInstallationToken,
} from "./github/app-auth.ts";
import {
  deleteRunner,
  generateJitConfig,
  type RunnerScope,
} from "./github/jit.ts";
import { type JobRecord, runnerNameFor } from "./job-state.ts";
import {
  canCreateSnapshot,
  canRestoreSnapshot,
  isForkRun,
  isRestoreNotFound,
  type WorkflowRunInfo,
} from "./snapshot-policy.ts";
import type { SnapshotHandle } from "./snapshot-registry.ts";

const JOB_TIME_LIMIT_MS = 6 * 60 * 60 * 1000;
const RESTORE_CHECK_MS = 4000;
const API_OPTIONS: GitHubApiOptions = { userAgent: "cfrunner" };

export type DispatchInput = Omit<JobRecord, "phase" | "runnerId" | "rejected">;

export interface SnapshotResponse {
  status: number;
  body: Record<string, string | number | boolean>;
}

type ContainerHandle = NonNullable<DurableObjectState["container"]>;

function scopeOf(job: JobRecord): RunnerScope {
  return job.ownerIsOrg
    ? { kind: "org", org: job.ownerLogin }
    : { kind: "repo", owner: job.ownerLogin, repo: job.repo };
}

function imageRefOf(image: unknown): string {
  return JSON.stringify(image) ?? String(image);
}

async function fetchRunInfo(
  token: string,
  job: JobRecord,
): Promise<WorkflowRunInfo> {
  const response = await fetch(
    `https://api.github.com/repos/${job.repositoryFullName}/actions/runs/${job.runId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": API_OPTIONS.userAgent,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`workflow run lookup failed: ${response.status}`);
  }
  const run = (await response.json()) as {
    event: string;
    head_branch: string | null;
    head_repository: { full_name: string } | null;
  };
  return {
    event: run.event,
    headBranch: run.head_branch,
    headRepositoryFullName: run.head_repository?.full_name ?? null,
    repositoryFullName: job.repositoryFullName,
    defaultBranch: job.defaultBranch,
  };
}

export class RunnerJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const job = await this.load();
      if (job && ctx.container?.running) {
        await this.armContainer(ctx.container, job);
      }
    });
  }

  private get container(): ContainerHandle {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("container is not available");
    }
    return container;
  }

  private registry() {
    return (job: JobRecord) =>
      this.ctx.exports.SnapshotRegistry.getByName(job.repositoryFullName);
  }

  private async load(): Promise<JobRecord | undefined> {
    return this.ctx.storage.get<JobRecord>("job");
  }

  private async save(job: JobRecord): Promise<void> {
    await this.ctx.storage.put("job", job);
  }

  private async armContainer(
    container: ContainerHandle,
    job: JobRecord,
  ): Promise<void> {
    await container.setInactivityTimeout(JOB_TIME_LIMIT_MS);
    await container.interceptOutboundHttp(
      this.env.INTERNAL_HOST,
      this.ctx.exports.Control({ props: { jobId: job.jobId } }),
    );
  }

  async dispatch(input: DispatchInput): Promise<"accepted" | "duplicate"> {
    if (await this.load()) {
      return "duplicate";
    }
    await this.save({ ...input, phase: "dispatched" });
    this.ctx.waitUntil(this.startRunnerOrFail());
    return "accepted";
  }

  async markStarted(): Promise<void> {
    const job = await this.load();
    if (job && job.phase !== "completed") {
      await this.save({ ...job, phase: "started" });
    }
  }

  async markCompleted(conclusion: string | null): Promise<void> {
    const job = await this.load();
    if (!job || job.phase === "completed") {
      return;
    }
    await this.save({ ...job, phase: "completed" });
    await this.registry()(job).promote(job.jobId, conclusion === "success");
    if (this.container.running) {
      await this.container.destroy("job completed");
    }
  }

  async createSnapshot(): Promise<SnapshotResponse> {
    const job = await this.load();
    if (!job || (job.phase !== "starting" && job.phase !== "started")) {
      return { status: 409, body: { error: "job is not running" } };
    }
    if (!job.snapshot || !job.imageRef) {
      return { status: 400, body: { error: "no snapshot label on this job" } };
    }
    if (!job.allowCreate) {
      return {
        status: 403,
        body: { error: "snapshots can only be created from allowed refs" },
      };
    }

    const registry = this.registry()(job);
    await registry.reserve(job.snapshot, job.imageRef, job.jobId);

    try {
      const handle = await this.container.snapshotContainer({
        name: job.snapshot,
      });
      await registry.attach(job.snapshot, job.imageRef, job.jobId, {
        id: handle.id,
        size: handle.size,
        name: job.snapshot,
      });
      return {
        status: 200,
        body: {
          created: true,
          name: job.snapshot,
          size: handle.size,
          availableAfterJobCompletes: true,
        },
      };
    } catch (error) {
      await registry.abandon(job.snapshot, job.imageRef, job.jobId);
      return { status: 500, body: { error: String(error) } };
    }
  }

  private async startRunnerOrFail(): Promise<void> {
    const cleanup: { token?: string; runnerId?: number } = {};
    try {
      await this.startRunner(cleanup);
    } catch (error) {
      const job = await this.load();
      console.error("runner start failed", job?.jobId, String(error));
      if (job) {
        await this.save({
          ...job,
          phase: "completed",
          rejected: String(error),
        });
        if (cleanup.token && cleanup.runnerId !== undefined) {
          await deleteRunner(
            cleanup.token,
            scopeOf(job),
            cleanup.runnerId,
            API_OPTIONS,
          ).catch(() => undefined);
        }
      }
    }
  }

  private async startRunner(cleanup: {
    token?: string;
    runnerId?: number;
  }): Promise<void> {
    const job = await this.load();
    if (!job || job.phase !== "dispatched") {
      return;
    }
    await this.save({ ...job, phase: "starting" });

    const credentials =
      await this.ctx.exports.Setup.getByName("singleton").getCredentials();
    if (!credentials) {
      throw new Error("setup is not completed");
    }

    const appJwt = await createAppJwt(credentials.appId, credentials.pem);
    const token = await getInstallationToken(
      appJwt,
      job.installationId,
      API_OPTIONS,
    );

    cleanup.token = token;

    console.log("job", job.jobId, "fetching run info");
    const run = await fetchRunInfo(token, job);
    if (isForkRun(run)) {
      await this.save({ ...job, phase: "completed", rejected: "fork" });
      return;
    }

    const images = this.container.images as Record<string, unknown>;
    const image = images[job.image];
    if (!image) {
      throw new Error(`unknown image: ${job.image}`);
    }
    const imageRef = imageRefOf(image);
    const allowCreate = canCreateSnapshot(run);
    const allowRestore = canRestoreSnapshot(
      run,
      this.env.SNAPSHOT_RESTORE_ANY_REF === "true",
    );

    console.log("job", job.jobId, "creating jit config");
    const jit = await generateJitConfig(
      token,
      scopeOf(job),
      runnerNameFor(job.jobId, job.attempt),
      job.labels,
      API_OPTIONS,
    );

    cleanup.runnerId = jit.runnerId;

    const latest = await this.load();
    if (!latest || latest.phase === "completed") {
      await deleteRunner(token, scopeOf(job), jit.runnerId, API_OPTIONS);
      return;
    }
    await this.save({
      ...latest,
      phase: "starting",
      runnerId: jit.runnerId,
      imageRef,
      allowCreate,
    });

    let handle: SnapshotHandle | null = null;
    if (job.snapshot && allowRestore) {
      handle = await this.registry()(job).resolve(job.snapshot, imageRef);
      console.log(
        "job",
        job.jobId,
        "snapshot",
        job.snapshot,
        handle ? "hit" : "miss",
      );
    }

    console.log("job", job.jobId, "starting container");
    const started = await this.startContainer(
      latest,
      image,
      jit.encodedJitConfig,
      handle,
    );
    if (started === "restore-not-found" && handle) {
      await this.registry()(job).restoreFailed(handle.id);
      await this.startContainer(latest, image, jit.encodedJitConfig, null);
    }
  }

  private async startContainer(
    job: JobRecord,
    image: unknown,
    jitConfig: string,
    snapshot: SnapshotHandle | null,
  ): Promise<"ok" | "restore-not-found"> {
    const container = this.container;
    container.start({
      ...(snapshot
        ? { containerSnapshot: snapshot }
        : { image: image as never }),
      instance: job.instance,
      enableInternet: true,
      env: {
        JITCONFIG: jitConfig,
        CFRUNNER_ENDPOINT: `http://${this.env.INTERNAL_HOST}`,
        CFRUNNER_SNAPSHOT_HIT: snapshot ? "true" : "false",
      },
    });
    await this.armContainer(container, job);

    const exit = container.monitor().then(
      () => undefined,
      (error: unknown) => error,
    );
    const startedAt = Date.now();
    this.ctx.waitUntil(
      exit.then(async (reason) => {
        console.log(
          "container exited",
          job.jobId,
          `after ${Date.now() - startedAt}ms`,
          reason === undefined ? "cleanly" : String(reason),
        );
        await container.destroy("container exited").catch(() => undefined);
      }),
    );

    if (!snapshot) {
      return "ok";
    }
    const early = await Promise.race([
      exit,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), RESTORE_CHECK_MS),
      ),
    ]);
    return early !== undefined && isRestoreNotFound(early)
      ? "restore-not-found"
      : "ok";
  }
}
