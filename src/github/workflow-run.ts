import type { WorkflowRunInfo } from "../snapshot-policy.ts";
import { GITHUB_API, githubHeaders } from "./api.ts";

export async function fetchWorkflowRun(
  token: string,
  repositoryFullName: string,
  runId: number,
  defaultBranch: string,
): Promise<WorkflowRunInfo> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repositoryFullName}/actions/runs/${runId}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(`workflow run lookup failed: ${response.status}`);
  }
  const run = (await response.json()) as {
    event: string;
    head_branch: string | null;
    head_repository: { full_name: string } | null;
  };
  return {
    event: run.event,
    headBranch: run.head_branch,
    headRepositoryFullName: run.head_repository?.full_name ?? null,
    repositoryFullName,
    defaultBranch,
  };
}
