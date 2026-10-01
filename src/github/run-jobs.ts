import type { RunJob } from "../orphan.ts";
import { GITHUB_API, githubHeaders } from "./api.ts";

export async function fetchRunJobs(
  token: string,
  repositoryFullName: string,
  runId: number,
  attempt: number,
): Promise<RunJob[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${repositoryFullName}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(`run jobs lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    jobs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      runner_name: string | null;
    }>;
  };
  return body.jobs.map((job) => ({
    id: job.id,
    status: job.status,
    conclusion: job.conclusion,
    runnerName: job.runner_name,
  }));
}
