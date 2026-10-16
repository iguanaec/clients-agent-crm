import type { Env } from "./env";

/** Desfase actual (minutos) de una zona respecto a UTC, p. ej. America/Guayaquil -> -300. */
export function tzOffsetMinutes(timeZone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now);
    const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    return Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

export interface Dashboard {
  days: number;
  kpis: {
    conversations: number;
    botOnly: number;
    mixed: number;
    humanOnly: number;
    derived: number;
    messagesIn: number;
    botMessages: number;
    humanMessages: number;
    orders: number;
    confirmedOrders: number;
    revenue: number;
    pendingRevenue: number;
    conversion: number;
    avgTicket: number;
    firstReplyBotSec: number | null;
    firstReplyHumanSec: number | null;
    fromAds: number;
    ordersFromAds: number;
  };
  funnel: { label: string; value: number }[];
  daily: { date: string; conversations: number; bot: number; human: number; orders: number; revenue: number }[];
  hourly: number[];
  topSold: { name: string; qty: number; revenue: number }[];
  topShown: { name: string; shown: number; sold: number }[];
  unmet: { query: string; count: number }[];
  sizes: { size: string; count: number }[];
  payment: { method: string; orders: number; total: number }[];
  stock: { out: number; low: number; hidden: number };
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function lastDays(n: number, offsetMin: number): string[] {
  const out: string[] = [];
  const base = Date.now() + offsetMin * 60_000; // fecha local del negocio
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export async function computeDashboard(env: Env, tenant: string, days: number, timeZone = "UTC"): Promise<Dashboard> {
  const since = `-${days} days`;
  const offsetMin = tzOffsetMinutes(timeZone);
  const OFFSET = `${offsetMin >= 0 ? "+" : "-"}${Math.abs(offsetMin)} minutes`;
  const db = env.DB;
  const q = <T>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
  const one = <T>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();

  const [perConv, byAuthor, daily, ordersDaily, hourly, firstReply, events, orders, orderItems, payment, derived, ads, stockRow, funnel] =
    await Promise.all([
      q<{ b: number; h: number }>(
        `SELECT sum(m.author='bot') b, sum(m.author IN ('humano','app')) h
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.tenant_id = ?1 AND m.created_at >= datetime('now', ?2) GROUP BY m.conversation_id`, tenant, since),
      q<{ author: string; n: number }>(
        `SELECT m.author, count(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.tenant_id = ?1 AND m.created_at >= datetime('now', ?2) GROUP BY m.author`, tenant, since),
      q<{ d: string; convs: number; bot: number; human: number }>(
        `SELECT date(m.created_at, '${OFFSET}') d,
                count(DISTINCT CASE WHEN m.direction='in' THEN m.conversation_id END) convs,
                sum(m.author='bot') bot, sum(m.author IN ('humano','app')) human
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.tenant_id = ?1 AND m.created_at >= datetime('now', ?2) GROUP BY d`, tenant, since),
      q<{ d: string; n: number; rev: number }>(
        `SELECT date(created_at, '${OFFSET}') d, count(*) n,
                sum(CASE WHEN status='confirmado' THEN total ELSE 0 END) rev
           FROM orders WHERE tenant_id = ?1 AND created_at >= datetime('now', ?2) AND status != 'rechazado' GROUP BY d`, tenant, since),
      q<{ h: number; n: number }>(
        `SELECT cast(strftime('%H', m.created_at, '${OFFSET}') AS integer) h, count(*) n
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.tenant_id = ?1 AND m.direction = 'in' AND m.created_at >= datetime('now', ?2) GROUP BY h`, tenant, since),
      q<{ author: string | null; secs: number | null }>(
        `WITH fi AS (
           SELECT m.conversation_id cid, min(m.created_at) t FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.tenant_id = ?1 AND m.direction = 'in' AND m.created_at >= datetime('now', ?2) GROUP BY m.conversation_id)
         SELECT (SELECT o.author FROM messages o WHERE o.conversation_id = fi.cid AND o.direction = 'out' AND o.created_at >= fi.t ORDER BY o.id LIMIT 1) author,
                (SELECT strftime('%s', o.created_at) FROM messages o WHERE o.conversation_id = fi.cid AND o.direction = 'out' AND o.created_at >= fi.t ORDER BY o.id LIMIT 1)
                  - strftime('%s', fi.t) secs
           FROM fi`, tenant, since),
      q<{ type: string; data: string; conversation_id: number | null }>(
        `SELECT type, data, conversation_id FROM events WHERE tenant_id = ?1 AND created_at >= datetime('now', ?2) AND type IN ('buscar','fotos') LIMIT 5000`, tenant, since),
      q<{ status: string; total: number }>(
        `SELECT status, total FROM orders WHERE tenant_id = ?1 AND created_at >= datetime('now', ?2)`, tenant, since),
      q<{ product_id: number; name: string; qty: number; rev: number }>(
        `SELECT oi.product_id, p.name, sum(oi.qty) qty, sum(oi.qty * oi.price) rev
           FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
          WHERE o.tenant_id = ?1 AND o.created_at >= datetime('now', ?2) AND o.status != 'rechazado'
          GROUP BY oi.product_id ORDER BY qty DESC, rev DESC LIMIT 8`, tenant, since),
      q<{ method: string; n: number; total: number }>(
        `SELECT method, count(*) n, coalesce(sum(total),0) total FROM orders
          WHERE tenant_id = ?1 AND created_at >= datetime('now', ?2) AND status != 'rechazado' GROUP BY method`, tenant, since),
      one<{ n: number }>(`SELECT count(DISTINCT conversation_id) n FROM events WHERE tenant_id = ?1 AND type = 'derivar' AND created_at >= datetime('now', ?2)`, tenant, since),
      one<{ convs: number; orders: number }>(
        `SELECT (SELECT count(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.id = c.contact_id
                  WHERE c.tenant_id = ?1 AND k.ad_referral IS NOT NULL AND m.direction = 'in' AND m.created_at >= datetime('now', ?2)) convs,
                (SELECT count(*) FROM orders o JOIN conversations c ON c.id = o.conversation_id JOIN contacts k ON k.id = c.contact_id
                  WHERE o.tenant_id = ?1 AND k.ad_referral IS NOT NULL AND o.status != 'rechazado' AND o.created_at >= datetime('now', ?2)) orders`, tenant, since),
      one<{ out: number; low: number; hidden: number }>(
        `SELECT (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.tenant_id = ?1 AND v.stock <= 0) out,
                (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.tenant_id = ?1 AND v.stock BETWEEN 1 AND 2) low,
                (SELECT count(*) FROM products WHERE tenant_id = ?1 AND agent_visible = 0) hidden`, tenant),
      one<{ chatted: number; saw: number; ordered: number; paid: number }>(
        `SELECT (SELECT count(DISTINCT m.conversation_id) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.tenant_id = ?1 AND m.direction = 'in' AND m.created_at >= datetime('now', ?2)) chatted,
                (SELECT count(DISTINCT conversation_id) FROM events WHERE tenant_id = ?1 AND type = 'fotos' AND created_at >= datetime('now', ?2)) saw,
                (SELECT count(DISTINCT conversation_id) FROM orders WHERE tenant_id = ?1 AND status != 'rechazado' AND created_at >= datetime('now', ?2)) ordered,
                (SELECT count(DISTINCT conversation_id) FROM orders WHERE tenant_id = ?1 AND status = 'confirmado' AND created_at >= datetime('now', ?2)) paid`, tenant, since),
    ]);

  // Conversaciones por quién respondió
  let botOnly = 0, mixed = 0, humanOnly = 0;
  for (const c of perConv) {
    if (c.b > 0 && c.h === 0) botOnly++;
    else if (c.b > 0) mixed++;
    else if (c.h > 0) humanOnly++;
  }
  const author = (a: string) => byAuthor.find((r) => r.author === a)?.n ?? 0;

  // Series diarias, con ceros en los días sin actividad
  const dmap = new Map(daily.map((r) => [r.d, r]));
  const omap = new Map(ordersDaily.map((r) => [r.d, r]));
  const series = lastDays(days, offsetMin).map((date) => ({
    date,
    conversations: dmap.get(date)?.convs ?? 0,
    bot: dmap.get(date)?.bot ?? 0,
    human: dmap.get(date)?.human ?? 0,
    orders: omap.get(date)?.n ?? 0,
    revenue: omap.get(date)?.rev ?? 0,
  }));

  const hours = Array.from({ length: 24 }, (_, h) => hourly.find((r) => r.h === h)?.n ?? 0);

  const secs = (who: "bot" | "human") =>
    avg(firstReply.filter((r) => r.secs != null && r.secs >= 0 && (who === "bot" ? r.author === "bot" : r.author === "humano" || r.author === "app")).map((r) => r.secs as number));

  // Búsquedas y fotos desde los eventos del agente
  const sizeCount = new Map<string, number>();
  const unmet = new Map<string, number>();
  const shown = new Map<number, number>();
  for (const e of events) {
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(e.data); } catch { continue; }
    if (e.type === "buscar") {
      for (const s of (d.tallas as string[] | undefined) ?? []) sizeCount.set(s, (sizeCount.get(s) ?? 0) + 1);
      if (d.resultados === 0) {
        const label = [d.consulta, d.categoria].filter(Boolean).join(" · ") || "búsqueda sin datos";
        unmet.set(label, (unmet.get(label) ?? 0) + 1);
      }
    } else if (e.type === "fotos" && typeof d.product_id === "number") {
      shown.set(d.product_id, (shown.get(d.product_id) ?? 0) + 1);
    }
  }
  const shownIds = [...shown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const names = shownIds.length
    ? await q<{ id: number; name: string }>(`SELECT id, name FROM products WHERE tenant_id = ? AND id IN (${shownIds.map(() => "?").join(",")})`, tenant, ...shownIds.map(([id]) => id))
    : [];
  const sold = new Map(orderItems.map((o) => [o.product_id, o.qty]));

  const confirmed = orders.filter((o) => o.status === "confirmado");
  const open = orders.filter((o) => o.status === "pendiente_pago" || o.status === "por_confirmar");
  const valid = orders.filter((o) => o.status !== "rechazado");
  const revenue = confirmed.reduce((a, o) => a + (o.total ?? 0), 0);
  const chatted = funnel?.chatted ?? 0;

  return {
    days,
    kpis: {
      conversations: chatted,
      botOnly, mixed, humanOnly,
      derived: derived?.n ?? 0,
      messagesIn: author("cliente"),
      botMessages: author("bot"),
      humanMessages: author("humano") + author("app"),
      orders: valid.length,
      confirmedOrders: confirmed.length,
      revenue,
      pendingRevenue: open.reduce((a, o) => a + (o.total ?? 0), 0),
      conversion: chatted ? valid.length / chatted : 0,
      avgTicket: confirmed.length ? revenue / confirmed.length : 0,
      firstReplyBotSec: secs("bot"),
      firstReplyHumanSec: secs("human"),
      fromAds: ads?.convs ?? 0,
      ordersFromAds: ads?.orders ?? 0,
    },
    funnel: [
      { label: "Escribieron", value: chatted },
      { label: "Vieron fotos", value: funnel?.saw ?? 0 },
      { label: "Hicieron pedido", value: funnel?.ordered ?? 0 },
      { label: "Pago confirmado", value: funnel?.paid ?? 0 },
    ],
    daily: series,
    hourly: hours,
    topSold: orderItems.map((o) => ({ name: o.name, qty: o.qty, revenue: o.rev })),
    topShown: shownIds.map(([id, n]) => ({ name: names.find((x) => x.id === id)?.name ?? `#${id}`, shown: n, sold: sold.get(id) ?? 0 })),
    unmet: [...unmet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([query, count]) => ({ query, count })),
    sizes: [...sizeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([size, count]) => ({ size, count })),
    payment: payment.map((p) => ({ method: p.method, orders: p.n, total: p.total })),
    stock: { out: stockRow?.out ?? 0, low: stockRow?.low ?? 0, hidden: stockRow?.hidden ?? 0 },
  };
}
