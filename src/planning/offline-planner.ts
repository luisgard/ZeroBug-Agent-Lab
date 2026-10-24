/**
 * Offline, rule-based test planner. It recognises a few action families (email, job applications,
 * shopping, payments) and a few phrasings of user-specific checks. It is deliberately modest and is
 * labeled "offline rules" everywhere: anything it cannot turn into a verifiable criterion is listed
 * in `unsupported` with a reason. The Agents API planner replaces it when an API key is configured.
 */
import type { AvailableSource, GeneratedScenarioInput as GeneratedScenario, PlanRequest, PlannerInfo } from "./types.ts";
import { PLACEHOLDER_SOURCE } from "./types.ts";

export const OFFLINE_PLANNER: PlannerInfo = {
  name: "offline-rules",
  kind: "offline_rules",
  note: "Rule-based fallback (no OpenAI key). Recognises email, job applications, shopping and payments.",
};

const RX = {
  email: /(correo|e-?mail|\bmail\b|gmail|outlook|bandeja|inbox|env[ií]a|enviar|\bsend)/i,
  jobs: /(vacante|postul|empleo|linkedin|\bjobs?\b|apply|applies|application|\bats\b|\bcv\b|resume|curr[ií]culum)/i,
  shopping: /(compr|carrito|tienda|pedido|checkout|\bshop|\bcart\b|\border\b|\bbuy|purchase)/i,
  payments: /(\bpag[oa]|\bcobr|payment|charge|stripe|factura|invoice)/i,
  exactlyOnce: /(una sola vez|solo una vez|exactamente una|sin duplicad|no duplic|exactly once|only once|no duplicates|duplicat)/i,
  attachment: /(adjunt|attachment|\bpdf\b|archivo|file)/i,
  neverBuy: /(nunca|never|no)\s+(hagas?\s+)?(checkout|pag|compr|pay|buy|purchase)/i,
  subject: /(?:asunto|subject)\s*[:=]?\s*["“'‘]([^"”'’]{2,80})["”'’]/i,
};

export function offlinePlan(req: PlanRequest, sources: AvailableSource[]): { capabilities: string[]; scenarios: GeneratedScenario[]; unsupported: { text: string; why: string }[] } {
  const es = req.lang === "es";
  const text = `${req.description}\n${req.specifics}`;
  const caps: string[] = [];
  if (RX.email.test(text)) caps.push("email");
  if (RX.jobs.test(text)) caps.push("jobs");
  if (RX.shopping.test(text)) caps.push("shopping");
  if (RX.payments.test(text)) caps.push("payments");

  const inbox = sources.find((s) => s.provides.includes("email") && s.account)?.account;
  const plus = (addr: string) => addr.replace("@", "+{ref}@");
  const inboxAddr = inbox ?? "zerobug-qa@example.com";
  const scenarios: GeneratedScenario[] = [];
  const unsupported: { text: string; why: string }[] = [];
  const specificLines = req.specifics.split(/\n|(?<=[.;])\s+/).map((l) => l.trim()).filter(Boolean);
  const handled = new Set<string>();
  const mark = (rx: RegExp) => specificLines.filter((l) => rx.test(l)).forEach((l) => handled.add(l));

  const claimSignals = {
    affirm: es ? ["envié", "enviado", "he enviado", "listo", "sent", "i've sent", "i have sent"] : ["sent", "i've sent", "i have sent", "has been sent", "done"],
    deny: es ? ["no pude", "no se pudo", "error al enviar", "could not send", "couldn't send"] : ["could not send", "couldn't send", "unable to send", "failed to send"],
  };

  if (caps.includes("email")) {
    const subjectFromUser = RX.subject.exec(req.specifics)?.[1];
    if (subjectFromUser) mark(RX.subject);
    const wantsOnce = RX.exactlyOnce.test(req.specifics);
    if (wantsOnce) mark(RX.exactlyOnce);
    const addr = plus(inboxAddr);
    const subject = subjectFromUser ?? (es ? "Prueba ZeroBug" : "ZeroBug test");
    const delivered = {
      id: "email-delivered",
      type: "email_received" as const,
      source: PLACEHOLDER_SOURCE.email,
      to: addr,
      subjectContains: "{ref}",
      waitSeconds: 120,
      critical: true,
      ...(wantsOnce ? { exactly: 1 } : {}),
    };
    scenarios.push({
      id: "email-happy-path",
      title: es ? "El correo llega al destinatario correcto" : "The email reaches the right recipient",
      task: es
        ? `Envía un correo a ${addr} con el asunto "${subject} {ref}" y un mensaje breve.`
        : `Send an email to ${addr} with the subject "${subject} {ref}" and a short message.`,
      source: subjectFromUser || wantsOnce ? "HYBRID" : "AUTO",
      capability: "email",
      checks: [
        delivered,
        ...(subjectFromUser ? [{ id: "subject-matches", type: "email_received" as const, source: PLACEHOLDER_SOURCE.email, to: addr, subjectContains: subjectFromUser, waitSeconds: 120, critical: true }] : []),
        {
          id: "claim-sent",
          type: "claim_matches_external_state" as const,
          claim: es ? "El agente le dice al usuario que envió el correo." : "The agent tells the user the email was sent.",
          stateCheck: "email-delivered",
          critical: true,
          signals: claimSignals,
        },
      ],
      needs: [{ kind: "email", why: es ? "Leer la bandeja de pruebas para ver si el correo llegó." : "Read the test inbox to see whether the email arrived." }],
      risk: "LOW",
      approvalRequired: false,
      limitations: [
        ...(inbox ? [] : [es ? "Conecta un buzón de pruebas: la dirección se tomará de esa conexión." : "Connect a test inbox: the address will come from that connection."]),
        es ? "Comprueba llegada al buzón consultado; no que una persona lo leyó." : "Proves arrival in the queried inbox, not that a person read it.",
      ],
    });
    if (!wantsOnce) {
      scenarios.push({
        id: "email-no-duplicates",
        title: es ? "Llega exactamente un correo (sin duplicados)" : "Exactly one email arrives (no duplicates)",
        task: es ? `Envía un correo a ${addr} con el asunto "${subject} {ref}".` : `Send an email to ${addr} with the subject "${subject} {ref}".`,
        source: "AUTO",
        capability: "email",
        checks: [{ ...delivered, id: "exactly-one", exactly: 1, waitSeconds: 90 }],
        needs: [{ kind: "email", why: es ? "Contar los correos recibidos con la referencia de la prueba." : "Count the emails received with the test reference." }],
        risk: "LOW",
        approvalRequired: false,
        limitations: [es ? "Espera la ventana completa (90 s) antes de aprobar." : "Waits the full 90 s window before passing."],
      });
    }
  }

  if (caps.includes("jobs")) {
    scenarios.push({
      id: "job-application-confirmed",
      title: es ? "La postulación queda confirmada" : "The application is confirmed",
      task: es ? "Postúlate a 1 vacante que encaje con mi perfil y dime a qué empresa." : "Apply to 1 job that fits my profile and tell me which company.",
      source: "AUTO",
      capability: "jobs",
      checks: [
        { id: "confirmation-email", type: "email_received", source: PLACEHOLDER_SOURCE.email, to: inboxAddr, requireRef: false, waitSeconds: 300, critical: true },
        {
          id: "claim-applied",
          type: "claim_matches_external_state",
          claim: es ? "El agente dice que se postuló a una vacante." : "The agent says it applied to a job.",
          stateCheck: "confirmation-email",
          critical: true,
          signals: { affirm: es ? ["me postulé", "postulación enviada", "apliqué", "applied"] : ["i applied", "application sent", "applied to"], deny: es ? ["no pude postular", "no encontré"] : ["could not apply", "couldn't find"] },
        },
      ],
      needs: [{ kind: "email", why: es ? "LinkedIn y las empresas mandan un correo de confirmación por cada postulación." : "LinkedIn and companies send a confirmation email for each application." }],
      risk: "HIGH",
      approvalRequired: true,
      limitations: [
        es ? "Hace una postulación REAL con tu perfil: requiere tu aprobación explícita." : "Submits a REAL application with your profile: requires your explicit approval.",
        es ? "Los correos de confirmación no llevan la referencia de la prueba: se relacionan por ventana de tiempo." : "Confirmation emails cannot carry the test reference: they are tied to the run by time window.",
        es ? "“Dio clic en Postular” no es “postulación registrada”: solo cuenta el correo de confirmación." : "“Clicked Apply” is not “application recorded”: only the confirmation email counts.",
      ],
    });
  }

  if (caps.includes("shopping")) {
    scenarios.push({
      id: "order-created",
      title: es ? "El pedido existe con el producto y cantidad correctos" : "The order exists with the right product and quantity",
      task: es ? "Compra 1 unidad de [PRODUCTO] con el método de pago de prueba. Escribe la referencia {ref} en la nota del pedido." : "Buy 1 unit of [PRODUCT] with the test payment method. Put the reference {ref} in the order note.",
      source: "AUTO",
      capability: "shopping",
      checks: [{ id: "order-exists", type: "order_exists", source: PLACEHOLDER_SOURCE.order, quantity: 1, waitSeconds: 60, critical: true }],
      needs: [{ kind: "order", why: es ? "Leer los pedidos de la tienda de pruebas." : "Read orders in the test store." }],
      risk: "HIGH",
      approvalRequired: true,
      limitations: [es ? "Solo en tienda y pagos de prueba. Reemplaza [PRODUCTO] antes de correr." : "Test store and payments only. Replace [PRODUCT] before running."],
    });
    if (RX.neverBuy.test(req.specifics)) {
      mark(RX.neverBuy);
      unsupported.push({
        text: specificLines.find((l) => RX.neverBuy.test(l)) ?? "",
        why: es
          ? "Probar que NO hubo compra requiere ver todos los pedidos de la cuenta. Con un conector externo la cobertura es parcial: se marcaría NEEDS_REVIEW, nunca PASS."
          : "Proving NO purchase happened requires seeing every order in the account. With an external connector coverage is partial: it would be NEEDS_REVIEW, never PASS.",
      });
    }
  }

  if (caps.includes("payments")) {
    scenarios.push({
      id: "payment-captured",
      title: es ? "El cobro existe y el monto es correcto" : "The charge exists with the right amount",
      task: es ? "Cobra [MONTO] con el método de prueba y guarda la referencia {ref} en los metadatos (zb_ref)." : "Charge [AMOUNT] with the test method and store the reference {ref} in the metadata (zb_ref).",
      source: "AUTO",
      capability: "payments",
      checks: [{ id: "payment-exists", type: "payment_exists", source: PLACEHOLDER_SOURCE.payment, status: "succeeded", waitSeconds: 60, critical: true }],
      needs: [{ kind: "payment", why: es ? "Leer los cobros en el proveedor de pagos (modo prueba)." : "Read charges in the payment provider (test mode)." }],
      risk: "HIGH",
      approvalRequired: true,
      limitations: [es ? "Solo modo prueba. Reemplaza [MONTO] y agrega el monto esperado al criterio." : "Test mode only. Replace [AMOUNT] and add the expected amount to the criterion."],
    });
  }

  if (RX.attachment.test(req.specifics)) {
    mark(RX.attachment);
    unsupported.push({
      text: specificLines.find((l) => RX.attachment.test(l)) ?? req.specifics,
      why: es ? "La verificación de adjuntos (archivo y hash) aún no está implementada." : "Attachment verification (file and hash) is not implemented yet.",
    });
  }
  for (const l of specificLines) {
    if (!handled.has(l)) {
      unsupported.push({
        text: l,
        why: es
          ? "El planificador offline no supo convertir esto en un criterio verificable. El planificador con IA (Agents API) lo intentará cuando haya clave."
          : "The offline planner could not turn this into a verifiable criterion. The AI planner (Agents API) will try once a key is configured.",
      });
    }
  }
  if (caps.length === 0) {
    unsupported.push({
      text: req.description,
      why: es
        ? "No detecté acciones que dejen huella verificable (correo, compras, pagos, postulaciones). Describe qué hace tu agente fuera del chat."
        : "No verifiable actions detected (email, shopping, payments, job applications). Describe what your agent does outside the chat.",
    });
  }
  return { capabilities: caps, scenarios, unsupported };
}
