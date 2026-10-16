import type { Env } from "../env";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf: ArrayBuffer | Uint8Array) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

// ---------- Contraseñas (PBKDF2-SHA256; 100 000 es el máximo que admite Workers) ----------
const ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${b64(salt)}$${b64(await pbkdf2(password, salt))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "pbkdf2" || !salt || !hash) return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// ---------- Sesiones: token firmado con HMAC-SHA256 ----------
export interface Session { uid: number; tid: string; exp: number }

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signSession(secret: string, s: Omit<Session, "exp">, ttlSeconds = 30 * 86400, now = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...s, exp: Math.floor(now / 1000) + ttlSeconds })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(secret: string, token: string, now = Date.now()): Promise<Session | null> {
  if (!secret) return null; // sin secreto configurado, todo se rechaza
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig), enc.encode(payload));
    if (!ok) return null;
    const s = JSON.parse(dec.decode(unb64url(payload))) as Session;
    return s.exp * 1000 > now ? s : null;
  } catch {
    return null;
  }
}

// ---------- Secretos en reposo (AES-GCM) ----------
const PREFIX = "enc:";

async function aesKey(env: Pick<Env, "SECRETS_KEY" | "SESSION_SECRET">): Promise<CryptoKey> {
  const material = env.SECRETS_KEY || env.SESSION_SECRET;
  if (!material) throw new Error("Falta SECRETS_KEY o SESSION_SECRET");
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(`secrets:${material}`));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Pick<Env, "SECRETS_KEY" | "SESSION_SECRET">, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain));
  return `${PREFIX}${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(env: Pick<Env, "SECRETS_KEY" | "SESSION_SECRET">, stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, ct] = stored.slice(PREFIX.length).split(".");
  try {
    const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return dec.decode(out);
  } catch {
    return null;
  }
}
