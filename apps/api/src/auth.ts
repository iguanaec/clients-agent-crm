import { Hono, type MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { hashPassword, signSession, verifyPassword, verifySession } from "./lib/crypto";
import { safeEqual } from "./lib/safe";

export interface Auth { uid: number; tid: string; role: "owner" | "agent"; email: string; name: string | null }
export type AppEnv = { Bindings: Env; Variables: { auth: Auth } };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "negocio";

/** Valida la sesión (Bearer) y confirma que el usuario sigue existiendo; el tenant sale SIEMPRE de aquí, nunca de la URL. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
  const s = await verifySession(c.env.SESSION_SECRET, token);
  if (!s) return c.text("unauthorized", 401);
  const u = await c.env.DB.prepare("SELECT id, tenant_id, email, name, role FROM users WHERE id = ? AND tenant_id = ?")
    .bind(s.uid, s.tid).first<{ id: number; tenant_id: string; email: string; name: string | null; role: "owner" | "agent" }>();
  if (!u) return c.text("unauthorized", 401);
  c.set("auth", { uid: u.id, tid: u.tenant_id, role: u.role, email: u.email, name: u.name });
  await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("auth").role !== "owner") return c.json({ error: "owner_only" }, 403);
  await next();
};

/** Rutas públicas: registro e inicio de sesión. */
export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/config", (c) => c.json({ signup: c.env.ALLOW_SIGNUP !== "false", needsCode: !!c.env.SIGNUP_CODE }));

authRoutes.post("/signup", async (c) => {
  if (c.env.ALLOW_SIGNUP === "false") return c.json({ error: "signup_closed" }, 403);
  const b = await c.req.json<{ business?: string; email?: string; password?: string; name?: string; code?: string }>().catch(() => ({} as Record<string, string>));
  if (c.env.SIGNUP_CODE && !safeEqual(b.code, c.env.SIGNUP_CODE)) return c.json({ error: "bad_code" }, 403);
  const business = (b.business ?? "").trim();
  const email = (b.email ?? "").trim().toLowerCase();
  if (!business || business.length > 80) return c.json({ error: "bad_business" }, 400);
  if (!EMAIL.test(email)) return c.json({ error: "bad_email" }, 400);
  if ((b.password ?? "").length < 8) return c.json({ error: "weak_password" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return c.json({ error: "email_taken" }, 409);

  const tid = `${slug(business)}-${crypto.randomUUID().slice(0, 6)}`;
  const hash = await hashPassword(b.password!);
  const res = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").bind(tid, business),
    // El agente nace APAGADO (enabled=0) y en modo prueba: primero se usa el CRM con el WhatsApp conectado.
    c.env.DB.prepare(
      `INSERT INTO agent_config (tenant_id, schedule, shipping, enabled, test_mode, test_whitelist) VALUES (?, '{"default":[{"start":"00:00","end":"00:00"}]}', ?, 0, 1, '[]')`,
    ).bind(tid, JSON.stringify({ freeZones: [], freePrice: 0, pichinchaZones: [], pichinchaPrice: 0, nationalPrice: 0 })),
    c.env.DB.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (?,?,?,?, 'owner')").bind(tid, email, b.name?.trim() || null, hash),
  ]).catch(() => null);
  if (!res) return c.json({ error: "email_taken" }, 409);
  const uid = Number(res[2].meta.last_row_id);
  return c.json({ token: await signSession(c.env.SESSION_SECRET, { uid, tid }) });
});

authRoutes.post("/login", async (c) => {
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as Record<string, string>));
  const u = await c.env.DB.prepare("SELECT id, tenant_id, password_hash FROM users WHERE email = ?")
    .bind((b.email ?? "").trim().toLowerCase()).first<{ id: number; tenant_id: string; password_hash: string }>();
  // Mismo trabajo y misma respuesta exista o no el correo, para no revelar cuentas.
  const ok = await verifyPassword(b.password ?? "", u?.password_hash ?? "pbkdf2$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!u || !ok) return c.json({ error: "bad_credentials" }, 401);
  return c.json({ token: await signSession(c.env.SESSION_SECRET, { uid: u.id, tid: u.tenant_id }) });
});
