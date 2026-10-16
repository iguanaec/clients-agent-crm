import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, localTime, mediaUrl, post, productImg, toJpeg, type Conversation, type Message, type Product, type QuickReply } from "../api";

const STATE_LABEL = { bot: "Agente", humano: "Equipo", cerrada: "Cerrada" } as const;
const AUTHOR_LABEL: Record<Message["author"], string> = { cliente: "", bot: "Agente", humano: "Equipo (CRM)", app: "Celular" };
type Filter = "todos" | "sin_leer" | "bot" | "humano";

function Img({ k }: { k: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { mediaUrl(k).then(setSrc).catch(() => setSrc("")); }, [k]);
  return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="adjunto" className="att" /></a> : <div className="att ph" />;
}

const windowClosed = (c: Conversation) => !c.last_in || Date.now() - new Date(c.last_in.replace(" ", "T") + "Z").getTime() > 24 * 3600_000;

function Picker({ onPick, onClose }: { onPick: (p: Product) => void; onClose: () => void }) {
  const [items, setItems] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { api<Product[]>("/catalog").then(setItems); }, []);
  const shown = items.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q.toLowerCase()) && p.variants.some((v) => v.stock > 0));
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="row"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto con stock…" /><button onClick={onClose}>Cerrar</button></div>
        <div className="pgrid">
          {shown.slice(0, 60).map((p) => (
            <button key={p.id} className="pcard" onClick={() => onPick(p)}>
              {p.image ? <img src={productImg(p.image)} alt="" loading="lazy" /> : <div className="ph" />}
              <span>{p.name}</span>
              <small>{p.variants.filter((v) => v.stock > 0).map((v) => v.size).join(", ")}</small>
            </button>
          ))}
          {!shown.length && <p className="muted pad">No hay productos con stock que coincidan.</p>}
        </div>
      </div>
    </div>
  );
}

export default function Chats() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [quick, setQuick] = useState<QuickReply[]>([]);
  const [showQuick, setShowQuick] = useState(false);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadConvs = useCallback(() => api<Conversation[]>(`/conversations?q=${encodeURIComponent(q)}`).then(setConvs).catch(() => {}), [q]);
  const loadMsgs = useCallback((id: number) => api<Message[]>(`/conversations/${id}/messages`).then(setMsgs).catch(() => {}), []);
  const loadQuick = useCallback(() => api<QuickReply[]>("/quick-replies").then(setQuick).catch(() => {}), []);

  useEffect(() => { loadConvs(); const t = setInterval(loadConvs, 8_000); return () => clearInterval(t); }, [loadConvs]);
  useEffect(() => { loadQuick(); }, [loadQuick]);
  useEffect(() => {
    if (sel == null) return;
    setMsgs([]); setErr(""); setText("");
    loadMsgs(sel);
    const t = setInterval(() => loadMsgs(sel), 4_000);
    return () => clearInterval(t);
  }, [sel, loadMsgs]);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [msgs.length, sel]);

  const cur = convs.find((c) => c.id === sel);
  // Marca como leído al abrir el chat y cuando llegan mensajes nuevos mientras está abierto.
  useEffect(() => {
    if (cur && cur.unread > 0) post(`/conversations/${cur.id}/seen`).then(loadConvs).catch(() => {});
  }, [cur?.id, cur?.unread, msgs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => convs.filter((c) =>
    filter === "todos" ? true : filter === "sin_leer" ? c.unread > 0 : c.state === filter), [convs, filter]);
  const unreadTotal = convs.reduce((a, c) => a + (c.unread > 0 ? 1 : 0), 0);
  const paused = cur?.bot_paused_until && cur.bot_paused_until > new Date().toISOString().replace("T", " ").slice(0, 19);
  const closed = cur ? windowClosed(cur) : false;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); if (sel != null) await loadMsgs(sel); await loadConvs(); }
    catch (e) {
      const code = e instanceof ApiError ? e.code : String(e);
      setErr(code === "window_closed" ? "Pasaron más de 24 h desde el último mensaje del cliente: desde aquí ya no se puede escribir." : code === "whatsapp_not_connected" ? "WhatsApp no está conectado: configúralo en Integraciones." : `No se pudo enviar (${code}).`);
    }
    setBusy(false);
  };

  const setState = (state: Conversation["state"]) => run(() => post(`/conversations/${sel}/state`, { state }));
  const send = () => { const t = text.trim(); if (!t || sel == null) return; setText(""); run(() => post(`/conversations/${sel}/send`, { text: t })); };
  const sendFile = (f: File | undefined) => f && sel != null && run(async () => {
    const jpg = await toJpeg(f);
    const form = new FormData();
    form.append("file", new File([jpg], "foto.jpg", { type: "image/jpeg" }));
    form.append("caption", text.trim());
    setText("");
    await api(`/conversations/${sel}/send-image`, { method: "POST", body: form });
  });
  const sendProduct = (p: Product) => { setPicker(false); run(() => post(`/conversations/${sel}/send-product`, { product_id: p.id })); };
  const saveQuick = async () => {
    const body = text.trim();
    if (!body) return setErr("Escribe primero el mensaje que quieres guardar.");
    const title = prompt("Nombre de la respuesta rápida:", body.slice(0, 30));
    if (title) { await post("/quick-replies", { title, body }); loadQuick(); }
  };

  return (
    <div className="chats">
      <aside>
        <div className="side-top">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre o número" />
          <div className="seg small">
            {([["todos", "Todos"], ["sin_leer", `Sin leer${unreadTotal ? ` (${unreadTotal})` : ""}`], ["bot", "Agente"], ["humano", "Equipo"]] as [Filter, string][]).map(([k, label]) => (
              <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="conv-list">
          {list.map((c) => (
            <button key={c.id} className={`conv ${c.id === sel ? "on" : ""}`} onClick={() => setSel(c.id)}>
              <div className="conv-top">
                <strong>{c.name ?? `+${c.wa_id}`}</strong>
                <small>{localTime(c.last_message_at, new Date(c.last_message_at.replace(" ", "T") + "Z").toDateString() !== new Date().toDateString())}</small>
              </div>
              <div className="conv-bot">
                <small className="preview">{c.last_type === "image" ? "📷 Foto" : c.last_body ?? ""}</small>
                {c.unread > 0 && <span className="badge">{c.unread}</span>}
                <span className={`pill ${c.state}`}>{STATE_LABEL[c.state]}</span>
              </div>
            </button>
          ))}
          {!list.length && <p className="muted pad small">Sin conversaciones.</p>}
        </div>
      </aside>

      <section>
        {cur ? (
          <>
            <div className="bar">
              <strong>{cur.name ?? `+${cur.wa_id}`}</strong> <span className="muted">+{cur.wa_id}</span>
              {paused && <span className="pill humano" title="El agente no responde en este chat por unas horas">Agente en pausa</span>}
              {closed && <span className="pill cerrada">Ventana 24 h cerrada</span>}
              <span className="spacer" />
              {cur.state !== "bot" && <button onClick={() => setState("bot")}>Devolver al agente</button>}
              {cur.state !== "humano" && <button onClick={() => setState("humano")}>Atender yo</button>}
              {cur.state !== "cerrada" && <button onClick={() => setState("cerrada")}>Cerrar</button>}
            </div>
            <div className="msgs">
              {msgs.map((m) => (
                <div key={m.id} className={`msg ${m.direction} ${m.author}`}>
                  {m.media_key && <Img k={m.media_key} />}
                  {m.body && <div>{m.body}</div>}
                  <small>{AUTHOR_LABEL[m.author] && `${AUTHOR_LABEL[m.author]} · `}{localTime(m.created_at)}</small>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            {err && <p className="err small pad-x">{err}</p>}
            {closed ? (
              <p className="note pad-x">Pasaron más de 24 h desde el último mensaje del cliente. Para escribirle, usa la app WhatsApp Business en el celular.</p>
            ) : (
              <div className="compose">
                <div className="tools">
                  <button title="Enviar una foto" onClick={() => fileRef.current?.click()} disabled={busy}>📎 Foto</button>
                  <button title="Enviar fotos de un producto del catálogo" onClick={() => setPicker(true)} disabled={busy}>👗 Catálogo</button>
                  <div className="qwrap">
                    <button onClick={() => setShowQuick((s) => !s)}>⚡ Respuestas</button>
                    {showQuick && (
                      <div className="qmenu">
                        {quick.map((r) => (
                          <div key={r.id} className="qitem">
                            <button onClick={() => { setText(r.body); setShowQuick(false); }}><strong>{r.title}</strong><small>{r.body}</small></button>
                            <button className="link" title="Borrar" onClick={async () => { await api(`/quick-replies/${r.id}`, { method: "DELETE" }); loadQuick(); }}>✕</button>
                          </div>
                        ))}
                        {!quick.length && <p className="muted small pad">Aún no hay respuestas guardadas.</p>}
                        <button className="qsave" onClick={saveQuick}>＋ Guardar el texto actual</button>
                      </div>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = ""; }} />
                </div>
                <div className="row">
                  <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="Escribe como equipo. Enter envía, Shift+Enter hace salto de línea." />
                  <button className="primary" onClick={send} disabled={busy || !text.trim()}>Enviar</button>
                </div>
              </div>
            )}
          </>
        ) : <p className="muted pad">Elige una conversación para verla aquí. Lo que el equipo escribe desde el celular también aparece en este chat.</p>}
      </section>
      {picker && <Picker onPick={sendProduct} onClose={() => setPicker(false)} />}
    </div>
  );
}
