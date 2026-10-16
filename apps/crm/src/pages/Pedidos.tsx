import { useCallback, useEffect, useState } from "react";
import { api, localTime, mediaUrl, money, post, type Order } from "../api";

const STATUS: Record<string, string> = {
  pendiente_pago: "Esperando pago con tarjeta", por_confirmar: "Transferencia por confirmar", confirmado: "Pagado", rechazado: "Cancelado",
};

function Receipt({ k }: { k: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { mediaUrl(k).then(setSrc).catch(() => setSrc("")); }, [k]);
  return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="Comprobante" className="receipt" /></a> : null;
}

export default function Pedidos() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<"pendientes" | "todos">("pendientes");
  const load = useCallback(() => api<Order[]>("/orders").then(setOrders), []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const act = async (id: number, action: "confirm" | "reject") => {
    if (action === "reject" && !confirm("¿Rechazar y cancelar este pedido?")) return;
    try { await post(`/orders/${id}/${action}`); } catch (e) { alert(`No se pudo: ${(e as Error).message}`); }
    load();
  };

  const shown = orders.filter((o) => filter === "todos" || o.status === "por_confirmar" || o.status === "pendiente_pago");
  const toConfirm = orders.filter((o) => o.status === "por_confirmar").length;

  return (
    <div className="form wide">
      <div className="dash-head">
        <h2>Pedidos {toConfirm > 0 && <span className="badge">{toConfirm} por confirmar</span>}</h2>
        <div className="seg">
          <button className={filter === "pendientes" ? "on" : ""} onClick={() => setFilter("pendientes")}>Pendientes</button>
          <button className={filter === "todos" ? "on" : ""} onClick={() => setFilter("todos")}>Todos</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Pago</th><th>Total</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {shown.map((o) => (
            <tr key={o.id}>
              <td>#{o.external_id ?? `L${o.id}`}<br /><small className="muted">{localTime(o.created_at, true)}</small></td>
              <td>{o.name ?? "—"}<br /><small className="muted">{o.wa_id ? `+${o.wa_id}` : ""}</small></td>
              <td className="wrap-cell">{o.items ?? "—"}</td>
              <td>{o.method}{o.receipt_key && o.method === "transferencia" && <div><Receipt k={o.receipt_key} /></div>}</td>
              <td>{money(o.total ?? 0)}</td>
              <td><span className={`pill ${o.status}`}>{STATUS[o.status] ?? o.status}</span></td>
              <td className="nowrap">{o.status === "por_confirmar" && <><button className="primary" onClick={() => act(o.id, "confirm")}>Confirmar pago</button> <button className="danger" onClick={() => act(o.id, "reject")}>Rechazar</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!shown.length && <p className="muted">{filter === "pendientes" ? "No hay pedidos pendientes." : "Sin pedidos todavía."}</p>}
    </div>
  );
}
