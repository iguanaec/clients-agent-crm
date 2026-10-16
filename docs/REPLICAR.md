# Replicar el agente para otro cliente

Cada cliente tiene **su propio despliegue** (su cuenta de Cloudflare, su WhatsApp, su WooCommerce). Con este proyecto, montar uno nuevo toma de 1 a 2 horas de trabajo propio más lo que tarde Meta.

## 0. Qué necesita el cliente antes de empezar
- [ ] Tienda **WooCommerce** con productos, stock y fotos; API REST habilitada.
- [ ] Un **número de WhatsApp Business** (app) y acceso al administrador de negocios de Meta.
- [ ] Cuenta de **Cloudflare** (gratis) con **R2 activado** (pide tarjeta, capa gratis de 10 GB). Recomendado: a nombre del cliente.
- [ ] Clave de API de **Gemini** (Google AI Studio, con facturación activa).
- [ ] Reglas de negocio: horario del agente, tarifas y zonas de envío, formas de pago, políticas de cambios, datos bancarios, número que recibe avisos.

## 1. Preparar el proyecto
```powershell
cd <carpeta>\proyecto
npm install
```

## 2. Crear los datos del cliente
```powershell
.\scripts\new-client.ps1
```
Pregunta nombre, tienda, horario, zona horaria, tono, datos bancarios y políticas, y crea `apps\api\seed\<id>.sql`. Ábrelo y completa zonas y tarifas de envío (quedan en 0); también se editan luego en el CRM → Agente.

## 3. Desplegar
```powershell
.\scripts\deploy.ps1 -Seed seed\<id>.sql
```
Pide el token de Cloudflare (o Enter para iniciar sesión en el navegador) y la clave de Gemini. Crea la base D1 y el almacén R2, aplica las tablas, carga el seed, despliega la API y el CRM, y al final imprime: URL de la API, URL del webhook, **token de verificación** y **token del CRM**. Guárdalos.

Permisos si usas token: Workers Scripts, D1, R2, Pages, Images. Si falla algo, el script se detiene con el motivo; es seguro volver a ejecutarlo.

## 4. WooCommerce
1. En WordPress: WooCommerce → Ajustes → Avanzado → REST API → *Añadir clave* (usuario administrador, **lectura/escritura**).
2. En `apps\api`:
   ```powershell
   npx.cmd wrangler secret put WOO_CONSUMER_KEY
   npx.cmd wrangler secret put WOO_CONSUMER_SECRET
   ```
3. CRM → **Stock** → *Sincronizar con WooCommerce*. Verifica productos, tallas y fotos. Cada producto necesita al menos una variación con atributo **Talla** (o ser un producto simple).
4. Para transferencias, habilita en WooCommerce el método *Transferencia bancaria (bacs)*.

## 5. Meta (lo que más tarda: empieza primero)
1. **Verificar el negocio** en Meta Business y crear una **app** (tipo Business) con el producto WhatsApp.
2. **Coexistencia:** el número se conecta con *Embedded Signup* en modo "usar la app WhatsApp Business junto con la API". Requiere que la app sea **Tech Provider** (o usar un BSP como 360dialog). Versión de la app WhatsApp Business ≥ 2.24.17. La app del celular debe abrirse al menos cada ~13 días o el número se desconecta.
3. **Webhook:** URL `https://<api>/webhook/whatsapp`, token = el *token de verificación* del paso 3. Suscribir los campos **`messages`** y **`smb_message_echoes`**.
4. **Secrets** (en `apps\api`):
   ```powershell
   npx.cmd wrangler secret put WA_APP_SECRET     # secreto de la app de Meta
   npx.cmd wrangler secret put WA_ACCESS_TOKEN   # token permanente de un usuario del sistema
   ```
5. **Plantillas** (categoría *Utility*, idioma *Español*, deben llamarse exactamente así):

   | Nombre | Texto sugerido |
   |---|---|
   | `nuevo_pedido` | `Nuevo pedido #{{1}} de {{2}} por ${{3}}. Revísalo en el CRM.` |
   | `transferencia_por_confirmar` | `Transferencia por confirmar: pedido #{{1}} de {{2}} por ${{3}}. Revisa el comprobante en el CRM.` |
   | `handoff_cliente` | `La clienta {{1}} necesita atención. Detalle: {{2}}` |

6. Registrar el **Phone Number ID** y el número que recibe avisos:
   ```powershell
   npx.cmd wrangler d1 execute pw-agent --remote --command "UPDATE tenants SET wa_phone_number_id='<ID>' WHERE id='<id>'"
   ```
   y en el CRM → Agente: *Número que recibe avisos*.

## 6. Piloto y salida a producción
1. El agente arranca en **modo prueba**. CRM → Agente: agrega a la lista blanca los números del equipo (con código de país) y prueba conversaciones reales: pedir una talla, ver fotos, cotizar envío, pagar con tarjeta, pagar por transferencia y subir comprobante.
2. Revisa el **Resumen** y los chats para ajustar tono y políticas (CRM → Agente).
3. Si el número viene de otro proveedor (Kommo, etc.): exportar contactos e historial, hacer el cambio **de día con el agente apagado**, y conservar la cuenta anterior un mes solo para consulta.
4. Apaga el **modo prueba**, capacita al equipo y activa la ventana horaria definitiva.

## 7. Usuarios del CRM
Hoy el CRM usa **un token compartido** (el que imprime `deploy.ps1`). Para cuentas por persona, pon **Cloudflare Access** delante del proyecto de Pages (login por correo; gratis hasta 50 usuarios) y deja el token solo como clave de la API. No está implementado todavía.

## 8. Qué adaptar si el cliente NO vende ropa
- `apps/api/src/agent/sizes.ts` (edad → talla) y las herramientas `buscar_productos` en `tools.ts`.
- El flujo del prompt en `apps/api/src/agent/agent.ts` (menciona edad/talla).
- Textos de la interfaz que dicen "talla".

## 9. Costo por cliente
≈ **$14–21 al mes** de plataformas con ~300 chats/mes (Cloudflare Workers $5; Gemini ≈$5; avisos de Meta $4–11; D1, R2 e Images dentro de las capas gratis). Ver el cálculo en el documento de presupuesto de Le Petit.

## 10. Cuando algo falla
- `deploy.ps1` muestra la ayuda de wrangler en vez de ejecutar → se estaba usando `npx` en lugar de `npx.cmd` (ya corregido en el script).
- "R2 no esta activo" → activarlo en dash.cloudflare.com → R2 y reintentar.
- El agente no responde → ¿modo prueba activo?, ¿número en la lista blanca?, ¿fuera del horario?, ¿chat en estado "Equipo" o con pausa tras escribir alguien desde el celular?
- Sin fotos en los mensajes → falta sincronizar el catálogo o no está activo el binding de Images.
