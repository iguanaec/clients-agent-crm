/** Embedded Signup de Meta en modo coexistencia: el número sigue activo en la app WhatsApp Business del celular. */
declare global {
  interface Window {
    FB?: {
      init(o: Record<string, unknown>): void;
      login(cb: (r: { authResponse?: { code?: string } }) => void, o: Record<string, unknown>): void;
    };
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<void> | null = null;
function loadSdk(appId: string): Promise<void> {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: "v23.0" }); resolve(); };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.onerror = () => { sdk = null; reject(new Error("No se pudo cargar el SDK de Facebook (¿bloqueador de anuncios?).")); };
    document.head.appendChild(s);
  });
  return sdk;
}

export interface SignupResult { code: string; waba_id: string; phone_number_id?: string }

/** Abre la ventana de Meta y devuelve el código + ids de la cuenta cuando el usuario termina. */
export async function startEmbeddedSignup(appId: string, configId: string): Promise<SignupResult> {
  await loadSdk(appId);
  return new Promise((resolve, reject) => {
    let code: string | undefined;
    let ids: { waba_id?: string; phone_number_id?: string } | undefined;
    const done = () => {
      if (code && ids?.waba_id) { cleanup(); resolve({ code, waba_id: ids.waba_id, phone_number_id: ids.phone_number_id }); }
    };
    const onMsg = (e: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (d?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (String(d.event).startsWith("FINISH")) { ids = d.data; done(); }
        else if (d.event === "CANCEL") { cleanup(); reject(new Error("Cancelaste la conexión.")); }
      } catch { /* mensaje que no es de Meta */ }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Se agotó el tiempo de la conexión.")); }, 15 * 60_000);
    const cleanup = () => { window.removeEventListener("message", onMsg); clearTimeout(timer); };
    window.addEventListener("message", onMsg);
    window.FB!.login((r) => {
      code = r.authResponse?.code;
      if (!code) { cleanup(); reject(new Error("No se completó la autorización de Meta.")); } else done();
    }, {
      config_id: configId, response_type: "code", override_default_response_type: true,
      extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfo: { version: "3" } },
    });
  });
}
