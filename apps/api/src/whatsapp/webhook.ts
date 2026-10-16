import { buildSystemPrompt, respond } from "../agent/agent";
import { DEFAULT_SCHEDULE, isAgentActive, type Schedule } from "../agent/schedule";
import { DEFAULT_SHIPPING, type ShippingConfig } from "../agent/shipping";
import type { Env } from "../env";
import { geminiKey, loadTenantByPhone, tenantWa, type TenantRow } from "../services/tenant";
import { downloadMedia, sendText, type WaAuth } from "./client";

interface WaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  audio?: { id: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  referral?: Record<string, unknown>;
}

interface Echo { id: string; to: string; type: string; text?: { body: string } }

interface ChangeValue {
  metadata: { phone_number_id: string };
  contacts?: { wa_id: string; profile?: { name: string } }[];
  messages?: WaMessage[];
  message_echoes?: Echo[];
}

interface Payload { entry?: { changes?: { field: string; value: ChangeValue }[] }[] }

const sqlTime = (offsetMinutes = 0) =>
  new Date(Date.now() + offsetMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);

async function getConversation(env: Env, tenantId: string, waId: string, name?: string, referral?: unknown) {
  await env.DB.prepare(
    `INSERT INTO contacts (tenant_id, wa_id, name, ad_referral) VALUES (?1,?2,?3,?4)
     ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = coalesce(?3, name), ad_referral = coalesce(ad_referral, ?4)`,
  ).bind(tenantId, waId, name ?? null, referral ? JSON.stringify(referral) : null).run();
  const contact = await env.DB.prepare("SELECT id FROM contacts WHERE tenant_id = ? AND wa_id = ?")
    .bind(tenantId, waId).first<{ id: number }>();

  let conv = await env.DB.prepare(
    "SELECT id, state, bot_paused_until FROM conversations WHERE contact_id = ? AND state != 'cerrada' ORDER BY id DESC LIMIT 1",
  ).bind(contact!.id).first<{ id: number; state: string; bot_paused_until: string | null }>();
  if (!conv) {
    const r = await env.DB.prepare("INSERT INTO conversations (tenant_id, contact_id) VALUES (?,?)").bind(tenantId, contact!.id).run();
    conv = { id: Number(r.meta.last_row_id), state: "bot", bot_paused_until: null };
  }
  return conv;
}

const saveMessage = (env: Env, convId: number, waMsgId: string, dir: "in" | "out", author: string, type: string, body: string | null, mediaKey: string | null = null) =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO messages (conversation_id, wa_message_id, direction, author, type, body, media_key)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(convId, waMsgId, dir, author, type, body, mediaKey).run();

function bodyOf(m: WaMessage): string {
  if (m.text) return m.text.body;
  if (m.image) return m.image.caption ? `[imagen] ${m.image.caption}` : "[imagen]";
  if (m.button) return m.button.text;
  if (m.interactive?.button_reply) return m.interactive.button_reply.title;
  if (m.interactive?.list_reply) return m.interactive.list_reply.title;
  if (m.audio) return "[audio]";
  return `[${m.type}]`;
}

/** ¿Le toca responder al bot en este chat? */
function botShouldReply(tenant: TenantRow, conv: { state: string; bot_paused_until: string | null }, from: string): boolean {
  if (!tenant.enabled) return false;
  if (tenant.test_mode && !(JSON.parse(tenant.test_whitelist || "[]") as string[]).includes(from)) return false;
  if (conv.state !== "bot") return false;
  if (conv.bot_paused_until && conv.bot_paused_until > sqlTime()) return false;
  const schedule: Schedule = JSON.parse(tenant.schedule || "null") ?? DEFAULT_SCHEDULE;
  return isAgentActive(schedule, tenant.timezone, new Date());
}

async function handleIncoming(env: Env, v: ChangeValue, m: WaMessage, mediaBase: string) {
  const tenant = await loadTenantByPhone(env, v.metadata.phone_number_id);
  if (!tenant) return console.warn("tenant desconocido", v.metadata.phone_number_id);
  const wa = await tenantWa(env, tenant);

  const conv = await getConversation(env, tenant.id, m.from, v.contacts?.[0]?.profile?.name, m.referral);

  let mediaKey: string | null = null;
  let image: { mimeType: string; data: string } | undefined;
  if (m.image && wa) {
    const media = await downloadMedia(wa, m.image.id);
    if (media) {
      mediaKey = `${tenant.id}/inbox/${conv.id}-${m.id}`;
      await env.MEDIA.put(mediaKey, media.data, { httpMetadata: { contentType: media.mime } });
      const bytes = new Uint8Array(media.data);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      image = { mimeType: media.mime, data: btoa(bin) };
    }
  }

  const ins = await saveMessage(env, conv.id, m.id, "in", "cliente", m.type, bodyOf(m), mediaKey);
  if (!ins.meta.changes) return; // reenvío duplicado de Meta
  await env.DB.prepare("UPDATE conversations SET last_message_at = datetime('now'), handoff_sent = 0 WHERE id = ?").bind(conv.id).run();

  if (!wa || !botShouldReply(tenant, conv, m.from)) return;

  if (m.type === "audio") {
    // Sin transcripción por ahora: se pide texto en vez de adivinar.
    await sendText(wa, m.from, "Disculpe, por este medio no puedo escuchar audios. ¿Podría escribirme lo que busca?");
    return;
  }

  const key = await geminiKey(env, tenant);
  if (!key) return console.error("tenant sin clave de Gemini", tenant.id);

  const { results } = await env.DB.prepare(
    "SELECT author, body FROM (SELECT id, author, body FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20) ORDER BY id",
  ).bind(conv.id).all<{ author: string; body: string | null }>();

  const shipping: ShippingConfig = JSON.parse(tenant.shipping || "null") ?? DEFAULT_SHIPPING;
  const reply = await respond(
    env,
    {
      env, tenantId: tenant.id, wa, mediaBase, waId: m.from, conversationId: conv.id, shipping,
      bankDetails: tenant.bank_details, cardInstructions: tenant.card_instructions, notifyPhone: tenant.notify_phone,
      ageSizeMap: !!tenant.age_size_map, currency: tenant.currency,
    },
    key,
    tenant.model,
    buildSystemPrompt(tenant.name, tenant.brand_prompt, tenant.policies),
    results,
    image,
  );
  await saveMessage(env, conv.id, `bot-${crypto.randomUUID()}`, "out", "bot", "text", reply);
}

/** Lo que el equipo escribe desde el celular: el bot se pausa en ese chat. */
async function handleEcho(env: Env, v: ChangeValue, e: Echo) {
  const tenant = await loadTenantByPhone(env, v.metadata.phone_number_id);
  if (!tenant) return;
  const conv = await getConversation(env, tenant.id, e.to);
  await saveMessage(env, conv.id, e.id, "out", "app", e.type, e.text?.body ?? `[${e.type}]`);
  await env.DB.prepare("UPDATE conversations SET bot_paused_until = ?, last_message_at = datetime('now') WHERE id = ?")
    .bind(sqlTime(tenant.human_pause_minutes), conv.id).run();
}

export async function handleWebhook(env: Env, payload: Payload, origin: string): Promise<void> {
  const mediaBase = env.MEDIA_PUBLIC_URL ?? `${origin}/media`;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      try {
        if (change.field === "smb_message_echoes") {
          for (const e of v.message_echoes ?? []) await handleEcho(env, v, e);
        } else if (change.field === "messages") {
          for (const m of v.messages ?? []) await handleIncoming(env, v, m, mediaBase);
        }
      } catch (err) {
        console.error("webhook error", change.field, err);
      }
    }
  }
}
