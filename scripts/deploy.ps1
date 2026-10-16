# Despliegue completo en Cloudflare. Ejecutar en una terminal PowerShell propia, desde la carpeta del repo:
#   .\scripts\deploy.ps1
# Las claves se piden aqui (no se muestran ni se guardan en archivos del repo).
# Es seguro volver a ejecutarlo: reutiliza lo que ya existe.
# Una sola instalacion sirve a todos los negocios: cada uno crea su cuenta desde el CRM (no hay seed ni script por cliente).
$ErrorActionPreference = "Continue"   # npx escribe avisos por stderr; los errores reales se revisan con Check
$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root "apps\api"
$crm = Join-Path $root "apps\crm"

function Ask-Secret([string]$label) {
  $s = Read-Host -AsSecureString $label
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
function Step([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }
# npx.cmd (no npx.ps1): el atajo de PowerShell pierde los argumentos y wrangler solo muestra su ayuda.
function Wr { & npx.cmd wrangler @args }
function Check([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what fallo (codigo $LASTEXITCODE). Revisa el mensaje de arriba." } }

# --- Acceso a Cloudflare: token de API (permisos: Workers, D1, R2, Pages, Images) o login en el navegador ---
$cf = Ask-Secret "Token de Cloudflare (Enter para iniciar sesion en el navegador)"
Push-Location $api
if ($cf) { $env:CLOUDFLARE_API_TOKEN = $cf } else { Wr login; Check "Login en Cloudflare" }
$gemini = Ask-Secret "Clave de API de Gemini de la plataforma (Enter si cada negocio pondra la suya)"

Step "Comprobando la cuenta"
Wr whoami
Check "Conexion con Cloudflare"

Step "Dependencias"
Push-Location $root; npm.cmd install --silent; Check "npm install"; Pop-Location

Step "Base de datos D1"
function Get-Db { ((Wr d1 list --json 2>$null) -join "`n" | ConvertFrom-Json) | Where-Object { $_.name -eq "wa-agent" } }
$db = Get-Db
if (-not $db) { Wr d1 create wa-agent; $db = Get-Db }
if (-not $db) { throw "No se pudo crear la base D1 (el token necesita permiso D1 Edit)." }
$toml = Get-Content wrangler.toml -Raw
$toml = $toml -replace 'database_id = "[^"]*"', "database_id = `"$($db.uuid)`""
Set-Content wrangler.toml $toml -Encoding utf8
Write-Host "D1 lista: $($db.uuid)"

# Embedded Signup (conecta el numero en coexistencia con un clic). Salen de developers.facebook.com > tu app > WhatsApp.
$metaApp = Read-Host "META_APP_ID de tu app de Meta (Enter para omitir; sin esto la conexion es manual)"
$metaCfg = if ($metaApp) { Read-Host "META_CONFIG_ID (Configuracion de inicio de sesion de WhatsApp)" } else { "" }
if ($metaApp -and $metaCfg) {
  $toml = Get-Content wrangler.toml -Raw
  $toml = $toml -replace 'META_APP_ID = "[^"]*"', "META_APP_ID = `"$metaApp`""
  $toml = $toml -replace 'META_CONFIG_ID = "[^"]*"', "META_CONFIG_ID = `"$metaCfg`""
  Set-Content wrangler.toml $toml -Encoding utf8
}

Step "Almacen de fotos R2"
Wr r2 bucket create wa-agent-media
$buckets = (Wr r2 bucket list 2>$null) -join "`n"
if ($buckets -notmatch "wa-agent-media") { throw "R2 no esta activo o falta permiso. Activalo en dash.cloudflare.com > R2 y vuelve a ejecutar." }

Step "Tablas"
Wr d1 migrations apply wa-agent --remote
Check "Migraciones"

Step "Despliegue del agente (API)"
$lines = @()
Wr deploy 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable lines | Out-Host
Check "Despliegue del Worker"
$m = [regex]::Match(($lines -join "`n"), 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev')
if ($m.Success) { $apiUrl = $m.Value } else { $apiUrl = (Read-Host "Pega la URL del Worker que aparece arriba (https://...workers.dev)").Trim() }

Step "Claves de la plataforma"
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
function New-Token([int]$len) { $b = New-Object byte[] $len; $rng.GetBytes($b); (($b | ForEach-Object { "{0:x2}" -f $_ }) -join "").Substring(0, $len) }
# Al volver a ejecutar NO se regeneran las claves que ya existen: cambiar SECRETS_KEY dejaria ilegibles los tokens
# cifrados de los negocios, y cambiar SESSION_SECRET cerraria todas las sesiones.
$existing = @()
try { $existing = @((Wr secret list 2>$null) -join "`n" | ConvertFrom-Json | ForEach-Object { $_.name }) } catch { }
$secrets = @{}
foreach ($k in "SESSION_SECRET", "SECRETS_KEY") { if ($existing -notcontains $k) { $secrets[$k] = New-Token 48 } }
if ($existing -notcontains "WA_VERIFY_TOKEN") { $verify = New-Token 24; $secrets.WA_VERIFY_TOKEN = $verify } else { $verify = "(ya configurado; es el mismo de la vez anterior)" }
if ($gemini) { $secrets.GEMINI_API_KEY = $gemini }
$appSecret = Ask-Secret "Secreto de la app de Meta (WA_APP_SECRET; Enter para ponerlo despues)"
if ($appSecret) { $secrets.WA_APP_SECRET = $appSecret }
$waToken = Ask-Secret "Token de WhatsApp general (opcional: cada negocio puede poner el suyo en el CRM)"
if ($waToken) { $secrets.WA_ACCESS_TOKEN = $waToken }
$code = Ask-Secret "Codigo de invitacion para registrarse (opcional; Enter = registro abierto)"
if ($code) { $secrets.SIGNUP_CODE = $code }
$tmp = Join-Path $env:TEMP "wa-secrets.json"
if ($secrets.Count -gt 0) {
$secrets | ConvertTo-Json | Set-Content $tmp -Encoding utf8
try { Wr secret bulk $tmp; Check "Carga de claves" } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
Pop-Location

Step "CRM (Cloudflare Pages)"
Push-Location $crm
$env:VITE_API_URL = $apiUrl
npm.cmd run build
Check "Compilacion del CRM"
Wr pages project create wa-agent-crm --production-branch main   # si ya existe, avisa y sigue
Wr pages deploy dist --project-name wa-agent-crm --branch main
Check "Despliegue del CRM"
Pop-Location

Write-Host "`n==============================" -ForegroundColor Green
Write-Host "API:           $apiUrl"
Write-Host "Webhook Meta:  $apiUrl/webhook/whatsapp"
Write-Host "Token verify:  $verify   (para configurar el webhook en Meta)"
Write-Host "CRM:           la URL que mostro wrangler arriba (termina en .pages.dev)"
Write-Host "==============================`n" -ForegroundColor Green
Write-Host "Abre el CRM y pulsa 'Crear una cuenta': esa primera cuenta es la del dueno de su negocio."
Write-Host "Si no pusiste WA_APP_SECRET ahora, hazlo luego (en apps\api):  npx.cmd wrangler secret put WA_APP_SECRET"
