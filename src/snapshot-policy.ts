export interface WorkflowRunInfo {
  event: string;
  headBranch: string | null;
  headRepositoryFullName: string | null;
  repositoryFullName: string;
  defaultBranch: string;
}

const SNAPSHOT_CREATE_EVENTS = [
  "push",
  "workflow_dispatch",
  "schedule",
] as const;

export function isForkRun(run: WorkflowRunInfo): boolean {
  return (
    run.headRepositoryFullName === null ||
    run.headRepositoryFullName.toLowerCase() !==
      run.repositoryFullName.toLowerCase()
  );
}

export function canCreateSnapshot(run: WorkflowRunInfo): boolean {
  return (
    !isForkRun(run) &&
    run.headBranch === run.defaultBranch &&
    (SNAPSHOT_CREATE_EVENTS as readonly string[]).includes(run.event)
  );
}

export function canRestoreSnapshot(
  run: WorkflowRunInfo,
  restoreFromAnyRef: boolean,
): boolean {
  return restoreFromAnyRef ? !isForkRun(run) : canCreateSnapshot(run);
}

export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_RESERVATION_TTL_MS = 7 * 60 * 60 * 1000;

export function isExpired(lastUsedAt: number, now: number): boolean {
  return now - lastUsedAt > SNAPSHOT_RETENTION_MS;
}

export function isRestoreNotFound(error: unknown): boolean {
  return /snapshot .* was not found/i.test(String(error));
}
