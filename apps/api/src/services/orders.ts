import type { Env } from "../env";
import { pluginFor } from "../plugins";

/** Cambia el estado de un pedido del tenant (confirmar / rechazar) y lo propaga al plugin que lo creó. */
export async function resolveOrder(env: Env, tenantId: string, orderId: number, action: "confirm" | "reject") {
  const o = await env.DB.prepare("SELECT id, source, external_id, status FROM orders WHERE id = ? AND tenant_id = ?")
    .bind(orderId, tenantId).first<{ id: number; source: string; external_id: string | null; status: string }>();
  if (!o) return { ok: false as const, status: 404, error: "not_found" };
  if (!["por_confirmar", "pendiente_pago"].includes(o.status)) return { ok: false as const, status: 409, error: "already_resolved" };

  const next = action === "confirm" ? "confirmado" : "rechazado";
  if (o.source !== "manual" && o.external_id) {
    const p = await pluginFor(env, tenantId, o.source);
    if (!p?.plugin.setOrderStatus) return { ok: false as const, status: 502, error: `plugin_${o.source}_unavailable` };
    try { await p.plugin.setOrderStatus(p.ctx, o.external_id, next); } catch (e) {
      return { ok: false as const, status: 502, error: (e as Error).message.slice(0, 200) };
    }
  } else if (action === "reject") {
    // Pedido del catálogo propio: el stock se reservó al crearlo; se devuelve al rechazarlo.
    await env.DB.prepare(
      `UPDATE variants SET stock = stock + (SELECT sum(qty) FROM order_items WHERE order_id = ?1 AND variant_id = variants.id)
        WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1 AND variant_id IS NOT NULL)`,
    ).bind(o.id).run();
  }
  await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(next, o.id).run();
  return { ok: true as const };
}
