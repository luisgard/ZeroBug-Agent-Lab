# Probar los agentes de tu equipo

ZeroBug es genérico: no necesita el código del agente, solo **cómo hablarle** y **acceso de lectura a donde deja huella**. ShopZ y los agentes de correo son ejemplos; esto es lo que se hace con un agente real.

## Lo que tu equipo necesita tener

| Qué | Por qué | Ejemplo |
| --- | --- | --- |
| Una forma de hablarle al agente | ZeroBug le manda la tarea como lo haría un usuario | Su página de chat, su API, un flujo de n8n/Flowise/Dify/Langflow, un servidor MCP |
| Un **ambiente de pruebas** | Las pruebas hacen acciones reales: nunca en producción | Tienda en modo prueba, Stripe en modo prueba, un Gmail solo para QA |
| **Acceso de solo lectura** a donde el agente deja huella | Es como ZeroBug comprueba lo que de verdad pasó | Gmail (solo lectura), una API de pedidos/pagos, Stripe test, un conector MCP |
| Que la **referencia `{ref}`** llegue al resultado | Así ZeroBug encuentra *ese* correo o *ese* reembolso entre todos | En el asunto del correo, en el destinatario (`qa+{ref}@…`), en el número de pedido o en una nota/metadato |

El último punto es el más importante. Cada corrida tiene una referencia única (por ejemplo `ZB-1A2B3C4D`). ZeroBug la pone en la tarea. Si el agente no la lleva al sistema donde actúa, ZeroBug no puede distinguir ese resultado de otros. En ese caso solo puede relacionarlo por hora y lo dice ("relacionado por ventana de tiempo, no por referencia").

## Los pasos

1. **Conexiones:** agrega los sistemas donde el agente deja huella (Gmail, una API con pagos/pedidos/correos, Stripe en modo prueba, o MCP desde *Avanzado*). Cada una debe quedar con ✓.
2. **Paso 1:** elige dónde vive el agente y pega sus datos. Pulsa *Conectar y probar*.
3. **Paso 2:** descríbelo como a una persona y escribe lo específico que quieres comprobar. Con `OPENAI_API_KEY` (sin `ZB_PLANNER=rules`), **la IA diseña las pruebas** para cualquier tipo de agente. Sin clave, las reglas básicas cubren correos, vacantes, compras, pagos y soporte/reembolsos.
4. **Paso 3:** revisa cada prueba en *Ver detalles*:
   - **Lo que le pediremos a tu agente:** ajusta la tarea a tu sistema (un pedido de prueba tuyo, un cliente de prueba, etc.). Deja el `{ref}`.
   - **Lo que esperamos:** ajusta destinatario, asunto, monto, moneda, estado, cuántos exactamente y cuánto esperar. Si dejas un campo vacío, no se revisa.
   - Marca la aprobación si la prueba hace acciones reales.
5. Elige cuántas veces correr cada prueba y pulsa **Correr**.
6. **Paso 4:** cuántas se comprobaron y por qué fallaron las demás, con "lo que dijo" junto a "lo que pasó".

## Qué puede y qué no puede comprobar hoy

- **Sí:** que llegó un correo (y cuántos), que existe un pedido, que existe un pago o reembolso (monto, moneda, estado, cuántos), que **no** hubo pago o reembolso, y que lo que el agente dice coincide con lo que pasó.
- **Aún no:** adjuntos (archivo/PDF), calendario, mensajes en Slack/WhatsApp/Teams, ni cambios en bases de datos sin una API de lectura. Si pides algo que no se puede comprobar, ZeroBug lo lista con la razón en lugar de inventar un resultado.
