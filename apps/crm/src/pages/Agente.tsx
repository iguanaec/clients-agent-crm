import { useEffect, useState } from "react";
import { api, ApiError, biz, type Config, type Me } from "../api";

type Win = { start: string; end: string };
const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const SHIPPING_EC = {
  freeZones: ["quito", "cumbaya", "tumbaco"], freePrice: 0,
  pichinchaZones: ["cayambe", "machachi", "mejia"], pichinchaPrice: 3.5, nationalPrice: 6,
};

export default function Agente({ me }: { me: Me }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [name, setName] = useState(me.tenant.name);
  const [win, setWin] = useState<Win>({ start: "00:00", end: "00:00" });
  const [shipping, setShipping] = useState("");
  const [whitelist, setWhitelist] = useState("");
  const [msg, setMsg] = useState("");
  const owner = me.user.role === "owner";

  useEffect(() => {
    api<Config>("/config").then((c) => {
      setCfg(c);
      setWin(JSON.parse(c.schedule || "{}").default?.[0] ?? { start: "00:00", end: "00:00" });
      setShipping(JSON.stringify(JSON.parse(c.shipping || "{}"), null, 2));
      setWhitelist((JSON.parse(c.test_whitelist || "[]") as string[]).join(", "));
    });
  }, []);

  if (!cfg) return <p className="muted pad">Cargando…</p>;
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg({ ...cfg, [k]: v });
  const allDay = win.start === win.end;

  const save = async () => {
    try { JSON.parse(shipping); } catch { return setMsg("El JSON de envíos no es válido."); }
    try {
      await api("/config", {
        method: "PUT",
        body: JSON.stringify({
          business_name: name,
          enabled: cfg.enabled, test_mode: cfg.test_mode, timezone: cfg.timezone, currency: cfg.currency,
          schedule: { default: [win] }, shipping: JSON.parse(shipping),
          test_whitelist: whitelist.split(",").map((s) => s.trim().replace(/\D/g, "")).filter(Boolean),
          notify_phone: cfg.notify_phone, bank_details: cfg.bank_details, card_instructions: cfg.card_instructions, policies: cfg.policies,
          brand_prompt: cfg.brand_prompt, human_pause_minutes: cfg.human_pause_minutes, age_size_map: cfg.age_size_map, model: cfg.model,
        }),
      });
      biz.timezone = cfg.timezone; biz.currency = cfg.currency;
      setMsg("Guardado ✓");
    } catch (e) {
      setMsg(e instanceof ApiError && e.code === "bad_timezone" ? "Zona horaria no válida (ej. America/Bogota)." : "No se pudo guardar.");
    }
    setTimeout(() => setMsg(""), 3500);
  };

  return (
    <div className="form">
      <h2>Agente</h2>
      {!owner && <p className="note">Solo el dueño de la cuenta puede cambiar esta configuración.</p>}
      <fieldset disabled={!owner}>
        <label>Nombre del negocio (así se presenta el agente)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={!!cfg.enabled} onChange={(e) => set("enabled", e.target.checked ? 1 : 0)} /> Agente encendido</label>
        <label className="check"><input type="checkbox" checked={!!cfg.test_mode} onChange={(e) => set("test_mode", e.target.checked ? 1 : 0)} /> Modo prueba (solo responde a la lista blanca)</label>
        <label>Lista blanca (números con código de país, separados por coma)<input value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="593999999999, ..." /></label>

        <h3>Horario activo</h3>
        <div className="row">
          <label>Desde<input type="time" value={win.start} onChange={(e) => setWin({ ...win, start: e.target.value })} /></label>
          <label>Hasta<input type="time" value={win.end} onChange={(e) => setWin({ ...win, end: e.target.value })} /></label>
          <label>Zona horaria<input value={cfg.timezone} onChange={(e) => set("timezone", e.target.value)} placeholder="America/Guayaquil" /></label>
        </div>
        <p className="muted">
          {allDay ? "Desde = Hasta significa todo el día. " : ""}Si "Hasta" es menor que "Desde" cruza la medianoche (17:00 → 08:00). Aplica todos los días ({DAYS.join(", ")}).
        </p>

        <h3>Ventas</h3>
        <div className="row">
          <label>Moneda (código)<input value={cfg.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></label>
          <label>Pausa del bot tras responder el equipo (min)<input type="number" value={cfg.human_pause_minutes} onChange={(e) => set("human_pause_minutes", Number(e.target.value))} /></label>
        </div>
        <label>Número que recibe avisos (con código de país)<input value={cfg.notify_phone ?? ""} onChange={(e) => set("notify_phone", e.target.value)} /></label>
        <label>Datos bancarios para transferencia (vacío = el agente no ofrece transferencia)<textarea rows={3} value={cfg.bank_details} onChange={(e) => set("bank_details", e.target.value)} /></label>
        <label>Pago con tarjeta: link o indicaciones (se usa si ningún plugin genera el link de pago; vacío = no se ofrece)<textarea rows={2} value={cfg.card_instructions} onChange={(e) => set("card_instructions", e.target.value)} placeholder="Paga aquí: https://..." /></label>
        <label>Políticas (cambios, devoluciones, envíos)<textarea rows={4} value={cfg.policies} onChange={(e) => set("policies", e.target.value)} /></label>
        <label>Instrucciones extra de marca / tono<textarea rows={3} value={cfg.brand_prompt} onChange={(e) => set("brand_prompt", e.target.value)} placeholder='Ej: Trata de "usted", mensajes cortos y cálidos, un solo emoji.' /></label>
        <label className="check"><input type="checkbox" checked={!!cfg.age_size_map} onChange={(e) => set("age_size_map", e.target.checked ? 1 : 0)} /> Traducir edades a tallas de ropa infantil ("8 años" → talla 8, "6 meses" → 6M)</label>

        <h3>Envíos</h3>
        <label>Tarifas y sectores de envío (JSON)<textarea className="mono" rows={9} value={shipping} onChange={(e) => setShipping(e.target.value)} /></label>
        <button className="link" onClick={() => setShipping(JSON.stringify(SHIPPING_EC, null, 2))}>Usar plantilla de ejemplo (Quito / Pichincha / nacional)</button>
        <label>Modelo de IA<input value={cfg.model} onChange={(e) => set("model", e.target.value)} /></label>
      </fieldset>

      <div className="row"><button className="primary" onClick={save} disabled={!owner}>Guardar</button><span className="ok">{msg}</span></div>
    </div>
  );
}
