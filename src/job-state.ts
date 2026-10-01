import type { InstanceSpec } from "./label-parser.ts";

export type JobPhase = "dispatched" | "starting" | "started" | "completed";

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
  imageRef?: string;
  allowCreate?: boolean;
  runnerId?: number;
  rejected?: string;
}

export const RUNNER_NAME_PREFIX = "cf-";

export function runnerNameFor(jobId: number, attempt: number): string {
  return `${RUNNER_NAME_PREFIX}${jobId}-${attempt}`;
}

export function jobIdFromRunnerName(
  runnerName: string | null | undefined,
): number | undefined {
  const match = /^cf-(\d+)-\d+$/.exec(runnerName ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
}
