import type { PluginCtx } from "../types";

export const baseUrl = (ctx: PluginCtx) => (ctx.config.baseUrl ?? "").replace(/\/+$/, "");

export async function wooFetch<T>(ctx: PluginCtx, path: string, init: RequestInit = {}): Promise<T> {
  const auth = btoa(`${ctx.config.consumerKey}:${ctx.config.consumerSecret}`);
  const res = await fetch(`${baseUrl(ctx)}/wp-json/wc/v3${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface WooStockRow { stock_quantity: number | null; stock_status: string }

export const stockOf = (r: WooStockRow) => (r.stock_status === "instock" ? (r.stock_quantity ?? 1) : 0);

export const stockBody = (stock: number) => ({
  manage_stock: true,
  stock_quantity: stock,
  stock_status: stock > 0 ? "instock" : "outofstock",
});

export async function getLiveStock(ctx: PluginCtx, productId: string, variantId: string | null): Promise<number> {
  const path = variantId && variantId !== productId ? `/products/${productId}/variations/${variantId}` : `/products/${productId}`;
  return stockOf(await wooFetch<WooStockRow>(ctx, path));
}
