# Guion de demo (10 minutos)

Mensaje central: **"Tu agente dice que lo hizo. ZeroBug comprueba si de verdad pasó, y cuántas veces de cada 10."**

## Antes de empezar (una vez)

1. `.env.local` con `OPENAI_API_KEY=...` (ver `docs/LOCAL-SETUP.md` §6).
2. Dos ventanas de PowerShell en la carpeta del proyecto:
   - Ventana 1: `node examples/email-agent/server.cjs` (agentes de ejemplo + buzón de pruebas)
   - Ventana 2: `npm run ui` → abre http://127.0.0.1:3001
3. Conecta el buzón una sola vez: *Conexiones → Agregar conexión → Un buzón con API*:
   - Dirección: `http://127.0.0.1:3399/inbox?q={ref}`
   - Token: `inbox-read-token`

## Los agentes de ejemplo

| Dirección | Qué es | Resultado esperado |
| --- | --- | --- |
| `http://127.0.0.1:3399/ai/v1` | Agente **con IA real** (tu clave de OpenAI) que envía correos con una herramienta | Casi todo comprobado |
| `http://127.0.0.1:3399/ai/v2` | La "nueva versión" del mismo agente, con 2 bugs: a veces escribe mal el destinatario, a veces manda el correo dos veces. **Siempre dice que funcionó.** | "Llega al destinatario": falla ~3 de cada 10. "Sin duplicados": falla ~6 de cada 10 |
| `http://127.0.0.1:3399/liar-chat` | Dice "ya lo envié" y nunca envía nada | Todo falla |
| `/ai/v1/page`, `/ai/v2/page`, `/page` | Los mismos agentes como página de chat (opción "Una página web con chat") | Igual que arriba |
| `/mcp`, `/v1` (modelo `mail-agent`) | El agente sin IA expuesto como servidor MCP o API compatible con OpenAI | Todo comprobado |

## La demo

1. **El problema (1 min).** Abre `http://127.0.0.1:3399/ai/v2/page`, pídele "Envía un correo a ana@example.com con el asunto \"Hola\"". Responde "Listo, lo envié". *¿Le crees?*
2. **v1 (3 min).** Paso 1: *Una API propia* → `http://127.0.0.1:3399/ai/v1`, versión `v1` → *Conectar y probar*. Paso 2: ejemplo *Envía correos por mí* → *Proponer pruebas*. Paso 3: deja las 2 pruebas, **10 veces** → *Correr*. Resultado: todo verde, cada corrida con el correo encontrado en el buzón.
3. **v2 (3 min).** Repite con `http://127.0.0.1:3399/ai/v2`, versión `v2`. Resultado: varias en rojo. Abre una: *"Lo que dijo tu agente: Listo, envié el correo…"* vs *"Lo que comprobamos: el correo no llegó; el más parecido iba a …@mail.example.com"*. En otra: *"2 correos, se esperaba exactamente 1 (duplicados)"*.
4. **El cierre (1 min).** "Con 1 sola prueba la v2 habría pasado casi siempre. Con 10, ZeroBug muestra cuántas veces falla y por qué, con evidencia. Y no necesitamos su código: solo cómo hablarle, y acceso de lectura a donde deja huella."
5. **Bonus.** Muestra la lista *¿Dónde vive tu agente?* (n8n, Flowise, Dify, Langflow, MCP, OpenAI…) y *Conexiones* (Gmail real, Stripe de prueba).

Tiempo: la prueba "sin duplicados" espera 90 s por corrida a propósito (para ver que no llegue un segundo correo). Las corridas van de 5 en 5 (`ZB_PARALLEL_RUNS`), así que 10 corridas de cada prueba tardan unos 3 minutos. Para una demo más rápida, apaga esa prueba en el paso 3.

Si el agente IA responde "Error del modelo…", el modelo por defecto (`gpt-4o-mini`) no está disponible para tu clave: agrega `ZB_DEMO_MODEL=<un modelo de tu cuenta>` a `.env.local` y reinicia la ventana 1.
