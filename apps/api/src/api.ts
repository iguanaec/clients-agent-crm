import { Hono } from "hono";
import { cors } from "hono/cors";
import { sendProductPhotos } from "./agent/photos";
import { authRoutes, requireAuth, requireOwner, type AppEnv } from "./auth";
import { computeDashboard } from "./dashboard";
import { encryptSecret, hashPassword } from "./lib/crypto";
import { buildConfig, getPlugin, listForTenant, loadCtx } from "./plugins";
import { resolveOrder } from "./services/orders";
import { applyStock } from "./services/stock";
import { syncTenant } from "./services/sync";
import { loadTenant, tenantWa } from "./services/tenant";
import { sendImageById, sendText, uploadMedia, waAuthFor } from "./whatsapp/client";
import { completeEmbeddedSignup, embeddedAvailable } from "./whatsapp/embedded";

export const api = new Hono<AppEnv>();

api.use("*", cors({ origin: (o) => o, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
api.route("/auth", authRoutes);
api.use("*", requireAuth);

const sqlNow = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
const utc = (s: string) => new Date(s.replace(" ", "T") + "Z").getTime();
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------- Sesión ----------
api.get("/me", async (c) => {
  const a = c.get("auth");
  const t = await loadTenant(c.env, a.tid);
  return c.json({
    user: { id: a.uid, email: a.email, name: a.name, role: a.role },
    tenant: { id: a.tid, name: t?.name, timezone: t?.timezone ?? "UTC", currency: t?.currency ?? "USD" },
  });
});

// ---------- Equipo ----------
api.get("/team", async (c) =>
  c.json((await c.env.DB.prepare("SELECT id, email, name, role, created_at FROM users WHERE tenant_id = ? ORDER BY id").bind(c.get("auth").tid).all()).results));

api.post("/team", requireOwner, async (c) => {
  const b = await c.req.json<{ email?: string; name?: string; password?: string }>();
  const email = (b.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return c.json({ error: "bad_email" }, 400);
  if ((b.password ?? "").length < 8) return c.json({ error: "weak_password" }, 400);
  try {
    await c.env.DB.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (?,?,?,?, 'agent')")
      .bind(c.get("auth").tid, email, b.name?.trim() || null, await hashPassword(b.password!)).run();
  } catch {
    return c.json({ error: "email_taken" }, 409);
  }
  return c.json({ ok: true });
});

api.delete("/team/:id", requireOwner, async (c) => {
  const id = num(c.req.param("id"));
  if (id === c.get("auth").uid) return c.json({ error: "cannot_remove_self" }, 400);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ? AND tenant_id = ?").bind(id, c.get("auth").tid).run();
  return c.json({ ok: true });
});

// ---------- Dashboard ----------
api.get("/dashboard", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
  const t = await loadTenant(c.env, c.get("auth").tid);
  return c.json(await computeDashboard(c.env, c.get("auth").tid, days, t?.timezone ?? "UTC"));
});

// ---------- Chats ----------
interface ConvRow {
  id: number;
  tenant_id: string;
  wa_id: string;
  pause: number;
  currency: string;
  last_in: string | null;
}

/** Conversación DEL TENANT (nunca de otro) + lo necesario para enviar; `last_in` decide si la ventana de 24 h sigue abierta. */
const loadConv = (c: { env: AppEnv["Bindings"]; get: (k: "auth") => { tid: string } }, id: string) =>
  c.env.DB.prepare(
    `SELECT v.id, v.tenant_id, k.wa_id, g.human_pause_minutes AS pause, g.currency,
            (SELECT max(created_at) FROM messages WHERE conversation_id = v.id AND direction = 'in') AS last_in
       FROM conversations v JOIN contacts k ON k.id = v.contact_id JOIN agent_config g ON g.tenant_id = v.tenant_id
      WHERE v.id = ? AND v.tenant_id = ?`,
  ).bind(id, c.get("auth").tid).first<ConvRow>();

const windowOpen = (c: ConvRow) => !!c.last_in && Date.now() - utc(c.last_in) < 24 * 3600_000;

/** Si el equipo escribe desde el CRM, el bot se calla en ese chat (igual que desde el celular). */
const pauseBot = (db: D1Database, c: ConvRow) =>
  db.prepare("UPDATE conversations SET bot_paused_until = ?, last_message_at = datetime('now') WHERE id = ?").bind(sqlNow(c.pause), c.id).run();

api.get("/conversations", async (c) => {
  const q = `%${c.req.query("q") ?? ""}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.state, v.bot_paused_until, v.last_message_at, k.wa_id, k.name,
            (SELECT body FROM messages WHERE conversation_id = v.id ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT type FROM messages WHERE conversation_id = v.id ORDER BY id DESC LIMIT 1) AS last_type,
            (SELECT count(*) FROM messages WHERE conversation_id = v.id AND direction = 'in' AND id > v.last_seen_msg_id) AS unread,
            (SELECT max(created_at) FROM messages WHERE conversation_id = v.id AND direction = 'in') AS last_in
       FROM conversations v JOIN contacts k ON k.id = v.contact_id
      WHERE v.tenant_id = ?1 AND (k.name LIKE ?2 OR k.wa_id LIKE ?2)
      ORDER BY v.last_message_at DESC LIMIT 150`,
  ).bind(c.get("auth").tid, q).all();
  return c.json(results);
});

api.get("/conversations/:id/messages", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT m.* FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.conversation_id = ? AND v.tenant_id = ? ORDER BY m.id",
  ).bind(c.req.param("id"), c.get("auth").tid).all();
  return c.json(results);
});

api.post("/conversations/:id/seen", async (c) => {
  await c.env.DB.prepare(
    "UPDATE conversations SET last_seen_msg_id = (SELECT coalesce(max(id), 0) FROM messages WHERE conversation_id = ?1) WHERE id = ?1 AND tenant_id = ?2",
  ).bind(c.req.param("id"), c.get("auth").tid).run();
  return c.json({ ok: true });
});

api.post("/conversations/:id/state", async (c) => {
  const { state } = await c.req.json<{ state: "bot" | "humano" | "cerrada" }>();
  if (!["bot", "humano", "cerrada"].includes(state)) return c.text("bad state", 400);
  await c.env.DB.prepare("UPDATE conversations SET state = ?, bot_paused_until = NULL WHERE id = ? AND tenant_id = ?")
    .bind(state, c.req.param("id"), c.get("auth").tid).run();
  return c.json({ ok: true });
});

/** Credenciales de WhatsApp del tenant, o null (el CRM lo informa como `whatsapp_not_connected`). */
async function waFor(c: { env: AppEnv["Bindings"]; get: (k: "auth") => { tid: string } }) {
  const t = await loadTenant(c.env, c.get("auth").tid);
  return t ? tenantWa(c.env, t) : null;
}

api.post("/conversations/:id/send", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const conv = await loadConv(c, c.req.param("id"));
  if (!conv) return c.text("not found", 404);
  if (!text?.trim()) return c.json({ error: "empty" }, 400);
  if (!windowOpen(conv)) return c.json({ error: "window_closed" }, 409);
  const wa = await waFor(c);
  if (!wa) return c.json({ error: "whatsapp_not_connected" }, 409);
  const id = await sendText(wa, conv.wa_id, text);
  if (!id) return c.json({ error: "send_failed" }, 502);
  await c.env.DB.prepare("INSERT INTO messages (conversation_id, wa_message_id, direction, author, type, body) VALUES (?,?,?,?,?,?)")
    .bind(conv.id, id, "out", "humano", "text", text).run();
  await pauseBot(c.env.DB, conv);
  return c.json({ ok: true });
});

/** Foto subida desde el CRM (el navegador ya la convierte a JPEG). */
api.post("/conversations/:id/send-image", async (c) => {
  const conv = await loadConv(c, c.req.param("id"));
  if (!conv) return c.text("not found", 404);
  if (!windowOpen(conv)) return c.json({ error: "window_closed" }, 409);
  const wa = await waFor(c);
  if (!wa) return c.json({ error: "whatsapp_not_connected" }, 409);
  const form = await c.req.formData();
  const file = form.get("file") as unknown as File | string | null;
  const caption = String(form.get("caption") ?? "");
  if (!file || typeof file === "string" || !["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    return c.json({ error: "invalid_image" }, 400);
  }
  const data = await file.arrayBuffer();
  const mediaId = await uploadMedia(wa, data, file.type);
  if (!mediaId) return c.json({ error: "upload_failed" }, 502);
  const waId = await sendImageById(wa, conv.wa_id, mediaId, caption);
  if (!waId) return c.json({ error: "send_failed" }, 502);
  const key = `${conv.tenant_id}/outbox/${conv.id}-${crypto.randomUUID()}`;
  await c.env.MEDIA.put(key, data, { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare("INSERT INTO messages (conversation_id, wa_message_id, direction, author, type, body, media_key) VALUES (?,?,?,?,?,?,?)")
    .bind(conv.id, waId, "out", "humano", "image", caption || null, key).run();
  await pauseBot(c.env.DB, conv);
  return c.json({ ok: true });
});

/** Envía las fotos de un producto del catálogo a este chat. */
api.post("/conversations/:id/send-product", async (c) => {
  const { product_id } = await c.req.json<{ product_id: number }>();
  const conv = await loadConv(c, c.req.param("id"));
  if (!conv) return c.text("not found", 404);
  if (!windowOpen(conv)) return c.json({ error: "window_closed" }, 409);
  const wa = await waFor(c);
  if (!wa) return c.json({ error: "whatsapp_not_connected" }, 409);
  const r = await sendProductPhotos(c.env, {
    tenantId: conv.tenant_id, wa, waId: conv.wa_id, conversationId: conv.id, author: "humano", productId: Number(product_id), currency: conv.currency,
    mediaBase: c.env.MEDIA_PUBLIC_URL ?? `${new URL(c.req.url).origin}/media`,
  });
  if (r.error) return c.json({ error: r.error }, 502);
  await pauseBot(c.env.DB, conv);
  return c.json({ ok: true, sent: r.sent });
});

api.get("/quick-replies", async (c) =>
  c.json((await c.env.DB.prepare("SELECT id, title, body FROM quick_replies WHERE tenant_id = ? ORDER BY title").bind(c.get("auth").tid).all()).results));
api.post("/quick-replies", async (c) => {
  const { title, body } = await c.req.json<{ title: string; body: string }>();
  if (!title?.trim() || !body?.trim()) return c.text("bad request", 400);
  await c.env.DB.prepare("INSERT INTO quick_replies (tenant_id, title, body) VALUES (?,?,?)").bind(c.get("auth").tid, title.trim(), body.trim()).run();
  return c.json({ ok: true });
});
api.delete("/quick-replies/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM quick_replies WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), c.get("auth").tid).run();
  return c.json({ ok: true });
});

// ---------- Imágenes privadas (comprobantes, fotos subidas): solo las del propio tenant ----------
api.get("/media/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/media\//, ""));
  if (!key.startsWith(`${c.get("auth").tid}/`)) return c.text("not found", 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream" } });
});

// ---------- Configuración del agente ----------
const CONFIG_FIELDS = ["enabled", "timezone", "schedule", "shipping", "brand_prompt", "policies", "bank_details", "card_instructions", "notify_phone", "test_mode", "test_whitelist", "human_pause_minutes", "age_size_map", "currency", "model"];

api.get("/config", async (c) =>
  c.json(await c.env.DB.prepare("SELECT * FROM agent_config WHERE tenant_id = ?").bind(c.get("auth").tid).first()));

api.put("/config", requireOwner, async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const sets = CONFIG_FIELDS.filter((k) => k in b);
  if (typeof b.timezone === "string") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); } catch { return c.json({ error: "bad_timezone" }, 400); }
  }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE agent_config SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE tenant_id = ?`)
    .bind(...sets.map((k) => (typeof b[k] === "object" && b[k] !== null ? JSON.stringify(b[k]) : b[k])), c.get("auth").tid).run();
  if (typeof b.business_name === "string" && b.business_name.trim()) {
    await c.env.DB.prepare("UPDATE tenants SET name = ? WHERE id = ?").bind(b.business_name.trim(), c.get("auth").tid).run();
  }
  return c.json({ ok: true });
});

// ---------- Conexión de WhatsApp (coexistencia) y claves del tenant ----------
api.get("/connection", async (c) => {
  const t = await loadTenant(c.env, c.get("auth").tid);
  return c.json({
    name: t?.name,
    connected: !!(t?.wa_phone_number_id && (t.wa_access_token || c.env.WA_ACCESS_TOKEN)),
    phone_number_id: t?.wa_phone_number_id ?? "",
    waba_id: t?.wa_waba_id ?? "",
    display_phone: t?.wa_display_phone ?? null,
    verified_name: t?.wa_verified_name ?? null,
    via: t?.wa_connected_via ?? null,
    connected_at: t?.wa_connected_at ?? null,
    agent_enabled: !!t?.enabled,
    embedded: embeddedAvailable(c.env) ? { app_id: c.env.META_APP_ID, config_id: c.env.META_CONFIG_ID } : null,
    has_wa_token: !!t?.wa_access_token, platform_wa_token: !!c.env.WA_ACCESS_TOKEN,
    has_gemini_key: !!t?.gemini_api_key, platform_gemini_key: !!c.env.GEMINI_API_KEY,
    webhook_url: `${new URL(c.req.url).origin}/webhook/whatsapp`,
  });
});

/** Fin del Embedded Signup: el navegador entrega el `code` y los ids; aquí se canjea y se guarda el token cifrado. */
api.post("/connection/embedded", requireOwner, async (c) => {
  const b = await c.req.json<{ code?: string; phone_number_id?: string; waba_id?: string }>();
  if (!b.code || !/^\d{5,25}$/.test(b.waba_id ?? "") || (b.phone_number_id && !/^\d{5,25}$/.test(b.phone_number_id))) return c.json({ error: "bad_request" }, 400);
  let conn;
  try {
    conn = await completeEmbeddedSignup(c.env, { code: b.code, phoneNumberId: b.phone_number_id, wabaId: b.waba_id! });
  } catch (e) {
    return c.json({ error: "meta_error", message: (e as Error).message }, 502);
  }
  try {
    await c.env.DB.prepare(
      `UPDATE tenants SET wa_phone_number_id = ?, wa_waba_id = ?, wa_access_token = ?, wa_display_phone = ?, wa_verified_name = ?,
              wa_connected_via = 'embedded', wa_connected_at = datetime('now') WHERE id = ?`,
    ).bind(conn.phoneNumberId, b.waba_id, await encryptSecret(c.env, conn.token), conn.displayPhone, conn.verifiedName, c.get("auth").tid).run();
  } catch {
    return c.json({ error: "phone_number_id_in_use" }, 409);
  }
  return c.json({ ok: true, display_phone: conn.displayPhone, verified_name: conn.verifiedName });
});

/** Conexión manual (Phone Number ID + token pegados), alternativa al Embedded Signup. */
api.put("/connection", requireOwner, async (c) => {
  const b = await c.req.json<{ phone_number_id?: string; wa_access_token?: string; gemini_api_key?: string }>();
  const tid = c.get("auth").tid;
  if (typeof b.phone_number_id === "string") {
    const pid = b.phone_number_id.trim();
    if (pid && !/^\d{5,25}$/.test(pid)) return c.json({ error: "bad_phone_number_id" }, 400);
    try {
      await c.env.DB.prepare(
        "UPDATE tenants SET wa_phone_number_id = ?, wa_connected_via = CASE WHEN ? IS NULL THEN NULL ELSE coalesce(wa_connected_via, 'manual') END, wa_connected_at = CASE WHEN ? IS NULL THEN NULL ELSE coalesce(wa_connected_at, datetime('now')) END WHERE id = ?",
      ).bind(pid || null, pid || null, pid || null, tid).run();
    } catch {
      return c.json({ error: "phone_number_id_in_use" }, 409);
    }
  }
  // Los tokens solo se reemplazan si llega un valor; nunca se devuelven.
  if (b.wa_access_token?.trim()) {
    await c.env.DB.prepare("UPDATE tenants SET wa_access_token = ? WHERE id = ?").bind(await encryptSecret(c.env, b.wa_access_token.trim()), tid).run();
  }
  if (b.gemini_api_key?.trim()) {
    await c.env.DB.prepare("UPDATE tenants SET gemini_api_key = ? WHERE id = ?").bind(await encryptSecret(c.env, b.gemini_api_key.trim()), tid).run();
  }
  return c.json({ ok: true });
});

api.delete("/connection", requireOwner, async (c) => {
  await c.env.DB.prepare(
    "UPDATE tenants SET wa_phone_number_id = NULL, wa_waba_id = NULL, wa_access_token = NULL, wa_display_phone = NULL, wa_verified_name = NULL, wa_connected_via = NULL, wa_connected_at = NULL WHERE id = ?",
  ).bind(c.get("auth").tid).run();
  return c.json({ ok: true });
});

api.post("/connection/test", requireOwner, async (c) => {
  const t = await loadTenant(c.env, c.get("auth").tid);
  const wa = t ? await waAuthFor(c.env, t) : null;
  if (!wa) return c.json({ ok: false, message: "WhatsApp no está conectado todavía." });
  const res = await fetch(`https://graph.facebook.com/v23.0/${wa.phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${wa.token}` } });
  if (!res.ok) return c.json({ ok: false, message: `Meta respondió ${res.status}: vuelve a conectar el número o revisa el token.` });
  const d = (await res.json()) as { display_phone_number?: string; verified_name?: string };
  await c.env.DB.prepare("UPDATE tenants SET wa_display_phone = ?, wa_verified_name = ? WHERE id = ?").bind(d.display_phone_number ?? null, d.verified_name ?? null, c.get("auth").tid).run();
  return c.json({ ok: true, message: `Conectado: ${d.verified_name ?? ""} ${d.display_phone_number ?? ""}`.trim() });
});

/** Interruptor rápido del agente (cualquier miembro del equipo): apagado, el CRM sigue recibiendo y mostrando todos los chats. */
api.post("/agent/toggle", async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  await c.env.DB.prepare("UPDATE agent_config SET enabled = ? WHERE tenant_id = ?").bind(enabled ? 1 : 0, c.get("auth").tid).run();
  return c.json({ ok: true, enabled: !!enabled });
});

// ---------- Plugins (ninguno incluido por ahora; ver docs/PLUGINS.md) ----------
api.get("/plugins", async (c) => c.json(await listForTenant(c.env, c.get("auth").tid)));

api.put("/plugins/:id", requireOwner, async (c) => {
  const plugin = getPlugin(c.req.param("id"));
  if (!plugin) return c.json({ error: "unknown_plugin" }, 404);
  const tid = c.get("auth").tid;
  const b = await c.req.json<{ enabled?: boolean; config?: Record<string, string> }>();
  const prev = await c.env.DB.prepare("SELECT config FROM tenant_plugins WHERE tenant_id = ? AND plugin_id = ?").bind(tid, plugin.id).first<{ config: string }>();
  const config = await buildConfig(c.env, plugin, b.config ?? {}, prev ? JSON.parse(prev.config) : {});
  const missing = plugin.fields.filter((f) => f.required && !config[f.key]);
  if (missing.length) return c.json({ error: "missing_fields", fields: missing.map((f) => f.key) }, 400);
  await c.env.DB.prepare(
    `INSERT INTO tenant_plugins (tenant_id, plugin_id, enabled, config) VALUES (?1,?2,?3,?4)
     ON CONFLICT(tenant_id, plugin_id) DO UPDATE SET enabled = ?3, config = ?4`,
  ).bind(tid, plugin.id, b.enabled === false ? 0 : 1, JSON.stringify(config)).run();
  return c.json({ ok: true });
});

api.delete("/plugins/:id", requireOwner, async (c) => {
  await c.env.DB.prepare("DELETE FROM tenant_plugins WHERE tenant_id = ? AND plugin_id = ?").bind(c.get("auth").tid, c.req.param("id")).run();
  return c.json({ ok: true });
});

api.post("/plugins/:id/test", requireOwner, async (c) => {
  const plugin = getPlugin(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT config FROM tenant_plugins WHERE tenant_id = ? AND plugin_id = ?").bind(c.get("auth").tid, c.req.param("id")).first<{ config: string }>();
  if (!plugin?.test || !row) return c.json({ ok: false, message: "Guarda primero las credenciales." });
  try {
    return c.json({ ok: true, message: await plugin.test(await loadCtx(c.env, c.get("auth").tid, row)) });
  } catch (e) {
    return c.json({ ok: false, message: (e as Error).message.slice(0, 300) });
  }
});

api.post("/plugins/:id/sync", requireOwner, async (c) => {
  const r = await syncTenant(c.env, c.get("auth").tid, c.req.param("id"));
  if (!r.length) return c.json({ error: "plugin_not_active" }, 409);
  return r[0].error ? c.json(r[0], 502) : c.json(r[0]);
});

// ---------- Pedidos ----------
api.get("/orders", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, k.name, k.wa_id,
            (SELECT group_concat(p.name || ' (' || oi.size || ' x' || oi.qty || ')', ', ') FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id) AS items,
            (SELECT media_key FROM messages WHERE conversation_id = o.conversation_id AND direction = 'in' AND type = 'image' ORDER BY id DESC LIMIT 1) AS receipt_key
       FROM orders o LEFT JOIN conversations v ON v.id = o.conversation_id LEFT JOIN contacts k ON k.id = v.contact_id
      WHERE o.tenant_id = ? ORDER BY o.id DESC LIMIT 200`,
  ).bind(c.get("auth").tid).all();
  return c.json(results);
});

/** Confirmar o rechazar un pedido (se propaga al plugin que lo creó; en el catálogo propio, rechazar devuelve el stock). */
api.post("/orders/:id/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "confirm" && action !== "reject") return c.text("bad action", 400);
  const r = await resolveOrder(c.env, c.get("auth").tid, num(c.req.param("id")), action);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status as 404 | 409 | 502);
});

// ---------- Catálogo y stock ----------
api.get("/catalog", async (c) => {
  const t = c.get("auth").tid;
  const [products, variants, sold] = await Promise.all([
    c.env.DB.prepare("SELECT id, source, sku, name, description, categories, url, images, agent_visible, updated_at FROM products WHERE tenant_id = ? ORDER BY name").bind(t)
      .all<{ id: number; images: string }>(),
    c.env.DB.prepare("SELECT v.id, v.product_id, v.size, v.stock, v.price, v.sale_price FROM variants v JOIN products p ON p.id = v.product_id WHERE p.tenant_id = ?").bind(t)
      .all<{ product_id: number }>(),
    c.env.DB.prepare(
      `SELECT oi.product_id, sum(oi.qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.tenant_id = ? AND o.status != 'rechazado' AND o.created_at >= datetime('now', '-30 days') GROUP BY oi.product_id`,
    ).bind(t).all<{ product_id: number; qty: number }>(),
  ]);
  const byProduct = new Map<number, unknown[]>();
  for (const v of variants.results) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
  const soldMap = new Map(sold.results.map((s) => [s.product_id, s.qty]));
  return c.json(products.results.map((p) => ({
    ...p, images: undefined, image: (JSON.parse(p.images) as string[])[0] ?? null, image_keys: JSON.parse(p.images) as string[],
    variants: byProduct.get(p.id) ?? [], sold_30d: soldMap.get(p.id) ?? 0,
  })));
});

const ownedProduct = (c: { env: AppEnv["Bindings"]; get: (k: "auth") => { tid: string } }, id: string | number) =>
  c.env.DB.prepare("SELECT id, source, images FROM products WHERE id = ? AND tenant_id = ?").bind(id, c.get("auth").tid).first<{ id: number; source: string; images: string }>();

api.post("/products/:id/visible", async (c) => {
  const { visible } = await c.req.json<{ visible: boolean }>();
  const r = await c.env.DB.prepare("UPDATE products SET agent_visible = ? WHERE id = ? AND tenant_id = ?").bind(visible ? 1 : 0, c.req.param("id"), c.get("auth").tid).run();
  return r.meta.changes ? c.json({ ok: true }) : c.text("not found", 404);
});

interface VariantInput { size?: string; stock?: number; price?: number; sale_price?: number | null }
const cleanVariant = (v: VariantInput) => ({
  size: (v.size ?? "").trim() || "Única",
  stock: Math.max(0, Math.floor(num(v.stock))),
  price: Math.max(0, num(v.price)),
  sale_price: v.sale_price == null || v.sale_price === ("" as unknown) ? null : Math.max(0, num(v.sale_price)),
});

/** Producto del catálogo propio (los de un plugin se editan en su sistema de origen; aquí solo stock y visibilidad). */
api.post("/products", async (c) => {
  const b = await c.req.json<{ name?: string; sku?: string; description?: string; categories?: string; url?: string; variants?: VariantInput[] }>();
  if (!b.name?.trim()) return c.json({ error: "name_required" }, 400);
  const variants = (b.variants?.length ? b.variants : [{ size: "Única", stock: 0, price: 0 }]).map(cleanVariant);
  const ins = await c.env.DB.prepare(
    "INSERT INTO products (tenant_id, source, sku, name, description, categories, url) VALUES (?, 'manual', ?, ?, ?, ?, ?)",
  ).bind(c.get("auth").tid, b.sku?.trim() || null, b.name.trim(), b.description?.trim() || null, b.categories?.trim() || null, b.url?.trim() || null).run();
  const id = Number(ins.meta.last_row_id);
  await c.env.DB.batch(variants.map((v) =>
    c.env.DB.prepare("INSERT INTO variants (product_id, size, stock, price, sale_price) VALUES (?,?,?,?,?)").bind(id, v.size, v.stock, v.price, v.sale_price)));
  return c.json({ ok: true, id });
});

api.put("/products/:id", async (c) => {
  const p = await ownedProduct(c, c.req.param("id"));
  if (!p) return c.text("not found", 404);
  if (p.source !== "manual") return c.json({ error: "managed_by_plugin" }, 409);
  const b = await c.req.json<{ name?: string; sku?: string; description?: string; categories?: string; url?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name_required" }, 400);
  await c.env.DB.prepare("UPDATE products SET name = ?, sku = ?, description = ?, categories = ?, url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(b.name.trim(), b.sku?.trim() || null, b.description?.trim() || null, b.categories?.trim() || null, b.url?.trim() || null, p.id).run();
  return c.json({ ok: true });
});

api.delete("/products/:id", async (c) => {
  const p = await ownedProduct(c, c.req.param("id"));
  if (!p) return c.text("not found", 404);
  if (p.source !== "manual") return c.json({ error: "managed_by_plugin" }, 409);
  const used = await c.env.DB.prepare("SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1").bind(p.id).first();
  if (used) return c.json({ error: "has_orders" }, 409); // el historial de ventas lo referencia: mejor ocultarlo
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM variants WHERE product_id = ?").bind(p.id),
    c.env.DB.prepare("DELETE FROM products WHERE id = ?").bind(p.id),
  ]);
  await Promise.all((JSON.parse(p.images) as string[]).map((k) => c.env.MEDIA.delete(k)));
  return c.json({ ok: true });
});

api.post("/products/:id/variants", async (c) => {
  const p = await ownedProduct(c, c.req.param("id"));
  if (!p) return c.text("not found", 404);
  if (p.source !== "manual") return c.json({ error: "managed_by_plugin" }, 409);
  const v = cleanVariant(await c.req.json<VariantInput>());
  const ins = await c.env.DB.prepare("INSERT INTO variants (product_id, size, stock, price, sale_price) VALUES (?,?,?,?,?)").bind(p.id, v.size, v.stock, v.price, v.sale_price).run();
  return c.json({ ok: true, id: Number(ins.meta.last_row_id) });
});

const ownedVariant = (c: { env: AppEnv["Bindings"]; get: (k: "auth") => { tid: string } }, id: string) =>
  c.env.DB.prepare("SELECT v.id, p.source FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.tenant_id = ?").bind(id, c.get("auth").tid).first<{ id: number; source: string }>();

api.put("/variants/:id", async (c) => {
  const v = await ownedVariant(c, c.req.param("id"));
  if (!v) return c.text("not found", 404);
  if (v.source !== "manual") return c.json({ error: "managed_by_plugin" }, 409);
  const n = cleanVariant(await c.req.json<VariantInput>());
  await c.env.DB.prepare("UPDATE variants SET size = ?, price = ?, sale_price = ? WHERE id = ?").bind(n.size, n.price, n.sale_price, v.id).run();
  return c.json({ ok: true });
});

api.delete("/variants/:id", async (c) => {
  const v = await ownedVariant(c, c.req.param("id"));
  if (!v) return c.text("not found", 404);
  if (v.source !== "manual") return c.json({ error: "managed_by_plugin" }, 409);
  if (await c.env.DB.prepare("SELECT 1 FROM order_items WHERE variant_id = ? LIMIT 1").bind(v.id).first()) return c.json({ error: "has_orders" }, 409);
  await c.env.DB.prepare("DELETE FROM variants WHERE id = ?").bind(v.id).run();
  return c.json({ ok: true });
});

/** Fotos del catálogo propio (el navegador las convierte a JPEG; WhatsApp no acepta webp). */
api.post("/products/:id/photos", async (c) => {
  const p = await ownedProduct(c, c.req.param("id"));
  if (!p) return c.text("not found", 404);
  const keys = JSON.parse(p.images) as string[];
  if (keys.length >= 4) return c.json({ error: "max_photos" }, 409);
  const file = (await c.req.formData()).get("file") as unknown as File | string | null;
  if (!file || typeof file === "string" || !["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) return c.json({ error: "invalid_image" }, 400);
  const key = `${c.get("auth").tid}/products/${p.id}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare("UPDATE products SET images = ? WHERE id = ?").bind(JSON.stringify([...keys, key]), p.id).run();
  return c.json({ ok: true, key });
});

api.delete("/products/:id/photos", async (c) => {
  const p = await ownedProduct(c, c.req.param("id"));
  if (!p) return c.text("not found", 404);
  const { key } = await c.req.json<{ key: string }>();
  const keys = JSON.parse(p.images) as string[];
  if (!keys.includes(key)) return c.text("not found", 404);
  await c.env.DB.prepare("UPDATE products SET images = ? WHERE id = ?").bind(JSON.stringify(keys.filter((k) => k !== key)), p.id).run();
  await c.env.MEDIA.delete(key);
  return c.json({ ok: true });
});

api.put("/variants/:id/stock", async (c) => {
  const { stock } = await c.req.json<{ stock: number }>();
  if (!Number.isFinite(stock)) return c.json({ error: "bad stock" }, 400);
  const [r] = await applyStock(c.env, c.get("auth").tid, [{ variant_id: num(c.req.param("id")), stock }]);
  return r?.ok ? c.json(r) : c.json(r ?? { error: "not found" }, 502);
});

/**
 * Importación masiva (CSV leído en el navegador), en lotes pequeños. Cada fila: {sku, size, stock} actualiza stock;
 * si además trae {name, price} y la variante no existe, se crea en el catálogo propio.
 */
api.post("/stock/import", async (c) => {
  const tid = c.get("auth").tid;
  const rows = (await c.req.json<{ sku: string; size: string; stock: number; name?: string; price?: number; categories?: string }[]>()).slice(0, 40);
  const changes: { variant_id: number; stock: number }[] = [];
  const notFound: string[] = [];
  let created = 0;
  for (const r of rows) {
    const sku = String(r.sku ?? "").trim(), size = String(r.size ?? "").trim() || "Única";
    const stock = Math.max(0, Math.floor(Number(r.stock)));
    if (!sku || !Number.isFinite(stock)) { notFound.push(`${r.sku} ${r.size}`); continue; }
    const v = await c.env.DB.prepare(
      "SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.tenant_id = ? AND lower(p.sku) = lower(?) AND lower(v.size) = lower(?)",
    ).bind(tid, sku, size).first<{ id: number }>();
    if (v) { changes.push({ variant_id: v.id, stock }); continue; }
    if (!r.name?.trim() || !Number.isFinite(Number(r.price))) { notFound.push(`${sku} ${size}`); continue; }
    // Crear: reutiliza el producto manual con ese SKU o lo inicia.
    let p = await c.env.DB.prepare("SELECT id FROM products WHERE tenant_id = ? AND source = 'manual' AND lower(sku) = lower(?)").bind(tid, sku).first<{ id: number }>();
    if (!p) {
      const ins = await c.env.DB.prepare("INSERT INTO products (tenant_id, source, sku, name, categories) VALUES (?, 'manual', ?, ?, ?)")
        .bind(tid, sku, r.name.trim(), r.categories?.trim() || null).run();
      p = { id: Number(ins.meta.last_row_id) };
    }
    await c.env.DB.prepare("INSERT INTO variants (product_id, size, stock, price) VALUES (?,?,?,?)").bind(p.id, size, stock, Math.max(0, Number(r.price))).run();
    created++;
  }
  const report = changes.length ? await applyStock(c.env, tid, changes) : [];
  return c.json({ updated: report.filter((x) => x.ok).length, created, failed: report.filter((x) => !x.ok), notFound });
});
