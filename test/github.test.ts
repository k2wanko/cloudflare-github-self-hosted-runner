import { describe, expect, test } from "bun:test";
import {
  createAppJwt,
  importAppPrivateKey,
  pkcs1ToPkcs8,
} from "../src/github/app-auth.ts";
import { verifyWebhookSignature } from "../src/github/webhook-signature.ts";

function toPem(label: string, der: ArrayBuffer | Uint8Array): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const base64 = btoa(String.fromCharCode(...bytes));
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function generateRsa() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function pkcs1FromGeneratedKey(privateKey: CryptoKey) {
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", privateKey),
  );
  return pkcs8.slice(26);
}

describe("app auth", () => {
  test("converts PKCS#1 to a PKCS#8 key that WebCrypto accepts", async () => {
    const pair = await generateRsa();
    const pkcs1 = await pkcs1FromGeneratedKey(pair.privateKey);
    const pem = toPem("RSA PRIVATE KEY", pkcs1);
    await expect(importAppPrivateKey(pem)).resolves.toBeDefined();
    expect(pkcs1ToPkcs8(pkcs1).length).toBeGreaterThan(pkcs1.length);
  });

  test("signs a verifiable RS256 JWT with the app id as issuer", async () => {
    const pair = await generateRsa();
    const pkcs1 = await pkcs1FromGeneratedKey(pair.privateKey);
    const jwt = await createAppJwt(
      12345,
      toPem("RSA PRIVATE KEY", pkcs1),
      1_700_000_000,
    );
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];

    expect(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(header))),
    ).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))),
    ).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "12345",
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });
});

describe("webhook signature", () => {
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const valid =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  test("accepts the documented GitHub test vector", async () => {
    await expect(verifyWebhookSignature(secret, body, valid)).resolves.toBe(
      true,
    );
  });

  test("rejects tampered bodies, wrong secrets and malformed headers", async () => {
    await expect(
      verifyWebhookSignature(secret, `${body}!`, valid),
    ).resolves.toBe(false);
    await expect(verifyWebhookSignature("other", body, valid)).resolves.toBe(
      false,
    );
    await expect(verifyWebhookSignature(secret, body, null)).resolves.toBe(
      false,
    );
    await expect(
      verifyWebhookSignature(secret, body, "sha256=zz"),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature(secret, body, valid.replace("sha256=", "")),
    ).resolves.toBe(false);
  });
});
