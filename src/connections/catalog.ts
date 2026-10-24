/**
 * What the Connections screen offers. Every entry says honestly whether it works today
 * ("available") or is planned ("coming_soon"); planned entries have no working controls.
 */
import type { RecordKind } from "../connectors/types.ts";

export type CatalogEntry = {
  type: string;
  name: string;
  category: "email" | "jobs" | "stores" | "payments" | "messaging" | "calendar" | "advanced";
  provides: RecordKind[];
  status: "available" | "coming_soon";
  auth: "oauth_google" | "form" | "none";
  reads: { es: string; en: string };
  note?: { es: string; en: string };
};

export const CATALOG: CatalogEntry[] = [
  {
    type: "gmail", name: "Gmail", category: "email", provides: ["email"], status: "available", auth: "oauth_google",
    reads: { es: "Que el correo llegó, a quién y con qué asunto.", en: "That the email arrived, to whom and with which subject." },
    note: { es: "Permiso de solo lectura (gmail.readonly). Usa un buzón de pruebas, no uno personal.", en: "Read-only permission (gmail.readonly). Use a test inbox, not a personal one." },
  },
  {
    type: "linkedin_via_email", name: "LinkedIn", category: "jobs", provides: ["email"], status: "available", auth: "none",
    reads: { es: "Cada postulación, por su correo de confirmación.", en: "Each application, through its confirmation email." },
    note: { es: "LinkedIn no ofrece una API pública para leer postulaciones. Se comprueba con los correos de confirmación: conecta Gmail.", en: "LinkedIn has no public API to read applications. It is verified through confirmation emails: connect Gmail." },
  },
  {
    type: "stripe_test", name: "Stripe (test mode)", category: "payments", provides: ["payment"], status: "available", auth: "form",
    reads: { es: "Que el cobro existe, con su monto, moneda y estado.", en: "That the charge exists, with amount, currency and status." },
    note: { es: "Solo llaves de prueba (rk_test_ o sk_test_). La referencia de la prueba debe ir en metadata.zb_ref.", en: "Test keys only (rk_test_ or sk_test_). The test reference must be in metadata.zb_ref." },
  },
  {
    type: "http_json", name: "Your own API", category: "advanced", provides: ["email", "order", "payment"], status: "available", auth: "form",
    reads: { es: "Registros de tu sistema: una URL que devuelve JSON.", en: "Records in your system: a URL that returns JSON." },
  },
  {
    type: "mcp_http", name: "MCP server", category: "advanced", provides: ["email", "order", "payment"], status: "available", auth: "form",
    reads: { es: "Cualquier conector MCP, solo con herramientas de lectura.", en: "Any MCP connector, read-only tools only." },
  },
  { type: "outlook", name: "Outlook", category: "email", provides: ["email"], status: "coming_soon", auth: "none", reads: { es: "Que el correo llegó.", en: "That the email arrived." } },
  { type: "test_inbox", name: "Test inbox service", category: "email", provides: ["email"], status: "coming_soon", auth: "none", reads: { es: "Miles de correos de prueba sin límites de Gmail.", en: "Thousands of test emails without Gmail limits." } },
  { type: "shopify", name: "Shopify", category: "stores", provides: ["order"], status: "coming_soon", auth: "none", reads: { es: "Que el pedido existe.", en: "That the order exists." } },
  { type: "slack", name: "Slack", category: "messaging", provides: [], status: "coming_soon", auth: "none", reads: { es: "Que el mensaje se publicó.", en: "That the message was posted." } },
  { type: "google_calendar", name: "Google Calendar", category: "calendar", provides: [], status: "coming_soon", auth: "none", reads: { es: "Que el evento existe.", en: "That the event exists." } },
  { type: "activepieces", name: "Activepieces catalog", category: "advanced", provides: [], status: "coming_soon", auth: "none", reads: { es: "Catálogo open source de conectores (MIT) vía MCP.", en: "Open-source connector catalog (MIT) via MCP." } },
];
