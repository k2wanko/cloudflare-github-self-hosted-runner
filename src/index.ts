import {
  buildManifest,
  manifestFormAction,
  parseAllowedOwners,
} from "./setup/manifest.ts";
import {
  configuredPage,
  html,
  installUrl,
  manifestRedirectPage,
  messagePage,
  parseOwnerKind,
  setupWizardPage,
} from "./setup/page.ts";
import { SETUP_INSTANCE } from "./setup/setup-do.ts";
import { handleWebhook } from "./webhook.ts";

export { Control } from "./control.ts";
export { RunnerJob } from "./runner-job.ts";
export { Setup } from "./setup/setup-do.ts";
export { SnapshotRegistry } from "./snapshot-registry.ts";

async function handleSetup(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const setup = ctx.exports.Setup.getByName(SETUP_INSTANCE);

  if (url.pathname === "/setup/reset") {
    const token = env.SETUP_RESET_TOKEN;
    const bearer = request.headers.get("authorization");
    if (request.method !== "POST" || !token || bearer !== `Bearer ${token}`) {
      return new Response("not found", { status: 404 });
    }
    const result = await setup.reset(token);
    return Response.json(
      { result },
      { status: result === "reset" ? 200 : 409 },
    );
  }

  if (await setup.getSlug()) {
    return messagePage("Already configured", "Setup cannot be changed.", 409);
  }

  if (url.pathname === "/setup/start" && request.method === "POST") {
    const form = await request.formData();
    const ownerKind = parseOwnerKind(form.get("kind")?.toString() ?? null);
    const org = form.get("org")?.toString().trim();
    if (ownerKind === "org" && !org) {
      return messagePage(
        "Missing organization",
        "Enter the organization name.",
        400,
      );
    }
    const state = await setup.begin(ownerKind);
    const manifest = buildManifest({
      origin: url.origin,
      appName: `cfrunner-${crypto.randomUUID().slice(0, 8)}`,
      ownerKind,
    });
    return html(
      manifestRedirectPage(
        manifestFormAction(ownerKind, org, state),
        JSON.stringify(manifest),
      ),
    );
  }

  if (url.pathname === "/setup/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return messagePage("Invalid request", "Missing code or state.", 400);
    }
    const result = await setup.complete(
      code,
      state,
      parseAllowedOwners(env.ALLOWED_OWNERS),
    );
    if (!result.ok) {
      return messagePage("Setup failed", result.message, result.status);
    }
    return Response.redirect(installUrl(result.slug), 302);
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }
    if (url.pathname.startsWith("/setup/")) {
      return handleSetup(request, env, ctx);
    }
    if (url.pathname === "/" && request.method === "GET") {
      const slug = await ctx.exports.Setup.getByName(SETUP_INSTANCE).getSlug();
      return html(
        slug ? configuredPage(slug, env.LABEL_PREFIX) : setupWizardPage(),
      );
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
