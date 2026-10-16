import { importImageAsJpg } from "../../lib/images";
import type { PluginCtx } from "../types";
import { wooFetch } from "./client";

interface WooProduct {
  id: number;
  sku: string;
  name: string;
  type: "simple" | "variable" | string;
  description: string;
  short_description: string;
  permalink: string;
  categories: { name: string }[];
  images: { src: string }[];
  price: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: number | null;
  stock_status: string;
}

interface WooVariation {
  id: number;
  regular_price: string;
  sale_price: string;
  price: string;
  stock_quantity: number | null;
  stock_status: string;
  attributes: { name: string; option: string }[];
}

const SOURCE = "woocommerce";
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** La variante se nombra con el atributo de talla/tamaño si existe; si no, con todas sus opciones. */
export function variantLabel(attrs: { name: string; option: string }[]): string | null {
  if (!attrs.length) return null;
  const sized = attrs.find((a) => /talla|size|tama[ñn]o/i.test(a.name));
  if (sized?.option) return sized.option;
  return attrs.map((a) => a.option).filter(Boolean).join(" / ") || null;
}

const stockOf = (status: string, qty: number | null) => (status === "instock" ? (qty ?? 1) : 0);

/**
 * Trae el catálogo de WooCommerce al catálogo propio. Es idempotente: upsert por (producto, id externo), así los ids
 * locales (usados por pedidos e historial) no cambian entre sincronizaciones. Lo que ya no existe en Woo queda en stock 0.
 */
export async function syncCatalog(ctx: PluginCtx): Promise<{ products: number; variants: number }> {
  const { env, tenantId } = ctx;
  const run = new Date().toISOString();
  let page = 1, nProducts = 0, nVariants = 0;

  for (;;) {
    const batch = await wooFetch<WooProduct[]>(ctx, `/products?per_page=50&page=${page}&status=publish`);
    if (batch.length === 0) break;

    for (const p of batch) {
      await env.DB.prepare(
        `INSERT INTO products (tenant_id, source, external_id, sku, name, description, categories, url, synced_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,datetime('now'))
         ON CONFLICT(tenant_id, source, external_id) DO UPDATE SET sku=?4, name=?5, description=?6, categories=?7, url=?8, synced_at=?9, updated_at=datetime('now')`,
      ).bind(tenantId, SOURCE, String(p.id), p.sku, p.name, strip(p.short_description || p.description).slice(0, 600),
        p.categories.map((c) => c.name).join(" | "), p.permalink, run).run();
      const row = await env.DB.prepare("SELECT id, images FROM products WHERE tenant_id = ? AND source = ? AND external_id = ?")
        .bind(tenantId, SOURCE, String(p.id)).first<{ id: number; images: string }>();
      const localId = row!.id;

      const keys: string[] = [];
      for (const [i, img] of p.images.slice(0, 4).entries()) {
        const k = await importImageAsJpg(env, tenantId, localId, i, img.src);
        if (k) keys.push(k);
      }
      if (keys.length) await env.DB.prepare("UPDATE products SET images = ? WHERE id = ?").bind(JSON.stringify(keys), localId).run();

      const upsert = (ext: string, label: string, stock: number, price: number, sale: number | null) =>
        env.DB.prepare(
          `INSERT INTO variants (product_id, external_id, size, stock, price, sale_price) VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(product_id, external_id) DO UPDATE SET size=?3, stock=?4, price=?5, sale_price=?6`,
        ).bind(localId, ext, label, stock, price, sale);

      const stmts: D1PreparedStatement[] = [];
      const seen: string[] = [];
      if (p.type === "variable") {
        const vars = await wooFetch<WooVariation[]>(ctx, `/products/${p.id}/variations?per_page=100`);
        for (const v of vars) {
          const label = variantLabel(v.attributes);
          if (!label) continue;
          seen.push(String(v.id));
          stmts.push(upsert(String(v.id), label, stockOf(v.stock_status, v.stock_quantity), Number(v.regular_price || v.price) || 0, v.sale_price ? Number(v.sale_price) : null));
        }
      } else {
        seen.push(String(p.id));
        stmts.push(upsert(String(p.id), "Única", stockOf(p.stock_status, p.stock_quantity), Number(p.regular_price || p.price) || 0, p.sale_price ? Number(p.sale_price) : null));
      }
      nVariants += seen.length;
      // Variantes que Woo ya no devuelve: se agotan en vez de borrarse (los pedidos las referencian).
      stmts.push(env.DB.prepare(
        `UPDATE variants SET stock = 0 WHERE product_id = ? AND external_id IS NOT NULL AND external_id NOT IN (${seen.map(() => "?").join(",") || "NULL"})`,
      ).bind(localId, ...seen));
      await env.DB.batch(stmts);
      nProducts++;
    }
    page++;
  }

  // Productos que dejaron de estar publicados: sin stock para que el agente no los ofrezca.
  await env.DB.prepare(
    `UPDATE variants SET stock = 0 WHERE product_id IN
       (SELECT id FROM products WHERE tenant_id = ?1 AND source = ?2 AND (synced_at IS NULL OR synced_at <> ?3))`,
  ).bind(tenantId, SOURCE, run).run();

  return { products: nProducts, variants: nVariants };
}
