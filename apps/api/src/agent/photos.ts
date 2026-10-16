import type { Env } from "../env";
import { logEvent } from "../lib/events";
import { sendImage, type WaAuth } from "../whatsapp/client";

export interface PhotoTarget {
  tenantId: string;
  wa: WaAuth;
  waId: string;
  conversationId: number;
  author: "bot" | "humano";
  productId: number;
  currency: string;
  /** Base pública de las fotos, p. ej. https://pw-agent-api.<cuenta>.workers.dev/media */
  mediaBase: string;
}

/** Envía hasta 3 fotos JPG del producto con nombre, precio y variantes con stock, y las guarda en el chat. */
export async function sendProductPhotos(env: Env, t: PhotoTarget): Promise<{ sent: number; error?: string }> {
  const p = await env.DB.prepare("SELECT name, images FROM products WHERE id = ? AND tenant_id = ?")
    .bind(t.productId, t.tenantId).first<{ name: string; images: string }>();
  if (!p) return { sent: 0, error: "Producto no encontrado" };
  const v = await env.DB.prepare(
    "SELECT group_concat(size, ', ') AS sizes, min(coalesce(sale_price, price)) AS price FROM variants WHERE product_id = ? AND stock > 0",
  ).bind(t.productId).first<{ sizes: string | null; price: number | null }>();

  const keys = (JSON.parse(p.images) as string[]).slice(0, 3);
  if (!keys.length) return { sent: 0, error: "Sin fotos disponibles para este producto" };

  const caption = `${p.name}\n${t.currency === "USD" ? "$" : `${t.currency} `}${(v?.price ?? 0).toFixed(2)} · Opciones: ${v?.sizes ?? "consultar"}`;
  let sent = 0;
  for (const [i, key] of keys.entries()) {
    const cap = i === 0 ? caption : "";
    const waId = await sendImage(t.wa, t.waId, `${t.mediaBase}/${key}`, cap);
    if (!waId) continue;
    sent++;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO messages (conversation_id, wa_message_id, direction, author, type, body, media_key) VALUES (?,?,?,?,?,?,?)",
    ).bind(t.conversationId, waId, "out", t.author, "image", cap || null, key).run();
  }
  await logEvent(env, t.tenantId, t.conversationId, "fotos", { product_id: t.productId, sent, by: t.author });
  return sent ? { sent } : { sent, error: "WhatsApp no aceptó las fotos" };
}
