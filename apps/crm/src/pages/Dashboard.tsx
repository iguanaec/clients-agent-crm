import { useEffect, useState } from "react";
import { api, dur, money, pct, type Config, type Dashboard as Data } from "../api";
import { Bars, Card, Empty, Funnel, Kpi, Line, Split } from "../charts";

const RANGES = [7, 30, 90];

/** Horas del día en las que el agente atiende, según la ventana configurada. */
function agentHours(cfg: Config | null): Set<number> {
  let win = { start: "17:00", end: "08:00" };
  try { win = JSON.parse(cfg?.schedule ?? "{}").default?.[0] ?? win; } catch { /* usa el valor por defecto */ }
  const s = Number(win.start.slice(0, 2)), e = Number(win.end.slice(0, 2));
  const out = new Set<number>();
  for (let h = 0; h < 24; h++) if (s < e ? h >= s && h < e : h >= s || h < e) out.add(h);
  return out;
}

export default function Dashboard({ goto }: { goto: (tab: "stock") => void }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Data | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setErr("");
    api<Data>(`/dashboard?days=${days}`).then(setD).catch((e) => setErr(String(e.message ?? e)));
  }, [days]);
  useEffect(() => { api<Config>("/config").then(setCfg).catch(() => setCfg(null)); }, []);

  if (err) return <p className="err pad">No se pudo cargar el resumen: {err}</p>;
  if (!d) return <p className="muted pad">Cargando…</p>;
  const k = d.kpis;
  const botShare = k.conversations ? k.botOnly / k.conversations : 0;
  const hours = agentHours(cfg);
  const dayLabels = d.daily.map((x) => x.date.slice(5));
  const noData = k.conversations === 0;

  return (
    <div className="dash">
      <div className="dash-head">
        <h2>Resumen</h2>
        <div className="seg">{RANGES.map((r) => <button key={r} className={r === days ? "on" : ""} onClick={() => setDays(r)}>{r} días</button>)}</div>
      </div>
      {noData && <p className="note">Todavía no hay conversaciones en este período. Cuando lleguen mensajes, aquí verás qué respondió el agente y cuánto vendió.</p>}

      <div className="kpis">
        <Kpi label="Conversaciones" value={String(k.conversations)} sub={`${k.messagesIn} mensajes recibidos`} />
        <Kpi label="Atendidas solo por el agente" value={pct(botShare)} sub={`${k.botOnly} de ${k.conversations}`} tone={botShare >= 0.5 ? "good" : undefined} />
        <Kpi label="Ventas confirmadas" value={money(k.revenue)} sub={`${k.confirmedOrders} pedidos · ${money(k.pendingRevenue)} por cobrar`} tone="good" />
        <Kpi label="Conversión a pedido" value={pct(k.conversion)} sub={`${k.orders} pedidos de ${k.conversations} chats`} />
        <Kpi label="Ticket promedio" value={money(k.avgTicket)} sub="pedidos confirmados" />
        <Kpi label="Primera respuesta" value={dur(k.firstReplyBotSec)} sub={`agente · equipo: ${dur(k.firstReplyHumanSec)}`} />
      </div>

      <div className="grid2">
        <Card title="Embudo de venta" hint="De cuántos clientes que escribieron, cuántas vieron fotos, pidieron y pagaron.">
          <Funnel steps={d.funnel} />
        </Card>
        <Card title="Quién respondió">
          <Split parts={[
            { label: "Solo el agente", value: k.botOnly, color: "var(--accent)" },
            { label: "Agente y equipo", value: k.mixed, color: "var(--warn)" },
            { label: "Solo el equipo", value: k.humanOnly, color: "var(--muted)" },
          ]} />
          <p className="muted small">El agente envió {k.botMessages} mensajes y el equipo {k.humanMessages}. Derivó {k.derived} chats a una persona.</p>
        </Card>
      </div>

      <div className="grid2">
        <Card title="Conversaciones por día"><Line values={d.daily.map((x) => x.conversations)} labels={dayLabels} /></Card>
        <Card title="Ventas confirmadas por día"><Bars values={d.daily.map((x) => x.revenue)} labels={dayLabels} format={(n) => `$${n}`} /></Card>
      </div>

      <Card title="Cuándo escriben los clientes" hint="Mensajes recibidos por hora (hora del negocio). Las barras fuertes son las horas en que el agente atiende.">
        <Bars values={d.hourly} labels={d.hourly.map((_, h) => `${h}h`)} hot={(h) => hours.has(h)} color="var(--accent)" W={1040} />
        {(() => {
          const total = d.hourly.reduce((a, b) => a + b, 0);
          const covered = d.hourly.reduce((a, n, h) => a + (hours.has(h) ? n : 0), 0);
          return total ? <p className="muted small">{pct(covered / total)} de los mensajes llegan dentro del horario del agente; el resto lo atiende el equipo.</p> : null;
        })()}
      </Card>

      <div className="grid2">
        <Card title="Lo más vendido">
          {d.topSold.length ? <table className="mini"><tbody>{d.topSold.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{p.qty} u.</td><td className="num">{money(p.revenue)}</td></tr>)}</tbody></table>
            : <Empty>Sin pedidos en el período.</Empty>}
        </Card>
        <Card title="Lo más mostrado vs lo vendido" hint="Muestra mucho y vende poco: revisa precio, opciones o fotos.">
          {d.topShown.length ? <table className="mini"><thead><tr><th /><th className="num">Fotos enviadas</th><th className="num">Vendidas</th></tr></thead>
            <tbody>{d.topShown.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{p.shown}</td><td className="num">{p.sold}</td></tr>)}</tbody></table>
            : <Empty>El agente aún no ha enviado fotos.</Empty>}
        </Card>
      </div>

      <div className="grid2">
        <Card title="Lo que piden y no hay" hint="Búsquedas sin resultados: demanda que se pierde por falta de stock o de la opción pedida.">
          {d.unmet.length ? <table className="mini"><tbody>{d.unmet.map((u) => <tr key={u.query}><td>{u.query}</td><td className="num">{u.count} veces</td></tr>)}</tbody></table>
            : <Empty>Todo lo que buscaron tenía stock.</Empty>}
        </Card>
        <Card title="Opciones más buscadas (tallas)">
          {d.sizes.length ? <Bars values={d.sizes.map((s) => s.count)} labels={d.sizes.map((s) => s.size)} /> : <Empty>Sin búsquedas en el período.</Empty>}
        </Card>
      </div>

      <div className="grid3">
        <Card title="Cómo pagan">
          {d.payment.length ? <table className="mini"><tbody>{d.payment.map((p) => <tr key={p.method}><td>{p.method}</td><td className="num">{p.orders} pedidos</td><td className="num">{money(p.total)}</td></tr>)}</tbody></table> : <Empty>Sin pedidos.</Empty>}
        </Card>
        <Card title="Desde anuncios">
          <p className="big">{k.fromAds}</p>
          <p className="muted small">chats llegaron desde anuncios Click-to-WhatsApp y {k.ordersFromAds} terminaron en pedido.</p>
        </Card>
        <Card title="Alertas de stock">
          <ul className="alerts">
            <li><strong>{d.stock.out}</strong> opciones agotadas</li>
            <li><strong>{d.stock.low}</strong> con 1–2 unidades</li>
            <li><strong>{d.stock.hidden}</strong> productos ocultos al agente</li>
          </ul>
          <button onClick={() => goto("stock")}>Gestionar stock</button>
        </Card>
      </div>
    </div>
  );
}
