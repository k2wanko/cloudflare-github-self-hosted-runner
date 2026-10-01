import { DurableObject } from "cloudflare:workers";
import { createAppJwt, getInstallationToken } from "./github/app-auth.ts";
import {
  deleteRunner,
  generateJitConfig,
  type RunnerScope,
} from "./github/jit.ts";
import { fetchWorkflowRun } from "./github/workflow-run.ts";
import { type JobRecord, runnerNameFor } from "./job-state.ts";
import { SETUP_INSTANCE } from "./setup/setup-do.ts";
import {
  canCreateSnapshot,
  canRestoreSnapshot,
  isForkRun,
  isRestoreNotFound,
} from "./snapshot-policy.ts";
import type { SnapshotHandle } from "./snapshot-registry.ts";

const JOB_TIME_LIMIT_MS = 6 * 60 * 60 * 1000;
const RESTORE_CHECK_MS = 4000;

type DispatchInput = Omit<JobRecord, "phase" | "rejected">;

interface SnapshotResponse {
  status: number;
  body: Record<string, string | number | boolean>;
}

type ContainerHandle = NonNullable<DurableObjectState["container"]>;

function scopeOf(job: JobRecord): RunnerScope {
  return job.ownerIsOrg
    ? { kind: "org", org: job.ownerLogin }
    : { kind: "repo", owner: job.ownerLogin, repo: job.repo };
}

export class RunnerJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const job = await this.load();
      if (job && ctx.container?.running) {
        await this.prepareRunningContainer(ctx.container, job);
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

  private registry(job: JobRecord) {
    return this.ctx.exports.SnapshotRegistry.getByName(job.repositoryFullName);
  }

  private async load(): Promise<JobRecord | undefined> {
    return this.ctx.storage.get<JobRecord>("job");
  }

  private async save(job: JobRecord): Promise<void> {
    await this.ctx.storage.put("job", job);
  }

  private async prepareRunningContainer(
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
    if (!job) {
      return;
    }
    if (job.phase !== "completed") {
      await this.save({ ...job, phase: "completed" });
    }
    await Promise.all([
      this.registry(job).promote(job.jobId, conclusion === "success"),
      this.container.running
        ? this.container.destroy("job completed")
        : undefined,
    ]);
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

    const registry = this.registry(job);
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
    try {
      await this.startRunner();
    } catch (error) {
      const job = await this.load();
      console.error("runner start failed", job?.jobId, String(error));
      if (job) {
        await this.save({
          ...job,
          phase: "completed",
          rejected: String(error),
        });
      }
    }
  }

  private async startRunner(): Promise<void> {
    const job = await this.load();
    if (!job || job.phase !== "dispatched") {
      return;
    }
    await this.save({ ...job, phase: "starting" });

    const credentials =
      await this.ctx.exports.Setup.getByName(SETUP_INSTANCE).getCredentials();
    if (!credentials) {
      throw new Error("setup is not completed");
    }

    const token = await getInstallationToken(
      await createAppJwt(credentials.appId, credentials.pem),
      job.installationId,
    );

    console.log("job", job.jobId, "fetching run info");
    const run = await fetchWorkflowRun(
      token,
      job.repositoryFullName,
      job.runId,
      job.defaultBranch,
    );
    if (isForkRun(run)) {
      await this.save({ ...job, phase: "completed", rejected: "fork" });
      return;
    }

    const image = this.container.images[job.image];
    if (!image) {
      throw new Error(`unknown image: ${job.image}`);
    }
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
    );

    try {
      const registry = this.registry(job);
      let handle: SnapshotHandle | null = null;
      if (job.snapshot && allowRestore) {
        handle = await registry.resolve(job.snapshot, image);
        console.log(
          "job",
          job.jobId,
          "snapshot",
          job.snapshot,
          handle ? "hit" : "miss",
        );
      }

      const latest = await this.load();
      if (!latest || latest.phase === "completed") {
        await deleteRunner(token, scopeOf(job), jit.runnerId);
        return;
      }
      await this.save({
        ...latest,
        imageRef: image,
        allowCreate: canCreateSnapshot(run),
      });

      console.log("job", job.jobId, "starting container");
      const first = await this.startContainer(
        latest,
        image,
        jit.encodedJitConfig,
        handle,
      );
      if (handle && first.restoreNotFound) {
        await first.exitHandled;
        await registry.restoreFailed(handle.id);
        await this.startContainer(latest, image, jit.encodedJitConfig, null);
      }
    } catch (error) {
      await deleteRunner(token, scopeOf(job), jit.runnerId).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async startContainer(
    job: JobRecord,
    image: string,
    jitConfig: string,
    snapshot: SnapshotHandle | null,
  ): Promise<{ restoreNotFound: boolean; exitHandled: Promise<void> }> {
    const container = this.container;
    container.start({
      ...(snapshot ? { containerSnapshot: snapshot } : { image }),
      instance: job.instance,
      enableInternet: true,
      env: {
        JITCONFIG: jitConfig,
        CFRUNNER_ENDPOINT: `http://${this.env.INTERNAL_HOST}`,
        CFRUNNER_SNAPSHOT_HIT: snapshot ? "true" : "false",
      },
    });
    await this.prepareRunningContainer(container, job);

    const exit = container.monitor().then(
      () => undefined,
      (error: unknown) => error,
    );
    const startedAt = Date.now();
    const exitHandled = exit.then(async (reason) => {
      console.log(
        "container exited",
        job.jobId,
        `after ${Date.now() - startedAt}ms`,
        reason === undefined ? "cleanly" : String(reason),
      );
      await container.destroy("container exited").catch(() => undefined);
    });
    this.ctx.waitUntil(exitHandled);

    if (!snapshot) {
      return { restoreNotFound: false, exitHandled };
    }
    const early = await Promise.race([
      exit,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), RESTORE_CHECK_MS),
      ),
    ]);
    return {
      restoreNotFound: early !== undefined && isRestoreNotFound(early),
      exitHandled,
    };
  }
}
