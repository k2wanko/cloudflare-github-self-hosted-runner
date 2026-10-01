import { WorkerEntrypoint } from "cloudflare:workers";

interface ControlProps {
  jobId: number;
}

export class Control extends WorkerEntrypoint<Env, ControlProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "POST") {
      const result = await this.ctx.exports.RunnerJob.getByName(
        String(this.ctx.props.jobId),
      ).createSnapshot();
      return Response.json(result.body, { status: result.status });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
