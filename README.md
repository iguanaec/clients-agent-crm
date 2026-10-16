# WhatsApp coexistente + CRM + agente de ventas

CRM web para atender WhatsApp Business **sin dejar la app del celular** (coexistencia de Meta), y un agente de IA (Gemini) que **se enciende
aparte** para vender cuando el equipo no atiende y se apaga cuando quieras sin perder ni dejar de ver los chats.
**Multi‑cuenta**: una instalación sirve a muchos negocios; cada uno se registra, conecta su número y maneja sus chats, catálogo y pedidos sin ver los de otros.
Corre sobre Cloudflare (Workers, D1, R2, Images, Pages).

## Orden de uso (por diseño)
1. **CRM + WhatsApp coexistente.** Integraciones → *Conectar WhatsApp Business*: los mensajes llegan al CRM y al celular a la vez, y lo que se escribe
   desde el celular también aparece en el CRM. Se responde desde el CRM (texto, fotos, productos del catálogo, respuestas rápidas).
2. **Agente.** Nace **apagado** y en modo prueba. Se configura en la pestaña Agente y se enciende/apaga con el interruptor de la cabecera
   («Agente: encendido/apagado»). Apagado, el CRM sigue recibiendo y mostrando todo. Cuando el equipo escribe (CRM o celular), el agente se calla en ese chat.

## Qué incluye
| | |
|---|---|
| **CRM** | Resumen (embudo, ventas, tiempos de respuesta, demanda sin stock) · Chats · Catálogo y stock (altas, edición, fotos, CSV) · Pedidos · Agente · Integraciones y equipo. |
| **Agente** | Entiende lo que busca la persona, consulta stock real, envía fotos, cotiza envío y cierra con transferencia o link/indicaciones de tarjeta. Horario, zona horaria, tono, políticas y tarifas configurables. |
| **Cuentas** | Registro/login por correo, roles *Dueño* y *Equipo*, registro cerrable o con código de invitación. |
| **Plugins** | Infraestructura lista y sin plugins instalados (ver [docs/PLUGINS.md](docs/PLUGINS.md)). Catálogo y pedidos funcionan con el catálogo propio. |

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
Existe también `scripts/deploy.sh` (sin preguntas, con `CLOUDFLARE_API_TOKEN` en el entorno). Después, **cada negocio nuevo solo se registra en el CRM** y conecta su WhatsApp en Integraciones.

## Estructura
```
apps/api/src
  index.ts            rutas públicas (webhook de Meta, /media) y cron cada 15 min
  auth.ts             registro, login, sesiones; el tenant sale SIEMPRE de la sesión
  api.ts              API del CRM (todo filtrado por tenant)
  agent/              prompt, bucle con Gemini, herramientas, horario, envíos
  whatsapp/           webhook, firma HMAC, cliente de la API de WhatsApp (token por tenant)
  plugins/            contrato (types.ts) y registro (index.ts); sin plugins por ahora
  services/           stock, pedidos y sincronización (hablan con los plugins)
  lib/crypto.ts       PBKDF2, sesiones HMAC, cifrado AES‑GCM de secretos
apps/api/migrations   esquema D1
apps/crm/src          CRM (React + Vite)
```

## Estado y límites (leer antes de usarlo con clientes)
- **Probado:** lógica pura, cifrado/sesiones, aislamiento entre cuentas, catálogo y pedidos locales, recepción de mensajes y ecos del celular
  con el agente apagado, y el flujo del Embedded Signup con una **API de Meta simulada**; todo sobre D1/R2 locales. El CRM, en un navegador contra el Worker local.
- **No probado contra servicios reales:** Meta/WhatsApp (ventana de Embedded Signup, envío, webhook real, coexistencia, plantillas) y Gemini.
  Tampoco se ha desplegado aún en Cloudflare. Haz un piloto con un número de prueba y la lista blanca.
- Embedded Signup en coexistencia exige una app de Meta **Tech Provider** (o un BSP). Sin `META_APP_ID`/`META_CONFIG_ID` queda la conexión manual (Phone Number ID + token).
- No se importa el historial previo del celular (webhooks `history` y `smb_app_state_sync`): el CRM muestra lo que llega desde que se conecta.
- El inicio de sesión no tiene límite de intentos ni recuperación de contraseña por correo; si abres el registro al público, usa `SIGNUP_CODE` o Cloudflare Access/Turnstile.
- Audios: el agente pide que escriban (no transcribe). El mapeo edad→talla (`agent/sizes.ts`) es de ropa infantil y es opcional por negocio.
