# Evidence Connectors — verifying real side effects

An agent says "I sent the email" or "I bought it". ZeroBug checks the **real system** where that action should have landed: the recipient's Gmail inbox, the store's order API, the payment provider in test mode, or any MCP connector. ZeroBug reads these systems **directly, read-only, with no AI in between**, so what it finds is evidence, not an opinion.

## 1. How it works

1. Every run gets a short reference, for example `ZB-1A2B3C4D`. The scenario task contains `{ref}`, and ZeroBug replaces it before sending the task, e.g. *"Send the email with subject 'ZeroBug delivery test ZB-1A2B3C4D'"*.
2. The agent acts in the real world (sends the email, places the order).
3. ZeroBug polls the configured source until the record with that reference appears, or the wait time ends.
4. The check passes only if a record matches **every** condition: recipient, subject, product, amount… and carries this run's reference. That way an old or unrelated email never counts.
5. If the source cannot be read (wrong credentials, outage), the result is **INCONCLUSIVE**. ZeroBug never assumes "not found" from a failed read.

## 2. Check types

| Check | Fields | Source must provide |
| --- | --- | --- |
| `email_received` | `source`, `to`, `subjectContains`, `bodyContains`, `fromContains`, `requireRef` (default true), `waitSeconds` (default 60) | email |
| `order_exists` | `source`, `productContains`, `quantity`, `maxTotal`, `status`, `requireRef`, `waitSeconds` (default 30) | order |
| `payment_exists` | `source`, `amount` (in the source's units, e.g. cents for Stripe), `currency`, `status`, `requireRef`, `waitSeconds` | payment |

These checks work with **every** agent transport: bridge, black-box HTTP, browser chat, Agents API and scripted agents. A scenario whose checks require the reference is rejected if its task has no `{ref}`.

Templates: `scenarios/real-email-delivery.yaml`, `scenarios/real-purchase.yaml`.

## 3. Sources (`zerobug.sources.json`)

Copy `zerobug.sources.example.json` to `zerobug.sources.json` (git-ignored). The file contains only **names** of environment variables; secret values go in `.env.local` or the server environment.

| Kind | For | Notes |
| --- | --- | --- |
| `gmail` | A Gmail / Google Workspace inbox | Official Gmail API v1, OAuth refresh token, scope `gmail.readonly`. Only GET requests to Gmail. |
| `http_json` | Store order APIs, Stripe (test mode), any JSON API | GET only, HTTPS required (except localhost), redirects refused; you map fields with paths like `metadata.zb_ref`. |
| `mcp` | Any MCP connector (Outlook, Shopify, Stripe, Slack…) | ZeroBug is an MCP client. Only tools in `allowTools` can be called, and tools whose names look state-changing (`send`, `delete`, `create`, `update`, `pay`…) are refused at startup. Results are parsed as JSON with field paths, or as text (stricter matching). |

Prove access before testing:

```bash
npm run zb -- sources
#   VERIFIED    qa-inbox   gmail   provides email   read access to zerobug-qa@… confirmed (Gmail API profile)
```

A source's state follows the same rule as agent capabilities: **VERIFIED** only after a real authenticated read.

## 4. Gmail setup (one time, about 10 minutes)

Use a **dedicated QA account**, never a personal or customer inbox.

1. Create a Gmail account for testing, e.g. `zerobug-qa@…`.
2. In Google Cloud Console: create a project → *APIs & Services* → enable **Gmail API**.
3. *OAuth consent screen*: type External (or Internal for Workspace), add the QA account as a test user, add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. *Credentials* → *Create credentials* → *OAuth client ID* → type **Desktop app**. Keep the client ID and client secret.
5. Get a refresh token for the QA account with that client and the `gmail.readonly` scope (for example with Google's OAuth 2.0 Playground: gear icon → "Use your own OAuth credentials", select the Gmail API v1 `gmail.readonly` scope, authorize as the QA account, exchange the code for tokens).
6. Put the three values in `.env.local`:

   ```
   ZB_GMAIL_CLIENT_ID=...
   ZB_GMAIL_CLIENT_SECRET=...
   ZB_GMAIL_REFRESH_TOKEN=...
   ```

7. `cp zerobug.sources.example.json zerobug.sources.json` (keep the `qa-inbox` entry), then `npm run zb -- sources`.

## 5. Running a real third-party agent

```bash
# Agent with an HTTP chat API
npm run zb -- run --agent blackbox --endpoint https://vendor.example/api/chat \
  --task-field message --response-field reply --scenario real-email-delivery

# Agent that only has a web chat page (headless browser)
npm run zb -- run --agent browser --endpoint https://vendor.example/chat \
  --input-selector "textarea" --send-selector "button[type=submit]" --reply-selector ".assistant-message" \
  --scenario real-email-delivery
```

Edit the recipient address in the scenario to your QA inbox first.

## 6. What has and has not been validated

| Piece | Validation in this repository |
| --- | --- |
| Gmail connector | Contract test against the documented Gmail API v1 response shapes (`tests/connectors.test.ts`). The Gmail API endpoint is reachable from the build environment. **Not yet run against a real Gmail account** (no credentials available). |
| HTTP JSON connector | Real HTTP against a local server with a Stripe-like response shape. Not run against Stripe or a real store. |
| MCP connector | Real MCP protocol (official SDK server and client, in-memory transport), allow-list and write-tool refusal. Not run against a third-party MCP server with a real account. |
| Browser chat runner | Real headless Chromium against a local chat page that streams its answer; SSRF checks on every page request. Not run against a third-party chat site. |
| Engine integration | Black-box HTTP agent and browser agent → connector check → PASS when the record exists, FAIL when the agent only claims it, INCONCLUSIVE without a source. |

The first real validation needs: a QA Gmail account with the OAuth values above, and the URL of a third-party agent that can send email.
