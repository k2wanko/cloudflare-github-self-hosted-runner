function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signatureHeader?.startsWith(prefix)) {
    return false;
  }
  const expected = hexToBytes(signatureHeader.slice(prefix.length));
  if (!expected) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(body),
  );
}
