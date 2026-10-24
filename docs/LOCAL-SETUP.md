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
npm test            # ~146 pruebas, sin claves ni internet
npm run test:e2e    # prueba real de dos procesos (requiere el paso opcional de Python)
```

## 4. Configuración (opcional)

Copia `.env.example` a `.env.local` y llena solo lo que uses. `.env.local` nunca se sube a git.

| Variable | Para qué |
| --- | --- |
| `OPENAI_API_KEY` | Activa el diseñador de pruebas con IA (Agents API) y el juez con Decisions API. Sin ella se usa el planificador por reglas, marcado como tal. |
| `ZB_GOOGLE_CLIENT_ID`, `ZB_GOOGLE_CLIENT_SECRET` | Botón "Entrar con Google" para conectar un Gmail de pruebas (solo lectura). Pasos en `docs/CONNECTORS.md` §4. Redirect URI: `http://127.0.0.1:3001/api/oauth/google/callback` |
| `ZB_SECRET_KEY` | Llave para cifrar credenciales (32 bytes en base64). Si no la pones, se crea `data/.zb-secret.key` solo para tu máquina. |
| `ZB_ALLOW_PRIVATE_AGENT_URLS=1` | **Solo en tu máquina**: permite probar agentes en `localhost`. Nunca en un servidor público. |

Generar una `ZB_SECRET_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## 5. Abrir la interfaz

macOS / Linux:

```bash
ZB_ALLOW_PRIVATE_AGENT_URLS=1 npm run ui
```

Windows (PowerShell):

```powershell
$env:ZB_ALLOW_PRIVATE_AGENT_URLS="1"; npm run ui
```

Abre **http://127.0.0.1:3001**. El idioma se cambia arriba a la derecha (ES / EN).

## 6. Demo completa en 5 minutos (sin cuentas ni claves)

Usa un agente de correo de ejemplo y un buzón de pruebas que vienen en el repo. En **otra terminal**:

```bash
node examples/email-agent/server.cjs
```

Luego, en la interfaz:

1. **2 · Conexiones** → *Avanzado* → **Tu propia API** → *Crear conector propio*:
   - Nombre: `Buzon QA`
   - Qué devuelve: `Correos`
   - URL: `http://127.0.0.1:3399/inbox?q={ref}`
   - Dónde está la lista: `emails`
   - Mapeo de campos: `{"id":"id","to":"to","from":"from","subject":"subject","body":"body","date":"date"}`
   - Encabezado: `Authorization` · Valor: `Bearer inbox-read-token`
   - URL para probar acceso: `http://127.0.0.1:3399/health`
   - **Guardar y probar** → debe decir **VERIFICADA**.
2. **1 · Conectar agente** → *Black-box HTTP*:
   - Chat endpoint: `http://127.0.0.1:3399/chat` (campos `message` / `reply`)
   - Version label: `v1` → *Connect & run smoke test* → *Use this agent*.
3. **3 · Diseñar pruebas**:
   - ¿Qué hace tu agente?: `Mi agente envía correos por mí a quien yo le diga.`
   - (opcional) ¿Algo específico?: `Verifica que el PDF sea el correcto.` (verás que ZeroBug te dice que eso aún no lo puede verificar).
   - **Proponer pruebas** → elige *El correo llega al destinatario correcto*, Corridas: `3` → **Correr pruebas seleccionadas**.
   - Resultado esperado: **3 PASS**, cada uno con el correo encontrado en el buzón como evidencia.
4. Repite el paso 2 con `http://127.0.0.1:3399/liar-chat` (un agente que dice "ya lo envié" sin enviarlo) y corre la misma prueba: resultado **FAIL**, con la razón.

## 7. Usar tus propias cosas

- **Tu agente**: pestaña *Black-box HTTP* (si tiene API de chat), *Browser chat* (si solo tiene página) o *External Agent / HTTP Bridge* (si tu equipo puede integrar el puente; ver `docs/HTTP-BRIDGE-CONTRACT.md`).
- **Tu Gmail de pruebas**: *Conexiones → Gmail*. Usa una cuenta solo para QA.
- **Pagos de prueba**: *Conexiones → Stripe (test mode)* con una llave `rk_test_…`.
- **Tu sistema**: *Conexiones → Tu propia API* o *Servidor MCP*.

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
| `Endpoint rejected: ... blocked private/reserved address 127.0.0.1` | Falta `ZB_ALLOW_PRIVATE_AGENT_URLS=1` al arrancar la interfaz (solo local). |
| Puerto 3000/3001 ocupado | `ZB_UI_PORT=3101 ZB_BRIDGE_PORT=3100 npm run ui` |
| "Entrar con Google" no aparece | Faltan `ZB_GOOGLE_CLIENT_ID` / `ZB_GOOGLE_CLIENT_SECRET`. Mientras, usa "Conectar con un token existente". |
| Browser chat: "Playwright is not installed" | `npx playwright install chromium` |
| En Windows, compartes la PC con otras personas | Define `ZB_SECRET_KEY` en `.env.local`: Windows no aplica permisos de "solo el dueño" al archivo `data/.zb-secret.key` como Linux/macOS. |
| La prueba tarda ~2 minutos en dar FAIL | Es correcto: espera hasta 120 s a que llegue el correo antes de concluir que no llegó. |

## 10. Subir los commits a GitHub (opcional)

El zip trae `zerobug-setup-env.bundle` con todo el historial:

```bash
git clone zerobug-setup-env.bundle -b setup-env ZeroBug-git
cd ZeroBug-git
git remote set-url origin https://github.com/luisgard/ZeroBug-Agent-Lab.git
git push -u origin setup-env
```
