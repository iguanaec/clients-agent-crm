import { safeEqual } from "../lib/safe";

/** Valida `X-Hub-Signature-256: sha256=<hex>` de Meta sobre el body crudo. Sin secreto configurado rechaza todo. */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string | undefined): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(header.slice(7), expected);
}
