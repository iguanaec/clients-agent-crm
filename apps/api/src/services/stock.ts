import type { Env } from "../env";
import { activePlugins } from "../plugins";
import type { StockUpdate } from "../plugins/types";

export interface StockReport { id: number; ok: boolean; error?: string; stock?: number }

interface Row { id: number; product_id: number; external_id: string | null; source: string; p_external: string | null }

/**
 * Cambia el stock de variantes del tenant. Productos del catálogo propio: solo D1. Productos de un plugin: primero
 * el sistema externo (fuente de verdad) y, si lo acepta, la copia local.
 */
export async function applyStock(env: Env, tenantId: string, changes: { variant_id: number; stock: number }[]): Promise<StockReport[]> {
  const ids = changes.map((c) => c.variant_id);
  const { results: rows } = ids.length
    ? await env.DB.prepare(
      `SELECT v.id, v.product_id, v.external_id, p.source, p.external_id AS p_external
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE p.tenant_id = ? AND v.id IN (${ids.map(() => "?").join(",")})`,
    ).bind(tenantId, ...ids).all<Row>()
    : { results: [] as Row[] };

  const wanted = new Map(changes.map((c) => [c.variant_id, Math.max(0, Math.floor(c.stock))]));
  const report: StockReport[] = [];
  const plugins = await activePlugins(env, tenantId);

  const bySource = new Map<string, Row[]>();
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  for (const [source, list] of bySource) {
    const setLocal = (id: number) => env.DB.prepare("UPDATE variants SET stock = ? WHERE id = ?").bind(wanted.get(id)!, id).run();
    if (source === "manual") {
      for (const r of list) { await setLocal(r.id); report.push({ id: r.id, ok: true, stock: wanted.get(r.id) }); }
      continue;
    }
    const p = plugins.find((x) => x.plugin.id === source);
    if (!p?.plugin.setStock) {
      for (const r of list) report.push({ id: r.id, ok: false, error: `El plugin ${source} está desactivado o no permite cambiar stock` });
      continue;
    }
    const updates: StockUpdate[] = list.map((r) => ({ productExternalId: r.p_external!, variantExternalId: r.external_id, stock: wanted.get(r.id)! }));
    const results = await p.plugin.setStock(p.ctx, updates);
    for (const r of list) {
      const res = results.find((x) => x.variantExternalId === r.external_id);
      if (res?.ok) await setLocal(r.id);
      report.push({ id: r.id, ok: !!res?.ok, error: res?.ok ? undefined : (res?.error ?? "sin respuesta"), stock: wanted.get(r.id) });
    }
  }

  const found = new Set(rows.map((r) => r.id));
  for (const c of changes) if (!found.has(c.variant_id)) report.push({ id: c.variant_id, ok: false, error: "variante no encontrada" });
  return report;
}
