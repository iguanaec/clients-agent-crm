# Desplegar la plataforma y dar de alta negocios

Una instalación = un Worker (API) + una base D1 + un bucket R2 + un sitio Pages (CRM). Todos los negocios comparten la instalación; sus datos
se separan por `tenant_id` y cada consulta del CRM se filtra por el tenant de la sesión.

## 1. Requisitos
- Cuenta de **Cloudflare** con **R2 activado** (pide tarjeta; capa gratis de 10 GB) y Node 20+.
- Una **app de Meta** (tipo Business, producto WhatsApp) para recibir el webhook. Si cada negocio usa la suya, ver la nota del final.
- Clave de **Gemini** (Google AI Studio). Puede ser una de la plataforma o una por negocio (se pega en el CRM).

## 2. Desplegar (Windows / PowerShell)
```powershell
.\scripts\deploy.ps1
```
Pide el token de Cloudflare (y opcionalmente `META_APP_ID`/`META_CONFIG_ID` para el Embedded Signup) (o inicia sesión en el navegador; permisos: Workers Scripts, D1, R2, Pages, Images), crea `wa-agent` (D1) y
`wa-agent-media` (R2), aplica `migrations/`, genera `SESSION_SECRET`, `SECRETS_KEY` y `WA_VERIFY_TOKEN`, sube las claves, y despliega API y CRM.
Es seguro volver a ejecutarlo: **no regenera** claves existentes (cambiar `SECRETS_KEY` dejaría ilegibles los tokens cifrados de los negocios).

Manual (cualquier sistema), desde `apps/api`:
```bash
npx wrangler d1 create wa-agent                  # pega el database_id en wrangler.toml
npx wrangler r2 bucket create wa-agent-media
npx wrangler d1 migrations apply wa-agent --remote
npx wrangler secret put SESSION_SECRET           # ≥ 32 caracteres aleatorios
npx wrangler secret put SECRETS_KEY              # ≥ 32 caracteres aleatorios; NO cambiar después
npx wrangler secret put WA_VERIFY_TOKEN          # el que pondrás en Meta
npx wrangler secret put WA_APP_SECRET            # secreto de la app de Meta
npx wrangler secret put GEMINI_API_KEY           # opcional si cada negocio pone la suya
npx wrangler secret put SIGNUP_CODE              # opcional: exige código para registrarse
npx wrangler deploy
cd ../crm && VITE_API_URL=https://<tu-worker>.workers.dev npm run build && npx wrangler pages deploy dist --project-name wa-agent-crm
```
`ALLOW_SIGNUP = "false"` en `wrangler.toml` cierra el registro público (el dueño añade a su equipo desde Integraciones → Equipo, y tú creas
negocios nuevos abriendo el registro un momento o con `SIGNUP_CODE`).

Sin preguntas (Linux/macOS/CI): `CLOUDFLARE_API_TOKEN=... [CLOUDFLARE_ACCOUNT_ID=...] [META_APP_ID=... META_CONFIG_ID=... WA_APP_SECRET=...] ./scripts/deploy.sh`.

## 3. Meta
1. **Webhook:** URL `https://<api>/webhook/whatsapp`, token = `WA_VERIFY_TOKEN`; suscribe **`messages`** y **`smb_message_echoes`**.
2. **Plantillas** (categoría *Utility*, idioma *Español*, con estos nombres exactos), para avisar al equipo:

   | Nombre | Texto sugerido |
   |---|---|
   | `nuevo_pedido` | `Nuevo pedido #{{1}} de {{2}} por {{3}}. Revísalo en el CRM.` |
   | `transferencia_por_confirmar` | `Transferencia por confirmar: pedido #{{1}} de {{2}} por {{3}}. Revisa el comprobante en el CRM.` |
   | `handoff_cliente` | `El cliente {{1}} necesita atención. Detalle: {{2}}` |
3. **Coexistencia** (para seguir usando WhatsApp Business en el celular): se conecta con *Embedded Signup* (`featureType: whatsapp_business_app_onboarding`),
   lo que exige que tu app sea **Tech Provider** (o usar un BSP). Crea la *Configuración de inicio de sesión* en tu app → WhatsApp, y copia su **Configuration ID** y el **App ID**
   a `META_APP_ID` / `META_CONFIG_ID` (`wrangler.toml`). Confirma los requisitos vigentes en la documentación oficial de Meta.

## 4. Alta de un negocio (lo hace el propio negocio)
1. Abre el CRM → **Crear una cuenta** (nombre del negocio, correo, contraseña [, código]). Queda en **modo prueba**: el agente no responde a nadie.
2. **Integraciones → WhatsApp:** *Conectar WhatsApp Business (coexistencia)* y seguir la ventana de Meta (o, sin Embedded Signup, Phone Number ID + token en «Conexión manual»). Revisar que los chats lleguen al CRM.
   El **agente** sigue apagado: se configura en la pestaña Agente y se enciende con el interruptor de la cabecera cuando el negocio quiera.
3. **Agente:** horario, zona horaria, moneda, datos bancarios o link de tarjeta, políticas, tono, tarifas de envío, número que recibe avisos.
4. **Catálogo:** crear productos (con fotos) o importar un CSV.
5. Encender el agente: primero con su número en la **lista blanca** (modo prueba), probar, y luego apagar el modo prueba.

## 5. Operación
- El **cron** (cada 15 min) sincroniza los plugins activos, refresca el estado de pedidos y avisa de chats pendientes al cerrar el horario.
- Los secretos de cada negocio (token de WhatsApp, claves de plugins, Gemini) se guardan **cifrados** (AES‑GCM con `SECRETS_KEY`) y nunca se devuelven al CRM.
- Costos de referencia: Workers $5/mes, D1/R2/Images dentro de las capas gratis para volúmenes pequeños, Gemini según uso, plantillas de Meta según tarifa vigente.
