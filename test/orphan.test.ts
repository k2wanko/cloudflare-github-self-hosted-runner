import { describe, expect, test } from "bun:test";
import {
  judgeRunnerJob,
  ORPHAN_UNASSIGNED_LIMIT_MS,
  type RunJob,
} from "../src/orphan.ts";

const runnerName = "cf-100-1";
const input = { runnerName, jobId: 100, startedAt: 0 };

function job(overrides: Partial<RunJob>): RunJob {
  return {
    id: 100,
    status: "queued",
    conclusion: null,
    runnerName: null,
    ...overrides,
  };
}

describe("judgeRunnerJob", () => {
  test("keeps waiting while the runner's job is in progress", () => {
    const jobs = [job({ id: 7, status: "in_progress", runnerName })];
    expect(judgeRunnerJob(jobs, { ...input, now: 10 })).toEqual({
      kind: "running",
    });
  });

  test("finishes with the conclusion of the job the runner took", () => {
    const jobs = [
      job({ id: 7, status: "completed", conclusion: "success", runnerName }),
    ];
    expect(judgeRunnerJob(jobs, { ...input, now: 10 })).toEqual({
      kind: "finished",
      conclusion: "success",
    });
  });

  test("finishes when the queued job was cancelled before assignment", () => {
    const jobs = [job({ status: "completed", conclusion: "cancelled" })];
    expect(judgeRunnerJob(jobs, { ...input, now: 10 })).toEqual({
      kind: "finished",
      conclusion: "cancelled",
    });
  });

  test("waits for an assignment until the limit, then gives up", () => {
    const jobs = [job({ status: "queued" })];
    expect(
      judgeRunnerJob(jobs, { ...input, now: ORPHAN_UNASSIGNED_LIMIT_MS }),
    ).toEqual({ kind: "running" });
    expect(
      judgeRunnerJob(jobs, { ...input, now: ORPHAN_UNASSIGNED_LIMIT_MS + 1 }),
    ).toEqual({ kind: "unassigned" });
  });

  test("a job taken by another runner does not count as ours", () => {
    const jobs = [
      job({ status: "in_progress", runnerName: "cf-999-1" }),
      job({ id: 200, status: "queued" }),
    ];
    expect(judgeRunnerJob(jobs, { ...input, now: 10 })).toEqual({
      kind: "running",
    });
  });

  test("an empty job list is treated as unassigned only after the limit", () => {
    expect(judgeRunnerJob([], { ...input, now: 10 })).toEqual({
      kind: "running",
    });
    expect(
      judgeRunnerJob([], { ...input, now: ORPHAN_UNASSIGNED_LIMIT_MS + 1 }),
    ).toEqual({ kind: "unassigned" });
  });
});
