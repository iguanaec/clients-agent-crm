import { useCallback, useEffect, useState } from "react";
import { api, biz, post, session, type ConnStatus, type Me } from "./api";
import Agente from "./pages/Agente";
import Chats from "./pages/Chats";
import Dashboard from "./pages/Dashboard";
import Integraciones from "./pages/Integraciones";
import Pedidos from "./pages/Pedidos";
import Stock from "./pages/Stock";

type Tab = "resumen" | "chats" | "stock" | "pedidos" | "agente" | "integraciones";
const TABS: [Tab, string][] = [["resumen", "Resumen"], ["chats", "Chats"], ["stock", "Catálogo"], ["pedidos", "Pedidos"], ["agente", "Agente"], ["integraciones", "Integraciones"]];

const ERRORS: Record<string, string> = {
  bad_credentials: "Correo o contraseña incorrectos.",
  email_taken: "Ese correo ya tiene una cuenta.",
  weak_password: "La contraseña necesita 8 caracteres o más.",
  bad_email: "Revisa el correo.",
  bad_business: "Escribe el nombre de tu negocio.",
  signup_closed: "El registro está cerrado. Pide al administrador que te cree una cuenta.",
  bad_code: "Código de invitación incorrecto.",
};

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [base, setBase] = useState(session.base);
  const [f, setF] = useState({ business: "", email: "", password: "", code: "" });
  const [opts, setOpts] = useState({ signup: true, needsCode: false });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const baked = !!import.meta.env.VITE_API_URL;

  useEffect(() => {
    if (base) { session.save(base, ""); api<{ signup: boolean; needsCode: boolean }>("/auth/config").then(setOpts).catch(() => {}); }
  }, [base]);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      if (!baked) session.save(base, "");
      const r = await api<{ token: string }>(`/auth/${mode}`, { method: "POST", body: JSON.stringify(mode === "login" ? { email: f.email, password: f.password } : f) });
      session.save(base, r.token);
      onDone();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setErr(ERRORS[code] ?? "No se pudo conectar con el servidor. Revisa la URL de la API.");
    }
    setBusy(false);
  };
  const onEnter = (e: React.KeyboardEvent) => e.key === "Enter" && submit();

  return (
    <div className="login">
      <h1>Agente WhatsApp</h1>
      <p className="muted">{mode === "login" ? "Entra a tu cuenta." : "Crea la cuenta de tu negocio."}</p>
      {!baked && <label>URL de la API<input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://wa-agent-api.xxx.workers.dev" /></label>}
      {mode === "signup" && <label>Nombre del negocio<input value={f.business} onChange={(e) => setF({ ...f, business: e.target.value })} /></label>}
      <label>Correo<input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} onKeyDown={onEnter} /></label>
      <label>Contraseña<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} onKeyDown={onEnter} /></label>
      {mode === "signup" && opts.needsCode && <label>Código de invitación<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} onKeyDown={onEnter} /></label>}
      <button className="primary" onClick={submit} disabled={busy}>{mode === "login" ? "Entrar" : "Crear cuenta"}</button>
      {err && <p className="err">{err}</p>}
      {opts.signup && (
        <p className="switch small">
          {mode === "login" ? "¿Primera vez? " : "¿Ya tienes cuenta? "}
          <button className="link" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); }}>{mode === "login" ? "Crear una cuenta" : "Entrar"}</button>
        </p>
      )}
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState(!!session.token);
  const [tab, setTab] = useState<Tab>("resumen");
  const [conn, setConn] = useState<ConnStatus | null>(null);
  const loadConn = useCallback(() => { api<ConnStatus>("/connection").then(setConn).catch(() => {}); }, []);

  useEffect(() => {
    if (!authed) return;
    loadConn();
    api<Me>("/me").then((m) => { biz.timezone = m.tenant.timezone; biz.currency = m.tenant.currency; setMe(m); }).catch(() => {});
  }, [authed, loadConn]);

  const toggleAgent = async () => {
    if (!conn) return;
    const next = !conn.agent_enabled;
    if (next && !confirm("¿Encender el agente de IA? Responderá por WhatsApp según el horario y el modo prueba configurados en la pestaña Agente. Puedes apagarlo cuando quieras; los chats se siguen viendo igual.")) return;
    await post("/agent/toggle", { enabled: next });
    loadConn();
  };

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  if (!me) return <p className="muted pad">Cargando…</p>;

  return (
    <div className="app">
      <header>
        <strong>{me.tenant.name}</strong>
        <nav>{TABS.map(([k, label]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}</nav>
        {conn && (
          <button className={`chip-toggle ${conn.agent_enabled ? "on" : ""}`} onClick={toggleAgent} title="Enciende o apaga el agente de IA. Apagado, sigues viendo y respondiendo tus chats.">
            Agente: {conn.agent_enabled ? "encendido" : "apagado"}
          </button>
        )}
        <span className="muted small">{me.user.email}</span>
        <button className="link" onClick={() => { session.clear(); location.reload(); }}>Salir</button>
      </header>
      {conn && !conn.connected && tab !== "integraciones" && (
        <div className="banner">Aún no has conectado tu WhatsApp. <button className="link" onClick={() => setTab("integraciones")}>Conectarlo ahora →</button></div>
      )}
      <main>
        {tab === "resumen" && <Dashboard goto={setTab} />}
        {tab === "chats" && <Chats />}
        {tab === "stock" && <Stock />}
        {tab === "pedidos" && <Pedidos />}
        {tab === "agente" && <Agente me={me} />}
        {tab === "integraciones" && <Integraciones me={me} onConnectionChange={loadConn} />}
      </main>
    </div>
  );
}
