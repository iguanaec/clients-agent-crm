import { useCallback, useEffect, useState } from "react";
import { api, del, localTime, post, put, type Me, type PluginInfo } from "../api";

interface Connection {
  name: string; phone_number_id: string; has_wa_token: boolean; platform_wa_token: boolean;
  has_gemini_key: boolean; platform_gemini_key: boolean; webhook_url: string;
}
interface Member { id: number; email: string; name: string | null; role: "owner" | "agent" }

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <p className={m.ok ? "ok" : "err"}>{m.text}</p> : null;
}

function WhatsApp({ owner }: { owner: boolean }) {
  const [c, setC] = useState<Connection | null>(null);
  const [pid, setPid] = useState("");
  const [token, setToken] = useState("");
  const [gem, setGem] = useState("");
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Connection>("/connection").then((x) => { setC(x); setPid(x.phone_number_id); }), []);
  useEffect(() => { load(); }, [load]);
  if (!c) return null;

  const save = async () => {
    try {
      await put("/connection", { phone_number_id: pid, wa_access_token: token, gemini_api_key: gem });
      setToken(""); setGem(""); setM({ ok: true, text: "Guardado ✓" }); load();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setM({ ok: false, text: code === "phone_number_id_in_use" ? "Ese Phone Number ID ya está conectado a otra cuenta." : code === "bad_phone_number_id" ? "El Phone Number ID solo lleva números." : "No se pudo guardar." });
    }
  };
  const test = async () => { const r = await post<{ ok: boolean; message: string }>("/connection/test"); setM({ ok: r.ok, text: r.message }); };

  return (
    <section className="panel">
      <h3>WhatsApp y IA</h3>
      <p className="muted small">
        En Meta (developers.facebook.com → tu app → WhatsApp) copia el <b>Phone Number ID</b> y un <b>token permanente</b>. Si el administrador de la plataforma ya configuró un token general, puedes dejarlo vacío.
      </p>
      <fieldset disabled={!owner}>
        <label>Phone Number ID<input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="1234567890" /></label>
        <label>Token de acceso de WhatsApp {c.has_wa_token ? <span className="ok">· guardado (escribe para reemplazar)</span> : c.platform_wa_token ? <span className="muted">· se usa el de la plataforma</span> : null}
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
        <label>Clave de Gemini propia (opcional) {c.has_gemini_key ? <span className="ok">· guardada</span> : c.platform_gemini_key ? <span className="muted">· se usa la de la plataforma</span> : <span className="err">· falta: el agente no podrá responder</span>}
          <input type="password" autoComplete="off" value={gem} onChange={(e) => setGem(e.target.value)} /></label>
      </fieldset>
      <p className="muted small">Webhook para Meta: <code>{c.webhook_url}</code> (campos <code>messages</code> y <code>smb_message_echoes</code>).</p>
      <div className="row"><button className="primary" onClick={save} disabled={!owner}>Guardar</button><button onClick={test} disabled={!owner}>Probar conexión</button></div>
      <Msg m={m} />
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

export default function Integraciones({ me }: { me: Me }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const load = useCallback(() => api<PluginInfo[]>("/plugins").then(setPlugins), []);
  useEffect(() => { load(); }, [load]);
  const owner = me.user.role === "owner";
  return (
    <div className="form">
      <h2>Integraciones</h2>
      {!owner && <p className="note">Solo el dueño de la cuenta puede cambiar las integraciones.</p>}
      <WhatsApp owner={owner} />
      <h3 className="sect">Plugins</h3>
      <p className="muted small">El agente y el CRM funcionan solos con el catálogo propio (pestaña Catálogo). Los plugins conectan fuentes externas; instala solo el que uses.</p>
      {plugins.map((p) => <Plugin key={`${p.id}-${p.installed}-${p.enabled}`} p={p} owner={owner} reload={load} />)}
      <Team me={me} />
    </div>
  );
}
