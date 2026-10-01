const INSTANCE_PRESETS = [
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;

type InstancePreset = (typeof INSTANCE_PRESETS)[number];

interface CustomInstance {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

export type InstanceSpec = InstancePreset | CustomInstance;

const DEFAULT_INSTANCE: InstancePreset = "standard-1";

const CUSTOM_INSTANCE_LIMITS = {
  minVcpu: 1,
  maxVcpu: 4,
  minMemoryGibPerVcpu: 3,
  maxMemoryGib: 12,
  maxDiskGb: 20,
} as const;

interface LabelContext {
  prefix: string;
  runId: number;
  runAttempt: number;
}

type ParsedLabels =
  | { matched: false }
  | { matched: true; error: string }
  | {
      matched: true;
      error?: undefined;
      image?: string;
      instance: InstanceSpec;
      snapshot?: string;
    };

const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parseCustomInstance(value: string): CustomInstance | string {
  const fields = new Map<string, number>();
  for (const part of value.split(",")) {
    const [key, raw, ...rest] = part.split("=");
    if (!key || raw === undefined || rest.length > 0) {
      return `invalid instance field: ${part}`;
    }
    if (key !== "cpu" && key !== "memory" && key !== "disk") {
      return `unknown instance field: ${key}`;
    }
    if (fields.has(key)) {
      return `duplicate instance field: ${key}`;
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number <= 0) {
      return `invalid value for ${key}: ${raw}`;
    }
    fields.set(key, number);
  }

  const cpu = fields.get("cpu");
  const memory = fields.get("memory");
  const disk = fields.get("disk");
  if (cpu === undefined || memory === undefined || disk === undefined) {
    return "custom instance requires cpu, memory and disk";
  }

  const limits = CUSTOM_INSTANCE_LIMITS;
  if (!Number.isInteger(cpu) || cpu < limits.minVcpu || cpu > limits.maxVcpu) {
    return `cpu must be an integer between ${limits.minVcpu} and ${limits.maxVcpu}`;
  }
  if (memory < cpu * limits.minMemoryGibPerVcpu) {
    return `memory must be at least ${limits.minMemoryGibPerVcpu} GiB per vCPU`;
  }
  if (memory > limits.maxMemoryGib) {
    return `memory must be at most ${limits.maxMemoryGib} GiB`;
  }
  if (disk > limits.maxDiskGb) {
    return `disk must be at most ${limits.maxDiskGb} GB`;
  }

  return {
    vcpu: cpu,
    memoryMib: Math.round(memory * 1024),
    diskMb: Math.round(disk * 1000),
  };
}

export function parseLabels(
  labels: readonly string[],
  context: LabelContext,
): ParsedLabels {
  const jobLabelPrefix = `${context.prefix}-`;
  const jobLabels = labels.filter((label) => label.startsWith(jobLabelPrefix));
  if (jobLabels.length === 0) {
    return { matched: false };
  }

  const expectedJobLabel = `${context.prefix}-${context.runId}-${context.runAttempt}`;
  if (!jobLabels.includes(expectedJobLabel)) {
    return {
      matched: true,
      error: `job label must be ${expectedJobLabel}`,
    };
  }

  let image: string | undefined;
  let instance: InstanceSpec | undefined;
  let snapshot: string | undefined;

  for (const label of labels) {
    if (label.startsWith("image:")) {
      if (image !== undefined) {
        return { matched: true, error: "duplicate image label" };
      }
      image = label.slice("image:".length);
      if (!IMAGE_NAME.test(image)) {
        return { matched: true, error: `invalid image name: ${image}` };
      }
    } else if (label.startsWith("instance:")) {
      if (instance !== undefined) {
        return { matched: true, error: "duplicate instance label" };
      }
      const value = label.slice("instance:".length);
      if ((INSTANCE_PRESETS as readonly string[]).includes(value)) {
        instance = value as InstancePreset;
      } else {
        const custom = parseCustomInstance(value);
        if (typeof custom === "string") {
          return { matched: true, error: custom };
        }
        instance = custom;
      }
    } else if (label.startsWith("snapshot:")) {
      if (snapshot !== undefined) {
        return { matched: true, error: "duplicate snapshot label" };
      }
      snapshot = label.slice("snapshot:".length);
      if (!SNAPSHOT_NAME.test(snapshot)) {
        return { matched: true, error: `invalid snapshot name: ${snapshot}` };
      }
    }
  }

  return {
    matched: true,
    image,
    instance: instance ?? DEFAULT_INSTANCE,
    snapshot,
  };
}
