import type { Env } from "../env";
import { activePlugins } from "../plugins";

/** Sincroniza catálogo y estado de pedidos con los plugins activos del tenant; guarda el último resultado. */
export async function syncTenant(env: Env, tenantId: string, only?: string) {
  const out: { plugin: string; products?: number; variants?: number; error?: string }[] = [];
  for (const { plugin, ctx } of await activePlugins(env, tenantId)) {
    if (only && plugin.id !== only) continue;
    let error: string | null = null;
    const r: { plugin: string; products?: number; variants?: number; error?: string } = { plugin: plugin.id };
    try {
      if (plugin.syncCatalog) Object.assign(r, await plugin.syncCatalog(ctx));
      await refreshOrders(env, tenantId, plugin.id);
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
      r.error = error;
      console.error("sync", tenantId, plugin.id, e);
    }
    await env.DB.prepare(
      "UPDATE tenant_plugins SET last_sync_at = datetime('now'), last_error = ? WHERE tenant_id = ? AND plugin_id = ?",
    ).bind(error, tenantId, plugin.id).run();
    out.push(r);
  }
  return out;
}

/** Pedidos abiertos creados por un plugin: pagado -> confirmado, cancelado -> rechazado. */
export async function refreshOrders(env: Env, tenantId: string, pluginId: string): Promise<number> {
  const p = (await activePlugins(env, tenantId)).find((x) => x.plugin.id === pluginId);
  if (!p?.plugin.refreshOrders) return 0;
  const { results } = await env.DB.prepare(
    "SELECT id, external_id FROM orders WHERE tenant_id = ? AND source = ? AND status IN ('pendiente_pago','por_confirmar') AND external_id IS NOT NULL",
  ).bind(tenantId, pluginId).all<{ id: number; external_id: string }>();
  if (!results.length) return 0;
  const changed = await p.plugin.refreshOrders(p.ctx, results.map((r) => ({ id: r.id, externalId: r.external_id })));
  for (const c of changed) await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(c.status, c.id).run();
  return changed.length;
}
