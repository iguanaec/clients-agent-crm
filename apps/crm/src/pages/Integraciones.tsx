import { useCallback, useEffect, useState } from "react";
import { api, del, localTime, post, put, type Me, type PluginInfo } from "../api";
import { startEmbeddedSignup } from "../whatsappSignup";

interface Connection {
  name: string; connected: boolean; phone_number_id: string; waba_id: string; display_phone: string | null; verified_name: string | null;
  via: "embedded" | "manual" | null; connected_at: string | null; agent_enabled: boolean;
  embedded: { app_id: string; config_id: string } | null;
  has_wa_token: boolean; platform_wa_token: boolean; has_gemini_key: boolean; platform_gemini_key: boolean; webhook_url: string;
}
interface Member { id: number; email: string; name: string | null; role: "owner" | "agent" }

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <p className={m.ok ? "ok" : "err"}>{m.text}</p> : null;
}

function WhatsApp({ owner, onChange }: { owner: boolean; onChange: () => void }) {
  const [c, setC] = useState<Connection | null>(null);
  const [pid, setPid] = useState("");
  const [token, setToken] = useState("");
  const [gem, setGem] = useState("");
  const [busy, setBusy] = useState(false);
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Connection>("/connection").then((x) => { setC(x); setPid(x.phone_number_id); onChange(); }), [onChange]);
  useEffect(() => { load(); }, [load]);
  if (!c) return null;

  const connect = async () => {
    if (!c.embedded) return;
    setBusy(true); setM(null);
    try {
      const r = await startEmbeddedSignup(c.embedded.app_id, c.embedded.config_id);
      const out = await post<{ display_phone: string | null }>("/connection/embedded", { code: r.code, waba_id: r.waba_id, phone_number_id: r.phone_number_id });
      setM({ ok: true, text: `Conectado ${out.display_phone ?? ""}. Tu app de WhatsApp Business del celular sigue funcionando igual.` });
      load();
    } catch (e) {
      const body = (e as { body?: string }).body;
      let msg = (e as Error).message;
      try { msg = (JSON.parse(body ?? "") as { message?: string; error?: string }).message ?? (JSON.parse(body ?? "") as { error?: string }).error ?? msg; } catch { /* usa el mensaje */ }
      setM({ ok: false, text: msg === "phone_number_id_in_use" ? "Ese número ya está conectado a otra cuenta." : msg });
    }
    setBusy(false);
  };
  const saveManual = async () => {
    try {
      await put("/connection", { phone_number_id: pid, wa_access_token: token, gemini_api_key: gem });
      setToken(""); setGem(""); setM({ ok: true, text: "Guardado ✓" }); load();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setM({ ok: false, text: code === "phone_number_id_in_use" ? "Ese Phone Number ID ya está conectado a otra cuenta." : code === "bad_phone_number_id" ? "El Phone Number ID solo lleva números." : "No se pudo guardar." });
    }
  };
  const test = async () => { const r = await post<{ ok: boolean; message: string }>("/connection/test"); setM({ ok: r.ok, text: r.message }); load(); };
  const disconnect = async () => {
    if (!confirm("¿Desconectar este WhatsApp del CRM? Los chats guardados se conservan; dejarás de recibir mensajes nuevos aquí. Tu app de WhatsApp Business del celular no se ve afectada.")) return;
    await del("/connection"); setM(null); load();
  };

  return (
    <section className="panel">
      <h3>WhatsApp {c.connected && <span className="pill">Conectado</span>}</h3>
      {c.connected ? (
        <p>
          <strong>{c.verified_name ?? c.name}</strong> {c.display_phone && <span className="muted">· {c.display_phone}</span>}<br />
          <span className="muted small">
            {c.via === "embedded" ? "Conectado en coexistencia: los mensajes llegan al CRM y a la app de WhatsApp Business del celular a la vez; lo que escribas desde el celular también aparece en el CRM."
              : "Conexión manual (Phone Number ID y token)."}
            {c.connected_at ? ` Desde ${localTime(c.connected_at, true)}.` : ""}
          </span>
        </p>
      ) : (
        <p className="muted small">Conecta tu número de WhatsApp Business para ver y responder tus chats desde aquí. El agente de IA se activa aparte y puedes apagarlo cuando quieras sin perder los chats.</p>
      )}
      <div className="row tight wrap">
        {c.embedded ? (
          <button className="primary" onClick={connect} disabled={!owner || busy}>{busy ? "Esperando a Meta…" : c.connected ? "Volver a conectar" : "Conectar WhatsApp Business (coexistencia)"}</button>
        ) : (
          !c.connected && <p className="note small">La conexión con un clic todavía no está habilitada en esta plataforma (faltan <code>META_APP_ID</code> y <code>META_CONFIG_ID</code>). Mientras tanto usa la conexión manual de abajo.</p>
        )}
        {c.connected && <button onClick={test} disabled={!owner}>Probar conexión</button>}
        {c.connected && <button className="danger" onClick={disconnect} disabled={!owner}>Desconectar</button>}
      </div>
      <Msg m={m} />

      <details style={{ marginTop: 14 }}>
        <summary className="muted small">Conexión manual y clave de IA</summary>
        <fieldset disabled={!owner}>
          <label>Phone Number ID<input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="1234567890" /></label>
          <label>Token de acceso de WhatsApp {c.has_wa_token ? <span className="ok">· guardado (escribe para reemplazar)</span> : c.platform_wa_token ? <span className="muted">· se usa el de la plataforma</span> : null}
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
          <label>Clave de Gemini propia (opcional) {c.has_gemini_key ? <span className="ok">· guardada</span> : c.platform_gemini_key ? <span className="muted">· se usa la de la plataforma</span> : <span className="err">· falta: el agente no podrá responder</span>}
            <input type="password" autoComplete="off" value={gem} onChange={(e) => setGem(e.target.value)} /></label>
        </fieldset>
        <p className="muted small">Webhook para Meta (lo configura quien administra la plataforma una sola vez): <code>{c.webhook_url}</code> con los campos <code>messages</code> y <code>smb_message_echoes</code>.</p>
        <button className="primary" onClick={saveManual} disabled={!owner}>Guardar</button>
      </details>
    </section>
  );
}

function Plugin({ p, owner, reload }: { p: PluginInfo; owner: boolean; reload: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, f.value])));
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setM(null); try { await fn(); } catch (e) { setM({ ok: false, text: (e as Error).message.slice(0, 300) }); } setBusy(false); };

  const save = (enabled = true) => run(async () => {
    try {
      await put(`/plugins/${p.id}`, { enabled, config: vals });
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new Error(code === "missing_fields" ? "Completa los campos obligatorios." : "No se pudo guardar.");
    }
    setVals((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, p.fields.find((f) => f.key === k)?.type === "secret" ? "" : x])));
    setM({ ok: true, text: "Guardado ✓" }); reload();
  });
  const test = () => run(async () => { const r = await post<{ ok: boolean; message: string }>(`/plugins/${p.id}/test`); setM({ ok: r.ok, text: r.message }); });
  const sync = () => run(async () => {
    try {
      const r = await post<{ products?: number; variants?: number }>(`/plugins/${p.id}/sync`);
      setM({ ok: true, text: `Sincronizado: ${r.products ?? 0} productos, ${r.variants ?? 0} variantes.` });
    } catch (e) { setM({ ok: false, text: `Error al sincronizar: ${(e as Error).message.slice(0, 250)}` }); }
    reload();
  });
  const remove = () => confirm(`¿Desinstalar ${p.name}? El catálogo ya importado se conserva, pero dejará de sincronizarse y de recibir pedidos.`) &&
    run(async () => { await del(`/plugins/${p.id}`); reload(); });

  return (
    <section className="panel">
      <div className="row between">
        <h3>{p.name} <span className="pill">{p.installed ? (p.enabled ? "Activo" : "Pausado") : "No instalado"}</span></h3>
        {p.installed && owner && (
          <label className="check"><input type="checkbox" checked={p.enabled} onChange={(e) => save(e.target.checked)} /> Activado</label>
        )}
      </div>
      <p className="muted small">{p.description}</p>
      <fieldset disabled={!owner}>
        {p.fields.map((f) => (
          <label key={f.key}>{f.label}{f.required ? " *" : ""} {f.type === "secret" && f.has_value ? <span className="ok">· guardado (escribe para reemplazar)</span> : null}
            <input type={f.type === "secret" ? "password" : "text"} autoComplete="off" value={vals[f.key] ?? ""} placeholder={f.help}
              onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            {f.help && f.type !== "text" && <small className="muted">{f.help}</small>}
          </label>
        ))}
      </fieldset>
      <div className="row tight wrap">
        <button className="primary" disabled={busy || !owner} onClick={() => save(true)}>{p.installed ? "Guardar" : "Instalar"}</button>
        {p.installed && <button disabled={busy || !owner} onClick={test}>Probar conexión</button>}
        {p.installed && p.enabled && p.capabilities.sync && <button disabled={busy || !owner} onClick={sync}>{busy ? "Trabajando…" : "Sincronizar ahora"}</button>}
        {p.installed && owner && <button className="danger" disabled={busy} onClick={remove}>Desinstalar</button>}
      </div>
      {p.installed && (
        <p className="muted small">
          {p.last_sync_at ? `Última sincronización: ${localTime(p.last_sync_at, true)}. ` : "Aún no se ha sincronizado. "}
          Se repite cada 15 min automáticamente.
          {p.last_error && <span className="err"> Último error: {p.last_error}</span>}
        </p>
      )}
      <Msg m={m} />
    </section>
  );
}

function Team({ me }: { me: Me }) {
  const [list, setList] = useState<Member[]>([]);
  const [f, setF] = useState({ email: "", name: "", password: "" });
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Member[]>("/team").then(setList), []);
  useEffect(() => { load(); }, [load]);
  const owner = me.user.role === "owner";

  const add = async () => {
    try { await post("/team", f); setF({ email: "", name: "", password: "" }); setM({ ok: true, text: "Persona añadida ✓" }); load(); }
    catch (e) {
      const code = (e as { code?: string }).code;
      setM({ ok: false, text: code === "email_taken" ? "Ese correo ya tiene cuenta." : code === "weak_password" ? "La contraseña necesita 8 caracteres o más." : "Revisa el correo y la contraseña." });
    }
  };
  return (
    <section className="panel">
      <h3>Equipo</h3>
      <p className="muted small">Quien entra como «Equipo» puede atender chats, pedidos y stock, pero no cambiar la configuración, las integraciones ni el equipo.</p>
      <table><tbody>
        {list.map((u) => (
          <tr key={u.id}><td>{u.name ?? u.email}<br /><small className="muted">{u.email}</small></td><td>{u.role === "owner" ? "Dueño" : "Equipo"}</td>
            <td>{owner && u.id !== me.user.id && <button className="danger" onClick={async () => { if (confirm(`¿Quitar a ${u.email}?`)) { await del(`/team/${u.id}`); load(); } }}>Quitar</button>}</td></tr>
        ))}
      </tbody></table>
      {owner && (
        <div className="row tight wrap">
          <input placeholder="Correo" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input placeholder="Nombre (opcional)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input type="password" placeholder="Contraseña (8+)" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <button className="primary" onClick={add}>Añadir</button>
        </div>
      )}
      <Msg m={m} />
    </section>
  );
}

export default function Integraciones({ me, onConnectionChange }: { me: Me; onConnectionChange: () => void }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const load = useCallback(() => api<PluginInfo[]>("/plugins").then(setPlugins), []);
  useEffect(() => { load(); }, [load]);
  const owner = me.user.role === "owner";
  return (
    <div className="form">
      <h2>Integraciones</h2>
      {!owner && <p className="note">Solo el dueño de la cuenta puede cambiar las integraciones.</p>}
      <WhatsApp owner={owner} onChange={onConnectionChange} />
      {plugins.length > 0 && <><h3 className="sect">Plugins</h3>
      <p className="muted small">El agente y el CRM funcionan solos con el catálogo propio (pestaña Catálogo). Los plugins conectan fuentes externas; instala solo el que uses.</p></>}
      {plugins.map((p) => <Plugin key={`${p.id}-${p.installed}-${p.enabled}`} p={p} owner={owner} reload={load} />)}
      <Team me={me} />
    </div>
  );
}
