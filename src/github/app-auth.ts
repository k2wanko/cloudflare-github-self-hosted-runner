const PKCS8_RSA_HEADER = Uint8Array.from([
  0x30, 0x82, 0x00, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86,
  0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x82, 0x00, 0x00,
]);

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/-----(BEGIN|END)[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function writeLength(bytes: Uint8Array, offset: number, length: number): void {
  bytes[offset] = (length >> 8) & 0xff;
  bytes[offset + 1] = length & 0xff;
}

export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const pkcs8 = new Uint8Array(PKCS8_RSA_HEADER.length + pkcs1.length);
  pkcs8.set(PKCS8_RSA_HEADER);
  pkcs8.set(pkcs1, PKCS8_RSA_HEADER.length);
  writeLength(pkcs8, 2, pkcs8.length - 4);
  writeLength(pkcs8, PKCS8_RSA_HEADER.length - 2, pkcs1.length);
  return pkcs8;
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemBody(pem);
  const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function createAppJwt(
  appId: number | string,
  pem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = textToBase64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: String(appId),
    }),
  );
  const key = await importAppPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface GitHubApiOptions {
  apiBase?: string;
  userAgent: string;
}

export async function getInstallationToken(
  appJwt: string,
  installationId: number,
  options: GitHubApiOptions,
): Promise<string> {
  const response = await fetch(
    `${options.apiBase ?? "https://api.github.com"}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": options.userAgent,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`installation token request failed: ${response.status}`);
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}
