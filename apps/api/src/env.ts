export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  IMAGES: ImagesBinding;
  /** Meta (una app de la plataforma para todos los tenants). */
  WA_VERIFY_TOKEN: string;
  WA_APP_SECRET: string;
  /** Token de WhatsApp por defecto; cada tenant puede guardar el suyo en el CRM. */
  WA_ACCESS_TOKEN?: string;
  /** Clave de Gemini por defecto; cada tenant puede guardar la suya. */
  GEMINI_API_KEY?: string;
  /** Firma las sesiones del CRM (≥ 32 caracteres aleatorios). */
  SESSION_SECRET: string;
  /** Cifra los secretos guardados en D1 (tokens de WhatsApp, claves de plugins). Si falta se usa SESSION_SECRET. */
  SECRETS_KEY?: string;
  /** "false" cierra el registro público. Por defecto abierto. */
  ALLOW_SIGNUP?: string;
  /** Si existe, el registro exige este código de invitación. */
  SIGNUP_CODE?: string;
  /** Opcional: URL pública de las fotos. Por defecto se usa la del propio Worker + /media. */
  MEDIA_PUBLIC_URL?: string;
}
