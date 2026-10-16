import type { Env } from "../env";
import { logEvent } from "../lib/events";
import { pluginFor } from "../plugins";
import { sendTemplate, type WaAuth } from "../whatsapp/client";
import { sendProductPhotos } from "./photos";
import { searchTerms, variantTokens } from "./search";
import type { ToolDecl } from "./llm";
import { quoteShipping, type ShippingConfig } from "./shipping";
import { candidateSizes } from "./sizes";

export interface ToolCtx {
  env: Env;
  tenantId: string;
  wa: WaAuth;
  mediaBase: string;
  waId: string;
  conversationId: number;
  shipping: ShippingConfig;
  bankDetails: string;
  cardInstructions: string;
  notifyPhone: string | null;
  ageSizeMap: boolean;
  currency: string;
}

export const TOOL_DECLS: ToolDecl[] = [
  {
    name: "buscar_productos",
    description:
      "Busca productos con stock disponible. Devuelve hasta 6 con las opciones (tallas/presentaciones) disponibles y el precio. Usa 'consulta' para lo que pide la persona (tipo de producto, ocasión, nombre).",
    parameters: {
      type: "object",
      properties: {
        consulta: { type: "string", description: 'Texto libre: "vestido de bautizo", "zapatos negros", "crema hidratante"' },
        edad_o_talla: { type: "string", description: 'Talla, edad o presentación. Ej: "8 años", "6 meses", "talla M", "42"' },
        categoria: { type: "string", description: "Categoría si se conoce: niña, niño, hogar..." },
        precio_max: { type: "number" },
      },
    },
  },
  {
    name: "enviar_fotos",
    description: "Envía por WhatsApp las fotos de un producto con su nombre, precio y opciones. Máximo 3 fotos.",
    parameters: {
      type: "object",
      properties: { product_id: { type: "number" } },
      required: ["product_id"],
    },
  },
  {
    name: "cotizar_envio",
    description: "Costo de envío según ciudad o sector de entrega.",
    parameters: { type: "object", properties: { lugar: { type: "string" } }, required: ["lugar"] },
  },
  {
    name: "crear_pedido",
    description:
      "Crea el pedido cuando la persona confirmó productos, talla/opción, datos de entrega y método de pago. Tarjeta devuelve un link o indicaciones de pago; transferencia devuelve datos bancarios.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { product_id: { type: "number" }, talla: { type: "string", description: "Talla u opción tal como la devolvió buscar_productos" }, cantidad: { type: "number" } },
            required: ["product_id", "talla"],
          },
        },
        nombre: { type: "string" },
        direccion: { type: "string" },
        ciudad: { type: "string" },
        metodo: { type: "string", enum: ["tarjeta", "transferencia"] },
      },
      required: ["items", "nombre", "direccion", "ciudad", "metodo"],
    },
  },
  {
    name: "derivar_a_humano",
    description:
      "Pasa la conversación al equipo cuando no sabes algo, hay un reclamo, o la persona pide hablar con alguien.",
    parameters: { type: "object", properties: { motivo: { type: "string" } }, required: ["motivo"] },
  },
];

interface Row {
  id: number;
  name: string;
  sizes: string;
  price: number;
  sale: number | null;
}

export async function buscar(ctx: ToolCtx, a: Record<string, unknown>) {
  const sizeText = a.edad_o_talla ? String(a.edad_o_talla) : "";
  const sizes = !sizeText ? [] : ctx.ageSizeMap ? candidateSizes(sizeText) : variantTokens(sizeText);
  const terms = searchTerms([a.consulta, a.categoria].filter(Boolean).join(" "));
  const max = typeof a.precio_max === "number" ? a.precio_max : 1e9;
  const sizeFilter = sizes.length ? `AND lower(v.size) IN (${sizes.map(() => "?").join(",")})` : "";
  const termFilter = terms.map(() => "AND (lower(p.name) LIKE ? OR lower(coalesce(p.categories,'')) LIKE ? OR lower(coalesce(p.description,'')) LIKE ? OR lower(coalesce(p.sku,'')) LIKE ?)").join(" ");
  const termBinds = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]);

  const { results } = await ctx.env.DB.prepare(
    `SELECT p.id, p.name, group_concat(v.size, ', ') AS sizes, min(v.price) AS price, min(v.sale_price) AS sale
       FROM products p JOIN variants v ON v.product_id = p.id
      WHERE p.tenant_id = ? AND p.agent_visible = 1 AND v.stock > 0 ${sizeFilter} ${termFilter}
        AND coalesce(v.sale_price, v.price) <= ?
      GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 6`,
  ).bind(ctx.tenantId, ...sizes.map((s) => s.toLowerCase()), ...termBinds, max).all<Row>();

  await logEvent(ctx.env, ctx.tenantId, ctx.conversationId, "buscar", {
    consulta: [a.consulta, a.edad_o_talla].filter(Boolean).join(" · ") || null, categoria: a.categoria ?? null, tallas: sizes, resultados: results.length,
  });

  return {
    opciones_buscadas: sizes,
    productos: results.map((r) => ({ product_id: r.id, nombre: r.name, opciones_disponibles: r.sizes, precio: r.sale ?? r.price })),
  };
}

async function fotos(ctx: ToolCtx, a: Record<string, unknown>) {
  const r = await sendProductPhotos(ctx.env, {
    tenantId: ctx.tenantId, wa: ctx.wa, waId: ctx.waId, currency: ctx.currency,
    conversationId: ctx.conversationId, author: "bot", productId: Number(a.product_id), mediaBase: ctx.mediaBase,
  });
  return r.error ? { error: r.error } : { enviadas: r.sent };
}

interface VariantRow {
  id: number; external_id: string | null; stock: number; price: number; sale_price: number | null;
  source: string; p_external: string | null;
}

async function pedido(ctx: ToolCtx, a: Record<string, unknown>) {
  const items = a.items as { product_id: number; talla: string; cantidad?: number }[];
  const method = a.metodo as "tarjeta" | "transferencia";
  if (method === "transferencia" && !ctx.bankDetails.trim()) return { error: "Transferencia no disponible; usa derivar_a_humano." };
  if (!Array.isArray(items) || !items.length) return { error: "Faltan los productos del pedido." };

  const lines: { variant: VariantRow; product_id: number; size: string; qty: number }[] = [];
  let subtotal = 0;

  for (const it of items) {
    const v = await ctx.env.DB.prepare(
      `SELECT v.id, v.external_id, v.stock, v.price, v.sale_price, p.source, p.external_id AS p_external
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE p.id = ? AND p.tenant_id = ? AND lower(v.size) = lower(?)`,
    ).bind(it.product_id, ctx.tenantId, it.talla).first<VariantRow>();
    const qty = Math.max(1, Math.floor(it.cantidad ?? 1));
    if (!v || v.stock < qty) return { error: `Sin stock de ${it.product_id} opción ${it.talla}` };
    // La copia local puede tener atraso: si un plugin lo permite se confirma el stock en vivo.
    const plug = await pluginFor(ctx.env, ctx.tenantId, v.source);
    if (plug?.plugin.getLiveStock) {
      const live = await plug.plugin.getLiveStock(plug.ctx, v.p_external!, v.external_id);
      if (live !== v.stock) await ctx.env.DB.prepare("UPDATE variants SET stock = ? WHERE id = ?").bind(live, v.id).run();
      if (live < qty) return { error: `Esa opción (${it.talla}) se acaba de agotar` };
    }
    subtotal += (v.sale_price ?? v.price) * qty;
    lines.push({ variant: v, product_id: it.product_id, size: it.talla, qty });
  }

  const sources = new Set(lines.map((l) => l.variant.source));
  if (sources.size > 1) return { error: "No se pueden mezclar en un pedido productos de distintos orígenes; usa derivar_a_humano." };
  const source = [...sources][0];

  const ship = quoteShipping(String(a.ciudad), ctx.shipping);
  const total = subtotal + ship.price;
  let externalId: string | null = null;
  let paymentUrl: string | undefined;

  // Se valida el método ANTES de tocar stock o crear nada fuera.
  const plug = await pluginFor(ctx.env, ctx.tenantId, source);
  const canCreateExternal = !!plug?.plugin.createOrder;
  const fallbackCard = ctx.cardInstructions.trim();
  if (method === "tarjeta" && !canCreateExternal && !fallbackCard) {
    return { error: "Pago con tarjeta no disponible; ofrece transferencia o usa derivar_a_humano." };
  }

  if (plug?.plugin.createOrder) {
    const o = await plug.plugin.createOrder(plug.ctx, {
      items: lines.map((l) => ({ productExternalId: l.variant.p_external!, variantExternalId: l.variant.external_id, quantity: l.qty })),
      name: String(a.nombre), phone: ctx.waId, address: String(a.direccion), city: String(a.ciudad),
      shippingTotal: ship.price, method,
    });
    externalId = o.externalId;
    paymentUrl = o.paymentUrl;
  } else {
    // Catálogo propio: se reserva el stock aquí (solo si sigue habiendo); si falta alguna línea se devuelve lo reservado.
    const taken: typeof lines = [];
    for (const l of lines) {
      const r = await ctx.env.DB.prepare("UPDATE variants SET stock = stock - ?1 WHERE id = ?2 AND stock >= ?1").bind(l.qty, l.variant.id).run();
      if (!r.meta.changes) {
        for (const t of taken) await ctx.env.DB.prepare("UPDATE variants SET stock = stock + ? WHERE id = ?").bind(t.qty, t.variant.id).run();
        return { error: `Esa opción (${l.size}) se acaba de agotar` };
      }
      taken.push(l);
    }
  }

  const link = paymentUrl || fallbackCard;

  const ins = await ctx.env.DB.prepare(
    "INSERT INTO orders (tenant_id, conversation_id, source, external_id, payment_url, method, status, total) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(ctx.tenantId, ctx.conversationId, source, externalId, paymentUrl ?? null, method, method === "tarjeta" ? "pendiente_pago" : "por_confirmar", total).run();
  const orderId = Number(ins.meta.last_row_id);
  await ctx.env.DB.batch(lines.map((l) =>
    ctx.env.DB.prepare("INSERT INTO order_items (order_id, product_id, variant_id, size, qty, price) VALUES (?,?,?,?,?,?)")
      .bind(orderId, l.product_id, l.variant.id, l.size, l.qty, l.variant.sale_price ?? l.variant.price)));
  await logEvent(ctx.env, ctx.tenantId, ctx.conversationId, "pedido", { order_id: orderId, external_id: externalId, total, method });

  const ref = externalId ?? `L${orderId}`;
  if (ctx.notifyPhone) {
    const tpl = method === "tarjeta" ? "nuevo_pedido" : "transferencia_por_confirmar";
    await sendTemplate(ctx.wa, ctx.notifyPhone, tpl, [ref, String(a.nombre), total.toFixed(2)]);
  }

  return method === "tarjeta"
    ? (link
      ? { pedido: ref, total, link_de_pago: link, instruccion: "Envía el link o las indicaciones a la persona tal cual." }
      : { pedido: ref, total, instruccion: "El pedido quedó creado pero no hay link de pago: avisa que una persona del equipo le enviará el link y usa derivar_a_humano." })
    : { pedido: ref, total, datos_bancarios: ctx.bankDetails, instruccion: "Pide que envíe el comprobante por este chat; el equipo lo confirmará." };
}

async function derivar(ctx: ToolCtx, a: Record<string, unknown>) {
  await ctx.env.DB.prepare("UPDATE conversations SET state = 'humano' WHERE id = ?").bind(ctx.conversationId).run();
  await logEvent(ctx.env, ctx.tenantId, ctx.conversationId, "derivar", { motivo: String(a.motivo) });
  if (ctx.notifyPhone) {
    await sendTemplate(ctx.wa, ctx.notifyPhone, "handoff_cliente", [ctx.waId, String(a.motivo)]);
  }
  return { ok: true, instruccion: "Avisa a la persona que alguien del equipo le escribirá pronto." };
}

export async function runTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "buscar_productos": return await buscar(ctx, args);
      case "enviar_fotos": return await fotos(ctx, args);
      case "cotizar_envio": return { ...quoteShipping(String(args.lugar), ctx.shipping) };
      case "crear_pedido": return await pedido(ctx, args);
      case "derivar_a_humano": return await derivar(ctx, args);
      default: return { error: `Herramienta desconocida: ${name}` };
    }
  } catch (e) {
    console.error("tool error", name, e);
    return { error: "Error interno; si persiste usa derivar_a_humano." };
  }
}
