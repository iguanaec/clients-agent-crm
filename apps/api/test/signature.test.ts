import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/whatsapp/signature";

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifySignature", () => {
  it("acepta firma válida y rechaza alterada o ausente", async () => {
    const body = '{"entry":[]}';
    const good = await sign(body, "secret");
    expect(await verifySignature(body, good, "secret")).toBe(true);
    expect(await verifySignature(body + " ", good, "secret")).toBe(false);
    expect(await verifySignature(body, good, "otro")).toBe(false);
    expect(await verifySignature(body, null, "secret")).toBe(false);
  });
});
