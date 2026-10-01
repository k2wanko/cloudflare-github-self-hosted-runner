import { DurableObject } from "cloudflare:workers";
import { GITHUB_API, githubHeaders } from "../github/api.ts";
import { isAllowedOwner, type OwnerKind } from "./manifest.ts";

const STATE_TTL_MS = 10 * 60 * 1000;

export const SETUP_INSTANCE = "singleton";

interface AppCredentials {
  appId: number;
  slug: string;
  pem: string;
  webhookSecret: string;
}

interface PendingState {
  ownerKind: OwnerKind;
  expiresAt: number;
}

interface ManifestConversion {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  owner: { login: string };
}

type SetupResult =
  | { ok: true; slug: string }
  | { ok: false; status: number; message: string };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class Setup extends DurableObject {
  async getCredentials(): Promise<AppCredentials | null> {
    return (await this.ctx.storage.get<AppCredentials>("credentials")) ?? null;
  }

  async getSlug(): Promise<string | null> {
    return (await this.getCredentials())?.slug ?? null;
  }

  async begin(ownerKind: OwnerKind): Promise<string> {
    const state = crypto.randomUUID();
    const pending: PendingState = {
      ownerKind,
      expiresAt: Date.now() + STATE_TTL_MS,
    };
    await this.ctx.storage.put(`state:${state}`, pending);
    return state;
  }

  async complete(
    code: string,
    state: string,
    allowedOwners: readonly string[],
  ): Promise<SetupResult> {
    if (await this.getCredentials()) {
      return { ok: false, status: 409, message: "already configured" };
    }

    const key = `state:${state}`;
    const pending = await this.ctx.storage.get<PendingState>(key);
    await this.ctx.storage.delete(key);
    if (!pending || pending.expiresAt < Date.now()) {
      return { ok: false, status: 400, message: "invalid or expired state" };
    }

    const response = await fetch(
      `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
      { method: "POST", headers: githubHeaders() },
    );
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        message: `manifest conversion failed: ${response.status}`,
      };
    }

    const conversion = (await response.json()) as ManifestConversion;
    if (!isAllowedOwner(conversion.owner.login, allowedOwners)) {
      return {
        ok: false,
        status: 403,
        message: `owner ${conversion.owner.login} is not in ALLOWED_OWNERS`,
      };
    }

    await this.ctx.storage.put<AppCredentials>("credentials", {
      appId: conversion.id,
      slug: conversion.slug,
      pem: conversion.pem,
      webhookSecret: conversion.webhook_secret,
    });
    return { ok: true, slug: conversion.slug };
  }

  async reset(token: string): Promise<"reset" | "used"> {
    const hash = await sha256Hex(token);
    const used = await this.ctx.storage.get<string[]>("usedResetTokens");
    if (used?.includes(hash)) {
      return "used";
    }
    await this.ctx.storage.put("usedResetTokens", [...(used ?? []), hash]);
    await this.ctx.storage.delete("credentials");
    return "reset";
  }
}
