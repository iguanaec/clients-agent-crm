import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";

const GRAPH = "https://graph.facebook.com/v23.0";

/** Credenciales para hablar con la API de WhatsApp en nombre de un tenant. */
export interface WaAuth { phoneNumberId: string; token: string }

/** Token propio del tenant (cifrado en D1) o, si no tiene, el de la plataforma. */
export async function waAuthFor(env: Env, tenant: { wa_phone_number_id: string | null; wa_access_token: string | null }): Promise<WaAuth | null> {
  const token = (await decryptSecret(env, tenant.wa_access_token)) || env.WA_ACCESS_TOKEN;
  return tenant.wa_phone_number_id && token ? { phoneNumberId: tenant.wa_phone_number_id, token } : null;
}

async function call(wa: WaAuth, payload: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${wa.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    console.error("WA send failed", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as { messages?: { id: string }[] };
  return data.messages?.[0]?.id ?? null;
}

export const sendText = (wa: WaAuth, to: string, body: string) =>
  call(wa, { to, type: "text", text: { body, preview_url: true } });

/** `link` debe ser una URL pública jpg/png (WhatsApp no acepta webp como imagen). */
export const sendImage = (wa: WaAuth, to: string, link: string, caption: string) =>
  call(wa, { to, type: "image", image: { link, caption } });

/** Sube una imagen (jpeg/png) a Meta y devuelve su media id. */
export async function uploadMedia(wa: WaAuth, data: ArrayBuffer, mime: string): Promise<string | null> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([data], { type: mime }), mime === "image/png" ? "foto.png" : "foto.jpg");
  const res = await fetch(`${GRAPH}/${wa.phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${wa.token}` }, body: form });
  if (!res.ok) {
    console.error("WA media upload failed", res.status, await res.text());
    return null;
  }
  return ((await res.json()) as { id?: string }).id ?? null;
}

export const sendImageById = (wa: WaAuth, to: string, mediaId: string, caption: string) =>
  call(wa, { to, type: "image", image: { id: mediaId, caption } });

export const sendTemplate = (wa: WaAuth, to: string, name: string, params: string[], language = "es") =>
  call(wa, {
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
    },
  });

/** Descarga un media entrante (comprobante, etc.). */
export async function downloadMedia(wa: WaAuth, mediaId: string): Promise<{ data: ArrayBuffer; mime: string } | null> {
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${wa.token}` } });
  if (!meta.ok) return null;
  const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
  const file = await fetch(url, { headers: { Authorization: `Bearer ${wa.token}` } });
  if (!file.ok) return null;
  return { data: await file.arrayBuffer(), mime: mime_type };
}
