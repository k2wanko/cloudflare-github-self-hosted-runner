import { describe, expect, test } from "bun:test";
import {
  canCreateSnapshot,
  canRestoreSnapshot,
  isExpired,
  isForkRun,
  isRestoreNotFound,
  SNAPSHOT_RETENTION_MS,
  type WorkflowRunInfo,
} from "../src/snapshot-policy.ts";

const base: WorkflowRunInfo = {
  event: "push",
  headBranch: "main",
  headRepositoryFullName: "example/repo",
  repositoryFullName: "Example/Repo",
  defaultBranch: "main",
};

describe("snapshot policy", () => {
  test("default-branch pushes, dispatches and schedules may create", () => {
    for (const event of ["push", "workflow_dispatch", "schedule"]) {
      expect(canCreateSnapshot({ ...base, event })).toBe(true);
    }
  });

  test("pull requests, other branches and risky events may not create", () => {
    expect(canCreateSnapshot({ ...base, event: "pull_request" })).toBe(false);
    expect(canCreateSnapshot({ ...base, event: "pull_request_target" })).toBe(
      false,
    );
    expect(canCreateSnapshot({ ...base, event: "workflow_run" })).toBe(false);
    expect(canCreateSnapshot({ ...base, headBranch: "feature" })).toBe(false);
    expect(canCreateSnapshot({ ...base, headBranch: null })).toBe(false);
  });

  test("fork runs are detected case-insensitively and never allowed", () => {
    expect(isForkRun(base)).toBe(false);
    const fork = { ...base, headRepositoryFullName: "mallory/repo" };
    expect(isForkRun(fork)).toBe(true);
    expect(isForkRun({ ...base, headRepositoryFullName: null })).toBe(true);
    expect(canCreateSnapshot(fork)).toBe(false);
    expect(canRestoreSnapshot(fork, true)).toBe(false);
  });

  test("restore follows creation rules unless any ref is allowed", () => {
    const pr = { ...base, event: "pull_request", headBranch: "feature" };
    expect(canRestoreSnapshot(pr, false)).toBe(false);
    expect(canRestoreSnapshot(pr, true)).toBe(true);
    expect(canRestoreSnapshot(base, false)).toBe(true);
  });

  test("expiry uses a fixed retention window", () => {
    expect(isExpired(0, SNAPSHOT_RETENTION_MS)).toBe(false);
    expect(isExpired(0, SNAPSHOT_RETENTION_MS + 1)).toBe(true);
  });

  test("recognises the missing-snapshot error from the runtime", () => {
    expect(
      isRestoreNotFound(
        new Error(
          'Snapshot "00000000-0000-4000-8000-000000000000" was not found.',
        ),
      ),
    ).toBe(true);
    expect(isRestoreNotFound(new Error("something else"))).toBe(false);
  });
});
