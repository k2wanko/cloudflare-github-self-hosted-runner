import { describe, expect, test } from "bun:test";
import {
  buildManifest,
  isAllowedOwner,
  manifestFormAction,
  parseAllowedOwners,
} from "../src/setup/manifest.ts";

describe("manifest", () => {
  const origin = "https://runner.example.com";

  test("org apps get the organization runner permission only", () => {
    const manifest = buildManifest({
      origin,
      appName: "runner",
      ownerKind: "org",
    });
    expect(manifest.default_permissions).toEqual({
      organization_self_hosted_runners: "write",
      actions: "read",
      metadata: "read",
    });
    expect(manifest.hook_attributes.url).toBe(`${origin}/webhook`);
    expect(manifest.redirect_url).toBe(`${origin}/setup/callback`);
    expect(manifest.default_events).toEqual(["workflow_job"]);
    expect(manifest.public).toBe(false);
  });

  test("user apps need repository administration", () => {
    const manifest = buildManifest({
      origin,
      appName: "runner",
      ownerKind: "user",
    });
    expect(manifest.default_permissions).toMatchObject({
      administration: "write",
    });
  });

  test("form action targets the owner and carries the state in the query", () => {
    expect(manifestFormAction("user", undefined, "s 1")).toBe(
      "https://github.com/settings/apps/new?state=s%201",
    );
    expect(manifestFormAction("org", "example-org", "abc")).toBe(
      "https://github.com/organizations/example-org/settings/apps/new?state=abc",
    );
  });

  test("owner allowlist is case-insensitive and ignores blanks", () => {
    const owners = parseAllowedOwners(" Example-Org, ,alice ");
    expect(owners).toEqual(["Example-Org", "alice"]);
    expect(isAllowedOwner("example-org", owners)).toBe(true);
    expect(isAllowedOwner("mallory", owners)).toBe(false);
    expect(parseAllowedOwners(undefined)).toEqual([]);
  });
});
