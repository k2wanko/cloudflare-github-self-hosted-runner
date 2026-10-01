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

const JOB_TIME_LIMIT_MS = 6 * 60 * 60 * 1000;
const API_OPTIONS: GitHubApiOptions = { userAgent: "cfrunner" };

export type DispatchInput = Omit<JobRecord, "phase" | "runnerId">;

function scopeOf(job: JobRecord): RunnerScope {
  return job.ownerIsOrg
    ? { kind: "org", org: job.ownerLogin }
    : { kind: "repo", owner: job.ownerLogin, repo: job.repo };
}

export class RunnerJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) {
        await ctx.container.setInactivityTimeout(JOB_TIME_LIMIT_MS);
        this.watchContainer();
      }
    });
  }

  private get container(): NonNullable<DurableObjectState["container"]> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("container is not available");
    }
    return container;
  }

  private async load(): Promise<JobRecord | undefined> {
    return this.ctx.storage.get<JobRecord>("job");
  }

  private async save(job: JobRecord): Promise<void> {
    await this.ctx.storage.put("job", job);
  }

  async dispatch(input: DispatchInput): Promise<"accepted" | "duplicate"> {
    if (await this.load()) {
      return "duplicate";
    }
    await this.save({ ...input, phase: "dispatched" });
    this.ctx.waitUntil(this.startRunner());
    return "accepted";
  }

  async markStarted(): Promise<void> {
    const job = await this.load();
    if (job && job.phase !== "completed") {
      await this.save({ ...job, phase: "started" });
    }
  }

  async markCompleted(): Promise<void> {
    const job = await this.load();
    if (!job || job.phase === "completed") {
      return;
    }
    await this.save({ ...job, phase: "completed" });
    if (this.container.running) {
      await this.container.destroy("job completed");
    }
  }

  async markCancelledBeforeAssignment(): Promise<void> {
    await this.markCompleted();
  }

  private watchContainer(): void {
    this.ctx.waitUntil(
      this.container
        .monitor()
        .catch(() => undefined)
        .then(() => this.container.destroy("container exited")),
    );
  }

  private async startRunner(): Promise<void> {
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
    const runnerName = runnerNameFor(job.jobId, job.attempt);
    const jit = await generateJitConfig(
      token,
      scopeOf(job),
      runnerName,
      job.labels,
      API_OPTIONS,
    );

    const latest = await this.load();
    if (!latest || latest.phase === "completed") {
      await deleteRunner(token, scopeOf(job), jit.runnerId, API_OPTIONS);
      return;
    }
    await this.save({ ...latest, phase: "starting", runnerId: jit.runnerId });

    const images = this.container.images as Record<string, unknown>;
    const image = images[job.image];
    if (!image) {
      throw new Error(`unknown image: ${job.image}`);
    }

    this.container.start({
      image: image as never,
      instance: job.instance,
      enableInternet: true,
      env: { JITCONFIG: jit.encodedJitConfig },
    });
    await this.container.setInactivityTimeout(JOB_TIME_LIMIT_MS);
    this.watchContainer();
  }
}
