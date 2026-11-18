# Codex Connector API

The connector is a private HTTP service that runs Codex/GPT runs on behalf of client apps.
A client sends a prompt; the connector queues a run, executes it with the LLM credentials it
holds internally, and returns the final answer. Clients never need their own model key — they
only need the `CONNECTOR_API_KEY` bearer token.

## Topology

| Caller location | Base URL | Notes |
|-----------------|----------|-------|
| Container attached to `codex-connector_default` | `http://api:8080` | Preferred for deployed apps. If `api` DNS conflicts, use `http://codex-connector-api:8080`. |
| Server host / SSH tunnel | `http://127.0.0.1:4040` | Published bind is `127.0.0.1:4040:8080`. |

- API container: `codex-connector-api`
- Compose project path on server: `C:\deploy\codex-connector`
- Compose services: `api`, `telegram-bot`
- Network: `codex-connector_default` (external, shared with client projects)

## Auth

All `/v1/*` calls require `Authorization: Bearer <CONNECTOR_API_KEY>`. **Never** put the key in
a URL or query string. The client holds the plain key; the connector stores only SHA-256 hashes
in its `CONNECTOR_API_KEY_HASHES` env var. The plain key + its hash are in
`references/credentials.local.md`.

## Endpoints

Unauthenticated:
- `GET /healthz` → server health, usually `{ "status": "ok" }`.
- `GET /readyz` → Codex CLI login readiness.

Authenticated (bearer token):
- `POST /v1/runs` → creates a queued run, returns **HTTP 202** with `{ "id": "...", "status": "queued" }`.
- `GET /v1/runs/:id` → status, `finalAnswer`, usage, artifacts, recent events.
- `GET /v1/runs/:id/events?after=<eventId>` → SSE event stream.
- `GET /v1/runs/:id/artifacts/:artifactId` → download a binary artifact.
- `DELETE /v1/runs/:id` → cancel queued/running work.

Run status values: `queued`, `running`, `completed`, `failed`, `cancelled`.

## POST /v1/runs fields

- `prompt` — required string, max 200000 chars.
- `mode` — `text` or `image_generation`, default `text`.
- `systemPrompt` — optional system block.
- `toolPrompt` — optional text-only tool description (no callback bridge).
- `context` — optional history array, max 250 entries, roles `user` / `assistant`.
- `model` — optional, passed to `codex exec --model`.
- `reasoningEffort` — `none` | `low` | `medium` | `high` | `xhigh`.
- `timeoutSeconds` — normalized to 1..3600, default 300.
- `allowWebSearch` — boolean; runs Codex with web search when true.
- `outputSchema` — JSON Schema for strict structured output.
- `images` — up to 4 images, max 8 MB raw each; jpeg/png/webp/gif.
- `temperature`, `topP` — accepted and stored; current CLI runner may not forward them.

Minimal payload:

```json
{ "prompt": "Return exactly: connector-ok", "timeoutSeconds": 120, "reasoningEffort": "low" }
```

## Wiring a client project (Docker Compose)

Add the app to the connector network and inject the env. Keep this in the client's own Compose
project — do not edit the connector's Compose.

```yaml
services:
  app:
    environment:
      CODEX_CONNECTOR_BASE_URL: http://api:8080
      CONNECTOR_API_KEY: ${CONNECTOR_API_KEY}
    networks:
      - default
      - codex-connector

networks:
  codex-connector:
    external: true
    name: codex-connector_default
```

Put `CONNECTOR_API_KEY=<plain key>` in the client project's local `.env` on the server (never
commit it). If `api` DNS resolution fails inside the container, switch the base URL to
`http://codex-connector-api:8080` and re-test.

## Smoke test from inside a deployed client container

Run after deploy so DNS, network, env injection, auth, and HTTP are all tested together:

```bash
ssh nucbox \
  "docker exec <client-container> sh -lc \"curl -fsS http://api:8080/healthz\""
```

Authenticated create-and-poll (run inside the container, where `CONNECTOR_API_KEY` is set):

```sh
set -eu
id=$(curl -fsS http://api:8080/v1/runs \
  -H "Authorization: Bearer $CONNECTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Return exactly: connector-ok","timeoutSeconds":120,"reasoningEffort":"low"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
test -n "$id"
for i in $(seq 1 90); do
  body=$(curl -fsS -H "Authorization: Bearer $CONNECTOR_API_KEY" "http://api:8080/v1/runs/$id")
  echo "$body" | grep -q '"status":"completed"' && exit 0
  echo "$body" | grep -Eq '"status":"(failed|cancelled)"' && exit 1
  sleep 2
done
exit 1
```

## Minimal JavaScript client

```js
const baseUrl = process.env.CODEX_CONNECTOR_BASE_URL || "http://api:8080";
const apiKey = process.env.CONNECTOR_API_KEY;

async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export async function runCodex(prompt, options = {}) {
  const created = await requestJson("/v1/runs", {
    method: "POST",
    body: JSON.stringify({ prompt, ...options }),
  });
  const deadline = Date.now() + ((options.timeoutSeconds || 120) * 1000) + 5000;
  while (Date.now() < deadline) {
    const run = await requestJson(`/v1/runs/${encodeURIComponent(created.id)}`);
    if (run.status === "completed") return run.finalAnswer || "";
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(run.error || `Connector run ${run.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await requestJson(`/v1/runs/${encodeURIComponent(created.id)}`, { method: "DELETE" }).catch(() => {});
  throw new Error("Connector run timed out");
}
```
