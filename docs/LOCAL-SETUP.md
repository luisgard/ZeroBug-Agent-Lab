# Levantar ZeroBug en tu máquina (Windows, macOS, Linux)

Guía paso a paso. Tiempo estimado: 10–15 minutos la primera vez.

## 1. Requisitos

| Programa | Versión | Para qué | Cómo comprobarlo |
| --- | --- | --- | --- |
| Node.js | 20 o mayor (probado con 22) | ZeroBug (motor, interfaz, pruebas) | `node -v` |
| npm | viene con Node | instalar dependencias | `npm -v` |
| Python | 3.10 o mayor (opcional) | solo para el agente de ejemplo LangGraph | `python3 --version` (Windows: `py --version`) |

## 2. Descomprimir e instalar

```bash
unzip ZeroBug-Agent-Lab.zip
cd ZeroBug-Agent-Lab
npm install
```

Opcional, para probar agentes que solo tienen página de chat (navegador automático):

```bash
npx playwright install chromium
```

Opcional, para el agente de ejemplo hecho con LangGraph:

```bash
cd examples/external-agent
python3 -m venv .venv                      # Windows: py -m venv .venv
.venv/bin/pip install -r requirements.txt  # Windows: .venv\Scripts\pip install -r requirements.txt
cd ../..
```

## 3. Comprobar que todo funciona

```bash
npm test            # ~150 pruebas, sin claves ni internet
npm run test:e2e    # prueba real de dos procesos (requiere el paso opcional de Python)
```

## 4. Abrir la interfaz

```bash
npm run ui
```

Abre **http://127.0.0.1:3001**. El idioma se cambia arriba a la derecha (ES / EN). En tu máquina ya se permiten agentes en `localhost`; no hace falta configurar nada.

La interfaz es un asistente de 4 pasos:

1. **Tu agente**: elige en la lista dónde vive y llena solo lo que esa opción pide; luego pulsa *Conectar y probar*. Opciones:
   - **Una página web con chat**: la dirección de la página.
   - **Una API propia (HTTP/JSON)**: la dirección y, si la pide, una clave. En *Opciones avanzadas*, los nombres de los campos.
   - **n8n (Chat Trigger)**, **Flowise**, **Dify**, **Langflow**: plantillas con los campos que usa cada plataforma. Solo pegas la dirección y, si la pide, la clave.
   - **API compatible con OpenAI** (OpenRouter, Ollama, LiteLLM, vLLM, Open WebUI…): dirección base, modelo y clave.
   - **Agente de OpenAI (Agents API)**: las instrucciones del agente. Requiere `OPENAI_API_KEY`.
   - **Servidor MCP**: la dirección del servidor; ZeroBug elige la herramienta que recibe mensajes (si hay varias, te deja escoger).
   - **Puente ZeroBug**: integración completa, para equipos que conectan las herramientas del agente a ZeroBug.
   - *Próximamente*: Slack, Teams, WhatsApp, Telegram, voz y protocolo A2A.

   Las claves que escribes aquí **no se guardan** en el navegador ni en disco: viven en la memoria del servidor mientras corren las pruebas.
2. **Qué hace**: descríbelo en una frase (y, si quieres, algo específico a comprobar).
3. **Pruebas**: ZeroBug propone pruebas. Si alguna necesita leer tu correo, tienda o pagos, te pide conectarlo ahí mismo. Eliges cuántas veces correr cada una.
4. **Resultados**: cuántas se comprobaron, cuáles fallaron y por qué. Cada corrida muestra "lo que dijo tu agente" junto a "lo que comprobamos".

La interfaz anterior, con todas las opciones técnicas, sigue en **http://127.0.0.1:3001/advanced**.

## 5. Demo completa en 5 minutos (sin cuentas ni claves)

Usa un agente de correo de ejemplo y un buzón de pruebas que vienen en el repo. En **otra terminal**:

```bash
node examples/email-agent/server.cjs
```

Luego, en la interfaz:

1. **Tu agente** → en *Dirección de la API* escribe `http://127.0.0.1:3399/chat` → *Conectar y probar* → *Siguiente*. (El botón *Usar el agente de ejemplo* llena la del agente de soporte ShopZ, `http://127.0.0.1:3400/agent/v1`, que se levanta con `node examples/support-agent/server.cjs`.)
2. **Qué hace** → toca el ejemplo *Envía correos por mí* → *Proponer pruebas*.
3. **Pruebas** → en la primera prueba pulsa *Conectar tu correo* → *Un buzón con API*:
   - Dirección del buzón: `http://127.0.0.1:3399/inbox?q={ref}`
   - Token de lectura: `inbox-read-token`
   - *Conectar* → las pruebas quedan en **Lista**. Elige *3* veces → *Correr*.
4. **Resultados**: esperado **6 de 6 comprobadas**, cada una con el correo encontrado en el buzón como evidencia. La prueba "sin duplicados" tarda ~1.5 min por corrida a propósito: espera para ver que no llegue un segundo correo.
5. ¿Tu agente es una página y no una API? En el paso 1 elige *Una página con chat* y usa `http://127.0.0.1:3399/page` (requiere `npx playwright install chromium`). ZeroBug encuentra solo la caja de texto y lee la respuesta.
6. El mismo agente de ejemplo también se puede probar como **Servidor MCP** (`http://127.0.0.1:3399/mcp`) o como **API compatible con OpenAI** (dirección `http://127.0.0.1:3399/v1`, modelo `mail-agent`).
7. Vuelve al paso 1 con la dirección `http://127.0.0.1:3399/liar-chat` (un agente que dice "ya lo envié" sin enviarlo): resultado **Falló**, con la razón.

Guion de demo con un **agente de soporte con IA que hace reembolsos** (v1 buena vs v2 con bugs, tienda de prueba ShopZ): [`docs/DEMO-ES.md`](DEMO-ES.md).

## 6. Configuración: qué es cada cosa y cuál importa

Copia `.env.example` a `.env.local` y llena solo lo que uses. `.env.local` nunca se sube a git.

| Qué | ¿Necesario? | Para qué |
| --- | --- | --- |
| Node.js + `npm install` + `npm run ui` | **Sí** | Es todo lo que necesitas para la demo. |
| Conectar tu correo (Gmail) | **Sí, para probar agentes reales de correo** | Es como ZeroBug ve si el correo llegó de verdad. En *Conexiones → Gmail*: con `ZB_GOOGLE_CLIENT_ID` / `ZB_GOOGLE_CLIENT_SECRET` aparece "Entrar con Google" (pasos en `docs/CONNECTORS.md` §4; redirect `http://127.0.0.1:3001/api/oauth/google/callback`); sin ellas, pega un refresh token. Usa una cuenta solo para QA. |
| `OPENAI_API_KEY` | Recomendado | La IA diseña pruebas más completas y entiende mejor lo que responde tu agente. Sin ella se usan reglas básicas (la interfaz lo indica). |
| `npx playwright install chromium` | Solo si tu agente es una **página** de chat | ZeroBug abre un navegador invisible para escribirle. |
| `ZB_SECRET_KEY` | Recomendado en Windows o PC compartida | Llave que cifra tus credenciales guardadas. Si no la pones, se crea `data/.zb-secret.key` en tu máquina. Generarla: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| Stripe (llave `rk_test_…`) | Opcional | Comprobar cobros de prueba. |
| Python | Opcional | Solo para el agente de ejemplo LangGraph. |
| `ZB_UI_PORT`, `ZB_BRIDGE_PORT` | Opcional | Cambiar puertos si 3001/3000 están ocupados. |
| `ZB_DEPLOYMENT=public` | Solo en un servidor público | Bloquea agentes en `localhost`/redes privadas (protección). En tu máquina no lo pongas. |
| `ZB_SOURCES_FILE`, `ZB_AGENT_TOKEN`, `ZB_VERIFIER_READ_TOKEN`, `ZB_JUDGE`, `ZB_AGENTS_MODEL`, `ZB_MAX_CONCURRENT_RUNS`, `ZB_DATA_DIR`, `ZB_CONNECTIONS_FILE` | No (uso técnico) | Para la terminal, pruebas automáticas o despliegues. La interfaz no los necesita. |

## 7. Usar tus propias cosas

- **Tu agente**: paso 1 del asistente (*Una página con chat* o *Una API*). Si tu equipo puede integrar el puente HTTP, usa */advanced* (ver `docs/HTTP-BRIDGE-CONTRACT.md`).
- **Tu Gmail de pruebas, Stripe de prueba o un buzón con API**: *Conexiones → Agregar conexión*.
- **Tu propia API o un servidor MCP**: */advanced → Conexiones*.

## 8. Otros comandos útiles

| Comando | Qué hace |
| --- | --- |
| `npm run zb -- scenarios` | Lista los escenarios incluidos |
| `npm run zb -- run --agent scripted-v2 --scenario store-outage` | Corre un escenario desde la terminal |
| `npm run zb -- sources` | Prueba el acceso a las fuentes de `zerobug.sources.json` |
| `npm run demo:external` | Demo de dos procesos con el agente LangGraph (requiere Python) |
| `npm run proof` | Prueba real de la API de OpenAI (requiere `OPENAI_API_KEY`) |

## 9. Problemas comunes

| Síntoma | Solución |
| --- | --- |
| `Endpoint rejected: ... blocked private/reserved address 127.0.0.1` | Tienes `ZB_DEPLOYMENT=public` puesto. Quítalo en tu máquina. |
| Puerto 3000/3001 ocupado | `ZB_UI_PORT=3101 ZB_BRIDGE_PORT=3100 npm run ui` |
| "Entrar con Google" no aparece | Faltan `ZB_GOOGLE_CLIENT_ID` / `ZB_GOOGLE_CLIENT_SECRET`. Mientras, usa "Conectar con un token existente". |
| Página de chat: "Playwright is not installed" | `npx playwright install chromium` |
| En Windows, compartes la PC con otras personas | Define `ZB_SECRET_KEY` en `.env.local`: Windows no aplica permisos de "solo el dueño" al archivo `data/.zb-secret.key` como Linux/macOS. |
| Una prueba tarda 1–2 minutos | Es correcto: espera a que llegue el correo antes de concluir que no llegó, y la de "sin duplicados" espera para ver que no llegue otro. |

## 10. Subir los commits a GitHub (opcional)

El zip trae `zerobug-setup-env.bundle` con todo el historial:

```bash
git clone zerobug-setup-env.bundle -b setup-env ZeroBug-git
cd ZeroBug-git
git remote set-url origin https://github.com/luisgard/ZeroBug-Agent-Lab.git
git push -u origin setup-env
```
