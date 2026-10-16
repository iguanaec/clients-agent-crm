# Agente de ventas por WhatsApp + CRM

Agente de IA (Gemini) que atiende y vende por WhatsApp, más un CRM web para el equipo. **Multi‑cuenta**: una sola instalación
sirve a muchos negocios; cada uno se registra con su correo, conecta su propio WhatsApp y maneja su catálogo, chats y pedidos
sin ver los de nadie más. Corre sobre Cloudflare (Workers, D1, R2, Images, Pages).

**WooCommerce no es parte del núcleo: es un plugin** que cada negocio instala si lo necesita (Integraciones → WooCommerce).
Sin plugins el agente vende con el **catálogo propio** del CRM.

## Qué incluye
| | |
|---|---|
| **Agente** | Entiende lo que busca la persona, consulta stock real, envía fotos, cotiza envío y cierra con link/indicaciones de tarjeta o transferencia. Horario configurable, modo prueba con lista blanca, se calla cuando el equipo escribe (también desde el celular, vía *coexistencia* de Meta). |
| **CRM** | Resumen (embudo, ventas, tiempos de respuesta, demanda sin stock) · Chats (fotos, catálogo, respuestas rápidas) · Catálogo y stock (altas, edición, fotos, CSV) · Pedidos · Agente · Integraciones y equipo. |
| **Cuentas** | Registro/inicio de sesión por correo, roles *Dueño* y *Equipo*, registro cerrable o con código de invitación. |
| **Plugins** | Contrato `CommercePlugin` (ver [docs/PLUGINS.md](docs/PLUGINS.md)). Incluido: WooCommerce (sincroniza catálogo/stock, crea pedidos con link de pago, devuelve el stock a la tienda). |

## Probar en local
```bash
npm install
cat > apps/api/.dev.vars <<'VARS'
SESSION_SECRET=cambia-esto-por-32-o-mas-caracteres-aleatorios
WA_VERIFY_TOKEN=verifica123
WA_APP_SECRET=secreto-de-la-app-de-meta
GEMINI_API_KEY=tu-clave-de-gemini
VARS
npm run db:migrate:local -w @wa/api
npm run dev -w @wa/api            # API en http://localhost:8787
npm run dev -w @wa/crm            # CRM en http://localhost:5173 (pide la URL de la API al entrar)
npm test                          # pruebas (lógica, cifrado, plugins, y D1/R2 locales de punta a punta)
```
Abre el CRM → «Crear una cuenta». Las fotos (`/media`) las sirve el propio Worker.

## Desplegar y dar de alta negocios
Ver [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md). Resumen: `scripts/deploy.ps1` crea D1 + R2, aplica las migraciones, sube claves, despliega API y CRM.
Después, **cada negocio nuevo solo se registra en el CRM**, pega su *Phone Number ID* y su token de WhatsApp en Integraciones, y (opcional) instala WooCommerce.

## Estructura
```
apps/api/src
  index.ts            rutas públicas (webhook de Meta, /media) y cron cada 15 min
  auth.ts             registro, login, sesiones; el tenant sale SIEMPRE de la sesión
  api.ts              API del CRM (todo filtrado por tenant)
  agent/              prompt, bucle con Gemini, herramientas, horario, envíos
  whatsapp/           webhook, firma HMAC, cliente de la API de WhatsApp (token por tenant)
  plugins/            contrato (types.ts), registro (index.ts) y plugins (woocommerce/)
  services/           stock, pedidos y sincronización (hablan con los plugins)
  lib/crypto.ts       PBKDF2, sesiones HMAC, cifrado AES‑GCM de secretos
apps/api/migrations   esquema D1
apps/crm/src          CRM (React + Vite)
```

## Estado y límites (leer antes de vender esto)
- **Probado:** lógica pura, cifrado/sesiones, aislamiento entre cuentas, catálogo propio, pedidos y el plugin de WooCommerce
  contra una **API de WooCommerce simulada**, sobre D1/R2 locales; el CRM en un navegador contra el Worker local.
- **No probado contra servicios reales:** Meta/WhatsApp (envío, webhook real, coexistencia, plantillas), Gemini y una tienda WooCommerce real,
  ni el despliegue en Cloudflare ni `deploy.ps1` (no hay credenciales en este entorno). Haz un piloto con número de prueba y lista blanca.
- No hay *Embedded Signup* automático: cada negocio pega su Phone Number ID/token. Si vas a operar como Tech Provider, ese flujo es el siguiente paso.
- El inicio de sesión no tiene límite de intentos ni recuperación de contraseña por correo; si abres el registro al público, ponlo detrás de
  Cloudflare Access/Turnstile o usa `SIGNUP_CODE`.
- Audios: el agente pide que escriban (no transcribe). El mapeo edad→talla (`agent/sizes.ts`) es de ropa infantil y es opcional por negocio.
