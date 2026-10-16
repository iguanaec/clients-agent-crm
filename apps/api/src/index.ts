import { Hono } from "hono";
import { api } from "./api";
import { DEFAULT_SCHEDULE, isAgentActive, type Schedule } from "./agent/schedule";
import type { Env } from "./env";
import { safeEqual } from "./lib/safe";
import { syncTenant } from "./services/sync";
import { tenantWa, type TenantRow } from "./services/tenant";
import { sendTemplate } from "./whatsapp/client";
import { verifySignature } from "./whatsapp/signature";
import { handleWebhook } from "./whatsapp/webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

// ---- Meta: verificación y mensajes (una app de Meta para todos los tenants; cada mensaje trae su phone_number_id) ----
app.get("/webhook/whatsapp", (c) => {
  const q = c.req.query();
  if (q["hub.mode"] === "subscribe" && safeEqual(q["hub.verify_token"], c.env.WA_VERIFY_TOKEN)) return c.text(q["hub.challenge"]);
  return c.text("forbidden", 403);
});

app.post("/webhook/whatsapp", async (c) => {
  const raw = await c.req.text();
  if (!(await verifySignature(raw, c.req.header("x-hub-signature-256") ?? null, c.env.WA_APP_SECRET))) {
    return c.text("bad signature", 401);
  }
  c.executionCtx.waitUntil(handleWebhook(c.env, JSON.parse(raw), new URL(c.req.url).origin));
  return c.text("ok"); // Meta exige respuesta rápida
});

/** Fotos de catálogo en JPG, públicas para que Meta las descargue. Solo el prefijo products/ (nunca comprobantes). */
app.get("/media/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/media\//, ""));
  if (!key.includes("/products/")) return c.text("not found", 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
});

// ---- API del CRM (sesión de usuario) ----
app.route("/api", api);

// ---- Cron cada 15 min: plugins (catálogo y estado de pedidos) y resumen de handoff al cerrar la ventana ----
async function scheduled(env: Env) {
  const { results: tenants } = await env.DB.prepare(
    "SELECT t.id, t.wa_phone_number_id, t.wa_access_token, c.timezone, c.schedule, c.notify_phone, c.enabled FROM tenants t JOIN agent_config c ON c.tenant_id = t.id",
  ).all<Pick<TenantRow, "id" | "wa_phone_number_id" | "wa_access_token" | "timezone" | "schedule" | "notify_phone" | "enabled">>();

  for (const t of tenants) {
    try { await syncTenant(env, t.id); } catch (e) { console.error("sync", t.id, e); }

    const schedule: Schedule = JSON.parse(t.schedule || "null") ?? DEFAULT_SCHEDULE;
    const wa = await tenantWa(env, t as TenantRow);
    if (!wa || !t.enabled || !t.notify_phone || isAgentActive(schedule, t.timezone, new Date())) continue;

    // Ventana cerrada: avisar de chats atendidos por el bot que quedaron abiertos.
    const { results } = await env.DB.prepare(
      `SELECT v.id, k.wa_id, k.name,
              (SELECT body FROM messages WHERE conversation_id = v.id AND author = 'cliente' ORDER BY id DESC LIMIT 1) AS last_client
         FROM conversations v JOIN contacts k ON k.id = v.contact_id
        WHERE v.tenant_id = ? AND v.state = 'bot' AND v.handoff_sent = 0
          AND v.last_message_at > datetime('now', '-16 hours')
          AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = v.id AND author = 'bot')`,
    ).bind(t.id).all<{ id: number; wa_id: string; name: string | null; last_client: string | null }>();
    for (const r of results) {
      await sendTemplate(wa, t.notify_phone, "handoff_cliente", [r.name ?? r.wa_id, (r.last_client ?? "").slice(0, 120)]);
      await env.DB.prepare("UPDATE conversations SET handoff_sent = 1 WHERE id = ?").bind(r.id).run();
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(scheduled(env)),
};
