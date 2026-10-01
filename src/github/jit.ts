import type { GitHubApiOptions } from "./app-auth.ts";

export type RunnerScope =
  | { kind: "org"; org: string }
  | { kind: "repo"; owner: string; repo: string };

export interface JitRunner {
  runnerId: number;
  encodedJitConfig: string;
}

const DEFAULT_RUNNER_GROUP_ID = 1;

function scopePath(scope: RunnerScope): string {
  return scope.kind === "org"
    ? `/orgs/${encodeURIComponent(scope.org)}`
    : `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
}

function headers(token: string, options: GitHubApiOptions): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": options.userAgent,
  };
}

export async function generateJitConfig(
  installationToken: string,
  scope: RunnerScope,
  runnerName: string,
  labels: readonly string[],
  options: GitHubApiOptions,
): Promise<JitRunner> {
  const response = await fetch(
    `${options.apiBase ?? "https://api.github.com"}${scopePath(scope)}/actions/runners/generate-jitconfig`,
    {
      method: "POST",
      headers: headers(installationToken, options),
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: DEFAULT_RUNNER_GROUP_ID,
        labels,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `generate-jitconfig failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  const body = (await response.json()) as {
    runner: { id: number };
    encoded_jit_config: string;
  };
  return {
    runnerId: body.runner.id,
    encodedJitConfig: body.encoded_jit_config,
  };
}

export async function deleteRunner(
  installationToken: string,
  scope: RunnerScope,
  runnerId: number,
  options: GitHubApiOptions,
): Promise<void> {
  const response = await fetch(
    `${options.apiBase ?? "https://api.github.com"}${scopePath(scope)}/actions/runners/${runnerId}`,
    { method: "DELETE", headers: headers(installationToken, options) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete runner failed: ${response.status}`);
  }
}
