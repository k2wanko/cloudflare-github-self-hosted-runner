import { verifyWebhookSignature } from "./github/webhook-signature.ts";
import { jobIdFromRunnerName } from "./job-state.ts";
import { parseLabels } from "./label-parser.ts";
import { isAllowedOwner, parseAllowedOwners } from "./setup/manifest.ts";

interface WorkflowJobPayload {
  action: string;
  workflow_job: {
    id: number;
    run_id: number;
    run_attempt: number;
    labels: string[];
    runner_name: string | null;
  };
  repository: { name: string; owner: { login: string; type: string } };
  installation?: { id: number };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const credentials =
    await ctx.exports.Setup.getByName("singleton").getCredentials();
  if (!credentials) {
    return json({ error: "not configured" }, 503);
  }

  const body = await request.text();
  const valid = await verifyWebhookSignature(
    credentials.webhookSecret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!valid) {
    return json({ error: "invalid signature" }, 401);
  }

  const event = request.headers.get("x-github-event");
  if (event !== "workflow_job") {
    return json({ ignored: event });
  }

  const payload = JSON.parse(body) as WorkflowJobPayload;
  const job = payload.workflow_job;
  const owner = payload.repository.owner;
  if (!isAllowedOwner(owner.login, parseAllowedOwners(env.ALLOWED_OWNERS))) {
    return json({ ignored: "owner not allowed" });
  }

  const jobs = ctx.exports.RunnerJob;

  if (payload.action === "queued") {
    const parsed = parseLabels(job.labels, {
      prefix: env.LABEL_PREFIX,
      runId: job.run_id,
      runAttempt: job.run_attempt,
    });
    if (!parsed.matched) {
      return json({ ignored: "labels" });
    }
    if (parsed.error !== undefined) {
      console.warn("rejected job labels", job.id, parsed.error);
      return json({ rejected: parsed.error });
    }
    if (!payload.installation) {
      return json({ error: "missing installation" }, 400);
    }
    const result = await jobs.getByName(String(job.id)).dispatch({
      installationId: payload.installation.id,
      ownerLogin: owner.login,
      ownerIsOrg: owner.type === "Organization",
      repo: payload.repository.name,
      jobId: job.id,
      attempt: job.run_attempt,
      labels: job.labels,
      image: parsed.image ?? "default",
      instance: parsed.instance,
    });
    return json({ dispatch: result });
  }

  const targetJobId = jobIdFromRunnerName(job.runner_name);
  if (payload.action === "in_progress" && targetJobId !== undefined) {
    await jobs.getByName(String(targetJobId)).markStarted();
    return json({ started: targetJobId });
  }
  if (payload.action === "completed") {
    if (targetJobId !== undefined) {
      await jobs.getByName(String(targetJobId)).markCompleted();
      return json({ completed: targetJobId });
    }
    if (job.runner_name === null) {
      await jobs.getByName(String(job.id)).markCancelledBeforeAssignment();
      return json({ cancelled: job.id });
    }
  }
  return json({ ignored: payload.action });
}
