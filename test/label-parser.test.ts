import { describe, expect, test } from "bun:test";
import { parseLabels } from "../src/label-parser.ts";

const context = { prefix: "cfrunner", runId: 123, runAttempt: 2 };
const jobLabel = "cfrunner-123-2";

describe("parseLabels", () => {
  test("ignores jobs without the prefix", () => {
    expect(parseLabels(["self-hosted", "linux"], context)).toEqual({
      matched: false,
    });
  });

  test("defaults to standard-1 without image or snapshot", () => {
    expect(parseLabels([jobLabel], context)).toEqual({
      matched: true,
      image: undefined,
      instance: "standard-1",
      snapshot: undefined,
    });
  });

  test("rejects a job label for another run", () => {
    const result = parseLabels(["cfrunner-999-1"], context);
    expect(result).toEqual({
      matched: true,
      error: "job label must be cfrunner-123-2",
    });
  });

  test("parses a preset instance", () => {
    const result = parseLabels([jobLabel, "instance:standard-2"], context);
    expect(result).toMatchObject({ matched: true, instance: "standard-2" });
  });

  test.each(["basic", "lite"])(
    "rejects %s, which cannot run the runner",
    (preset) => {
      const result = parseLabels([jobLabel, `instance:${preset}`], context);
      expect(result).toMatchObject({ matched: true });
      expect("error" in result && result.error).toBeTruthy();
    },
  );

  test("parses a custom instance", () => {
    const result = parseLabels(
      [jobLabel, "instance:cpu=2,memory=6,disk=16"],
      context,
    );
    expect(result).toMatchObject({
      matched: true,
      instance: { vcpu: 2, memoryMib: 6144, diskMb: 16000 },
    });
  });

  test.each([
    ["cpu=2,memory=5,disk=10", "at least 3 GiB per vCPU"],
    ["cpu=5,memory=15,disk=10", "cpu must be"],
    ["cpu=2,memory=13,disk=10", "at most 12 GiB"],
    ["cpu=2,memory=6,disk=21", "at most 20 GB"],
    ["cpu=2,memory=6", "requires cpu, memory and disk"],
    ["cpu=2,memory=6,disk=10,gpu=1", "unknown instance field"],
    ["cpu=2,cpu=2,memory=6,disk=10", "duplicate instance field"],
    ["cpu=x,memory=6,disk=10", "invalid value for cpu"],
  ])("rejects custom instance %s", (value, message) => {
    const result = parseLabels([jobLabel, `instance:${value}`], context);
    expect(result).toMatchObject({ matched: true });
    expect("error" in result && result.error).toContain(message);
  });

  test("parses image and snapshot", () => {
    const result = parseLabels(
      [jobLabel, "image:ubuntu", "snapshot:node24-v1"],
      context,
    );
    expect(result).toMatchObject({
      matched: true,
      image: "ubuntu",
      snapshot: "node24-v1",
    });
  });

  test("rejects invalid snapshot names and duplicates", () => {
    expect(parseLabels([jobLabel, "snapshot:a/b"], context)).toMatchObject({
      error: expect.stringContaining("invalid snapshot name"),
    });
    expect(
      parseLabels([jobLabel, "snapshot:a", "snapshot:b"], context),
    ).toMatchObject({ error: "duplicate snapshot label" });
  });

  test("keeps unrelated custom labels such as a unique job label", () => {
    const result = parseLabels([jobLabel, "job1"], context);
    expect(result).toMatchObject({ matched: true, instance: "standard-1" });
  });
});
