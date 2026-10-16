import type { CommercePlugin, ExternalOrderInput, PluginCtx, StockResult, StockUpdate } from "../types";
import { getLiveStock, stockBody, wooFetch } from "./client";
import { syncCatalog } from "./sync";

interface WooOrder { id: number; payment_url: string; status: string }

/**
 * Transferencia -> `on-hold` (el equipo confirma manualmente y pasa a processing).
 * Tarjeta -> `pending` + `payment_url` (la página de pago de Woo cobra y descuenta stock).
 */
function createOrder(ctx: PluginCtx, o: ExternalOrderInput) {
  const [first, ...rest] = o.name.trim().split(/\s+/);
  return wooFetch<WooOrder>(ctx, "/orders", {
    method: "POST",
    body: JSON.stringify({
      status: o.method === "transferencia" ? "on-hold" : "pending",
      payment_method: o.method === "transferencia" ? "bacs" : "",
      payment_method_title: o.method === "transferencia" ? "Transferencia (WhatsApp)" : "Tarjeta (WhatsApp)",
      set_paid: false,
      billing: { first_name: first, last_name: rest.join(" "), phone: o.phone, address_1: o.address, city: o.city, country: ctx.config.country || "EC" },
      shipping: { first_name: first, last_name: rest.join(" "), address_1: o.address, city: o.city, country: ctx.config.country || "EC" },
      // En productos simples la variante coincide con el producto -> variation_id 0.
      line_items: o.items.map((i) => ({
        product_id: Number(i.productExternalId),
        variation_id: i.variantExternalId && i.variantExternalId !== i.productExternalId ? Number(i.variantExternalId) : 0,
        quantity: i.quantity,
      })),
      shipping_lines: [{ method_id: "flat_rate", method_title: "Envío", total: o.shippingTotal.toFixed(2) }],
      customer_note: o.note ?? "Pedido creado por agente de WhatsApp",
    }),
  }).then((r) => ({ externalId: String(r.id), paymentUrl: r.payment_url || undefined }));
}

/** Cambia stock en WooCommerce: variaciones en lote por producto; un producto simple con PUT directo. */
async function setStock(ctx: PluginCtx, updates: StockUpdate[]): Promise<StockResult[]> {
  const out: StockResult[] = [];
  const byProduct = new Map<string, StockUpdate[]>();
  for (const u of updates) byProduct.set(u.productExternalId, [...(byProduct.get(u.productExternalId) ?? []), u]);

  for (const [productId, list] of byProduct) {
    const isSimple = (u: StockUpdate) => !u.variantExternalId || u.variantExternalId === productId;
    for (const u of list.filter(isSimple)) {
      try {
        await wooFetch(ctx, `/products/${productId}`, { method: "PUT", body: JSON.stringify(stockBody(u.stock)) });
        out.push({ variantExternalId: u.variantExternalId, ok: true });
      } catch (e) {
        out.push({ variantExternalId: u.variantExternalId, ok: false, error: (e as Error).message.slice(0, 200) });
      }
    }
    const variations = list.filter((u) => !isSimple(u));
    if (!variations.length) continue;
    try {
      const res = await wooFetch<{ update?: { id: number; error?: { message: string } }[] }>(
        ctx, `/products/${productId}/variations/batch`,
        { method: "POST", body: JSON.stringify({ update: variations.map((u) => ({ id: Number(u.variantExternalId), ...stockBody(u.stock) })) }) },
      );
      for (const u of variations) {
        const r = res.update?.find((x) => String(x.id) === u.variantExternalId);
        out.push(r && !r.error ? { variantExternalId: u.variantExternalId, ok: true }
          : { variantExternalId: u.variantExternalId, ok: false, error: r?.error?.message ?? "sin respuesta de Woo" });
      }
    } catch (e) {
      for (const u of variations) out.push({ variantExternalId: u.variantExternalId, ok: false, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

export const woocommerce: CommercePlugin = {
  id: "woocommerce",
  name: "WooCommerce",
  description:
    "Sincroniza catálogo y stock desde tu tienda WooCommerce, crea los pedidos allí (con link de pago para tarjeta) y devuelve el stock a la tienda cuando lo cambias en el CRM.",
  fields: [
    { key: "baseUrl", label: "URL de la tienda", type: "url", required: true, help: "https://mitienda.com" },
    { key: "consumerKey", label: "Consumer key", type: "secret", required: true, help: "WooCommerce → Ajustes → Avanzado → REST API → Añadir clave (lectura/escritura)" },
    { key: "consumerSecret", label: "Consumer secret", type: "secret", required: true },
    { key: "country", label: "País de envío (código ISO, opcional)", type: "text", help: "Por defecto EC" },
  ],

  async test(ctx) {
    const r = await wooFetch<{ id: number }[]>(ctx, "/products?per_page=1&status=publish");
    return r.length ? "Conexión correcta con WooCommerce." : "Conexión correcta, pero la tienda no tiene productos publicados.";
  },

  syncCatalog,
  getLiveStock: (ctx, productId, variantId) => getLiveStock(ctx, productId, variantId),
  setStock,
  createOrder,

  async refreshOrders(ctx, open) {
    const changed: { id: number; status: "confirmado" | "rechazado" }[] = [];
    for (const o of open) {
      try {
        const { status } = await wooFetch<{ status: string }>(ctx, `/orders/${o.externalId}`);
        if (["processing", "completed"].includes(status)) changed.push({ id: o.id, status: "confirmado" });
        else if (["cancelled", "failed", "refunded", "trash"].includes(status)) changed.push({ id: o.id, status: "rechazado" });
      } catch (e) {
        console.warn("woo refreshOrders", o.externalId, e);
      }
    }
    return changed;
  },

  async setOrderStatus(ctx, externalId, status) {
    await wooFetch(ctx, `/orders/${externalId}`, { method: "PUT", body: JSON.stringify({ status: status === "confirmado" ? "processing" : "cancelled" }) });
  },
};
