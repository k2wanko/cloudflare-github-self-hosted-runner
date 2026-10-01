export type OwnerKind = "user" | "org";

interface ManifestInput {
  origin: string;
  appName: string;
  ownerKind: OwnerKind;
}

export function buildManifest(input: ManifestInput) {
  const permissions =
    input.ownerKind === "org"
      ? {
          organization_self_hosted_runners: "write",
          actions: "read",
          metadata: "read",
        }
      : { administration: "write", actions: "read", metadata: "read" };

  return {
    name: input.appName,
    url: input.origin,
    hook_attributes: { url: `${input.origin}/webhook`, active: true },
    redirect_url: `${input.origin}/setup/callback`,
    public: false,
    default_events: ["workflow_job"],
    default_permissions: permissions,
  };
}

export function manifestFormAction(
  ownerKind: OwnerKind,
  org: string | undefined,
  state: string,
): string {
  const base =
    ownerKind === "org" && org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

export function isAllowedOwner(
  login: string,
  allowedOwners: readonly string[],
): boolean {
  return allowedOwners.some(
    (allowed) => allowed.toLowerCase() === login.toLowerCase(),
  );
}

export function parseAllowedOwners(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((owner) => owner.trim())
    .filter((owner) => owner.length > 0);
}
