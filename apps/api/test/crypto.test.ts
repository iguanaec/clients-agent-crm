import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, signSession, verifyPassword, verifySession } from "../src/lib/crypto";

const env = { SESSION_SECRET: "s".repeat(40), SECRETS_KEY: undefined };

describe("contraseñas", () => {
  it("acepta la correcta y rechaza otra; cada hash lleva su sal", async () => {
    const h = await hashPassword("clave-segura-1");
    expect(await verifyPassword("clave-segura-1", h)).toBe(true);
    expect(await verifyPassword("otra-clave", h)).toBe(false);
    expect(await hashPassword("clave-segura-1")).not.toBe(h);
  });
  it("rechaza hashes mal formados", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "md5$a$b")).toBe(false);
  });
});

describe("sesiones", () => {
  it("firma y verifica; rechaza firma alterada, otro secreto y vencidas", async () => {
    const t = await signSession(env.SESSION_SECRET, { uid: 7, tid: "acme" });
    expect(await verifySession(env.SESSION_SECRET, t)).toMatchObject({ uid: 7, tid: "acme" });
    const [p, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ uid: 7, tid: "otro", exp: 9999999999 })).replace(/=+$/, "");
    expect(await verifySession(env.SESSION_SECRET, `${forged}.${sig}`)).toBeNull();
    expect(await verifySession("x".repeat(40), t)).toBeNull();
    expect(await verifySession(env.SESSION_SECRET, `${p}.`)).toBeNull();
    const old = await signSession(env.SESSION_SECRET, { uid: 1, tid: "a" }, 60, Date.now() - 3600_000);
    expect(await verifySession(env.SESSION_SECRET, old)).toBeNull();
  });
  it("sin secreto configurado todo se rechaza", async () => {
    const t = await signSession(env.SESSION_SECRET, { uid: 1, tid: "a" });
    expect(await verifySession("", t)).toBeNull();
  });
});

describe("secretos en reposo", () => {
  it("cifra y descifra; el texto cifrado no contiene el original", async () => {
    const c = await encryptSecret(env, "ck_1234567890");
    expect(c.startsWith("enc:")).toBe(true);
    expect(c).not.toContain("ck_123");
    expect(await decryptSecret(env, c)).toBe("ck_1234567890");
  });
  it("con otra llave no se puede leer", async () => {
    const c = await encryptSecret(env, "secreto");
    expect(await decryptSecret({ SESSION_SECRET: "z".repeat(40), SECRETS_KEY: undefined }, c)).toBeNull();
  });
  it("valores sin prefijo se devuelven tal cual y vacío es null", async () => {
    expect(await decryptSecret(env, "plano")).toBe("plano");
    expect(await decryptSecret(env, null)).toBeNull();
  });
});
