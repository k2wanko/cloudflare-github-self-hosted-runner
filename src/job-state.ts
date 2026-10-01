import type { InstanceSpec } from "./label-parser.ts";

type JobPhase = "dispatched" | "starting" | "started" | "completed";

export interface JobRecord {
  phase: JobPhase;
  installationId: number;
  ownerLogin: string;
  ownerIsOrg: boolean;
  repo: string;
  repositoryFullName: string;
  defaultBranch: string;
  runId: number;
  jobId: number;
  attempt: number;
  labels: string[];
  image: string;
  instance: InstanceSpec;
  snapshot?: string;
  docker: boolean;
  imageRef?: string;
  allowCreate?: boolean;
  rejected?: string;
}

const RUNNER_NAME_PREFIX = "cf-";
const RUNNER_NAME_PATTERN = new RegExp(`^${RUNNER_NAME_PREFIX}(\\d+)-\\d+$`);

export function runnerNameFor(jobId: number, attempt: number): string {
  return `${RUNNER_NAME_PREFIX}${jobId}-${attempt}`;
}

export function jobIdFromRunnerName(
  runnerName: string | null | undefined,
): number | undefined {
  const match = RUNNER_NAME_PATTERN.exec(runnerName ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
}
