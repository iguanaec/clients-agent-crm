import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { completeEmbeddedSignup, embeddedAvailable } from "../src/whatsapp/embedded";

const env = { META_APP_ID: "APP1", META_CONFIG_ID: "CFG1", WA_APP_SECRET: "sec" } as Env;
afterEach(() => vi.unstubAllGlobals());

describe("Embedded Signup (coexistencia)", () => {
  it("solo está disponible con app id, config id y secreto", () => {
    expect(embeddedAvailable(env)).toBe(true);
    expect(embeddedAvailable({ ...env, META_CONFIG_ID: "" } as Env)).toBe(false);
    expect(embeddedAvailable({ ...env, WA_APP_SECRET: "" } as Env)).toBe(false);
  });

  it("canjea el código, suscribe la app a la WABA y lee el número", async () => {
    const calls: { url: string; method: string; auth?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string> | undefined)?.Authorization });
      if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "TOK" }));
      if (url.includes("/subscribed_apps")) return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify({ display_phone_number: "+593 99 111 2222", verified_name: "Boutique" }));
    }));
    const r = await completeEmbeddedSignup(env, { code: "CODE", phoneNumberId: "111", wabaId: "222" });
    expect(r).toEqual({ token: "TOK", phoneNumberId: "111", displayPhone: "+593 99 111 2222", verifiedName: "Boutique" });
    expect(calls[0].url).toContain("client_id=APP1");
    expect(calls[0].url).toContain("client_secret=sec");
    expect(calls[0].url).toContain("code=CODE");
    expect(calls[1]).toMatchObject({ method: "POST", auth: "Bearer TOK" });
    expect(calls[1].url).toContain("/222/subscribed_apps");
    expect(calls[2].url).toContain("/111?fields=");
  });

  it("si el navegador no entrega el phone_number_id lo toma de la WABA (un solo número)", async () => {
    const mk = (n: number) => vi.fn(async (u: string) =>
      u.includes("oauth") ? new Response(JSON.stringify({ access_token: "T" }))
        : u.includes("subscribed_apps") ? new Response("{}")
          : new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ id: `90${i}`, display_phone_number: "+593 1", verified_name: "B" })) })));
    vi.stubGlobal("fetch", mk(1));
    expect(await completeEmbeddedSignup(env, { code: "c", wabaId: "2" })).toMatchObject({ phoneNumberId: "900", displayPhone: "+593 1" });
    vi.stubGlobal("fetch", mk(2));
    await expect(completeEmbeddedSignup(env, { code: "c", wabaId: "2" })).rejects.toThrow(/varios números/);
  });

  it("explica el fallo si Meta rechaza el código o la suscripción", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    await expect(completeEmbeddedSignup(env, { code: "x", phoneNumberId: "1", wabaId: "2" })).rejects.toThrow(/código de autorización/);
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("oauth") ? new Response(JSON.stringify({ access_token: "T" })) : new Response("no", { status: 403 })));
    await expect(completeEmbeddedSignup(env, { code: "x", phoneNumberId: "1", wabaId: "2" })).rejects.toThrow(/suscribir/);
  });

  it("sin configuración de la plataforma lanza un error claro", async () => {
    await expect(completeEmbeddedSignup({} as Env, { code: "x", phoneNumberId: "1", wabaId: "2" })).rejects.toThrow(/no está configurado/);
  });
});
