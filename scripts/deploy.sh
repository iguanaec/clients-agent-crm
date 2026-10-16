#!/usr/bin/env bash
# Despliegue completo en Cloudflare, sin preguntas (para CI o para una sesión con credenciales en variables de entorno).
#
#   CLOUDFLARE_API_TOKEN=...  (permisos: Workers Scripts, D1, R2, Pages, Images — Edit)
#   CLOUDFLARE_ACCOUNT_ID=... (opcional si el token ve una sola cuenta)
#   Opcionales: META_APP_ID, META_CONFIG_ID (Embedded Signup), WA_APP_SECRET, WA_ACCESS_TOKEN,
#               GEMINI_API_KEY, SIGNUP_CODE, WA_VERIFY_TOKEN
#
#   ./scripts/deploy.sh
#
# Es seguro volver a ejecutarlo: reutiliza lo que existe y NO regenera SESSION_SECRET / SECRETS_KEY / WA_VERIFY_TOKEN
# si ya están (cambiar SECRETS_KEY dejaría ilegibles los tokens cifrados de los negocios).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/apps/api"; CRM="$ROOT/apps/crm"
DB_NAME="${DB_NAME:-wa-agent}"; BUCKET="${BUCKET:-wa-agent-media}"; PAGES="${PAGES_PROJECT:-wa-agent-crm}"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "Falta CLOUDFLARE_API_TOKEN (agrégalo como variable de entorno; no lo pegues en el chat)." >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
wr() { (cd "$API" && npx --yes wrangler "$@"); }

step "Dependencias"; (cd "$ROOT" && npm install --no-audit --no-fund --silent)

step "Cuenta de Cloudflare"
wr whoami
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "(CLOUDFLARE_ACCOUNT_ID no definido: wrangler usará la única cuenta del token; si falla por varias cuentas, defínelo.)"
fi

step "Base de datos D1 ($DB_NAME)"
get_db() { wr d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s).find(d=>d.name===process.argv[1]);if(x)console.log(x.uuid)}catch{}})' "$DB_NAME"; }
DB_ID="$(get_db)"
if [ -z "$DB_ID" ]; then wr d1 create "$DB_NAME"; DB_ID="$(get_db)"; fi
[ -n "$DB_ID" ] || { echo "No se pudo crear/leer la base D1 (¿permiso D1 Edit?)." >&2; exit 1; }
sed -i.bak -E "s|^database_id = \".*\"|database_id = \"$DB_ID\"|; s|^database_name = \".*\"|database_name = \"$DB_NAME\"|" "$API/wrangler.toml"
[ -n "${META_APP_ID:-}" ] && sed -i.bak -E "s|^META_APP_ID = \".*\"|META_APP_ID = \"$META_APP_ID\"|" "$API/wrangler.toml"
[ -n "${META_CONFIG_ID:-}" ] && sed -i.bak -E "s|^META_CONFIG_ID = \".*\"|META_CONFIG_ID = \"$META_CONFIG_ID\"|" "$API/wrangler.toml"
rm -f "$API/wrangler.toml.bak"
echo "D1 lista: $DB_ID"

step "Almacén de fotos R2 ($BUCKET)"
wr r2 bucket create "$BUCKET" 2>&1 | tail -2 || true
wr r2 bucket list 2>/dev/null | grep -q "$BUCKET" || { echo "R2 no está activo o falta permiso: actívalo en dash.cloudflare.com → R2." >&2; exit 1; }
sed -i.bak -E "s|^bucket_name = \".*\"|bucket_name = \"$BUCKET\"|" "$API/wrangler.toml"; rm -f "$API/wrangler.toml.bak"

step "Tablas (migraciones)"
wr d1 migrations apply "$DB_NAME" --remote

step "Despliegue de la API (Worker)"
OUT="$(wr deploy 2>&1 | tee /dev/stderr)"
API_URL="$(printf '%s' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$API_URL" ] || { echo "No pude leer la URL del Worker del resultado de wrangler." >&2; exit 1; }

step "Claves"
EXISTING="$(wr secret list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(x=>x.name).join(" "))}catch{}})')"
has() { [[ " $EXISTING " == *" $1 "* ]]; }
TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.verify"' EXIT
node - "$TMP" "$EXISTING" <<'NODE'
const fs = require("fs"), c = require("crypto");
const [file, existing] = [process.argv[2], new Set(process.argv[3].split(" "))];
const rand = () => c.randomBytes(36).toString("hex").slice(0, 48);
const out = {};
for (const k of ["SESSION_SECRET", "SECRETS_KEY"]) if (!existing.has(k)) out[k] = rand();
if (!existing.has("WA_VERIFY_TOKEN")) { out.WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || rand().slice(0, 24); fs.writeFileSync(file + ".verify", out.WA_VERIFY_TOKEN); }
for (const k of ["WA_APP_SECRET", "WA_ACCESS_TOKEN", "GEMINI_API_KEY", "SIGNUP_CODE"]) if (process.env[k]) out[k] = process.env[k];
fs.writeFileSync(file, JSON.stringify(out));
NODE
if [ "$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1]))).length)' "$TMP")" -gt 0 ]; then wr secret bulk "$TMP"; fi
VERIFY="$(cat "$TMP.verify" 2>/dev/null || echo "(ya configurado: es el mismo de antes)")"

step "CRM (Cloudflare Pages: $PAGES)"
(cd "$CRM" && VITE_API_URL="$API_URL" npm run build --silent)
wr pages project create "$PAGES" --production-branch main 2>&1 | tail -1 || true
PAGES_OUT="$(cd "$CRM" && npx --yes wrangler pages deploy dist --project-name "$PAGES" --branch main 2>&1 | tee /dev/stderr)"
CRM_URL="$(printf '%s' "$PAGES_OUT" | grep -oE 'https://[a-z0-9.-]+\.pages\.dev' | head -1)"

cat <<EOT

==============================
API:           $API_URL
Webhook Meta:  $API_URL/webhook/whatsapp
Token verify:  $VERIFY
CRM:           ${CRM_URL:-<la URL .pages.dev que mostró wrangler>}
==============================
Siguiente: abre el CRM → "Crear una cuenta" (esa cuenta es la del dueño del negocio) → Integraciones → conectar WhatsApp.
En Meta, configura el webhook con la URL y el token de arriba (campos: messages y smb_message_echoes).
EOT
