export const ORPHAN_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const JOB_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_UNASSIGNED_LIMIT_MS = 15 * 60 * 1000;

export interface RunJob {
  id: number;
  status: string;
  conclusion: string | null;
  runnerName: string | null;
}

interface JudgeInput {
  runnerName: string;
  jobId: number;
  startedAt: number;
  now: number;
}

type Verdict =
  | { kind: "running" }
  | { kind: "finished"; conclusion: string | null }
  | { kind: "unassigned" };

export function judgeRunnerJob(
  jobs: readonly RunJob[],
  input: JudgeInput,
): Verdict {
  const taken = jobs.find((job) => job.runnerName === input.runnerName);
  if (taken) {
    return taken.status === "completed"
      ? { kind: "finished", conclusion: taken.conclusion }
      : { kind: "running" };
  }

  const queued = jobs.find((job) => job.id === input.jobId);
  if (queued?.status === "completed") {
    return { kind: "finished", conclusion: queued.conclusion };
  }

  return input.now - input.startedAt > ORPHAN_UNASSIGNED_LIMIT_MS
    ? { kind: "unassigned" }
    : { kind: "running" };
}
