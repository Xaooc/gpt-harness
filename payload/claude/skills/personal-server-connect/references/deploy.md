# Deploying & Updating Compose Projects

Each project lives in its own directory under `C:\deploy\` on the server and is a self-contained
Docker Compose project. Deploy = get the latest code/image onto the server, then
`docker compose up -d`. The golden rule: **never overwrite a project's remote `.env`** — it holds
credentials the running stack depends on. Back it up before any intentional change.

## Generic deploy / update flow

```bash
# 1. See current state
ssh nucbox "cd /d C:\deploy\<project> && docker compose ps"

# 2. Get latest code (pick the one that matches how the project is delivered)
# If the server has the git checkout:
ssh nucbox "cd /d C:\deploy\<project> && git pull"
#   ...or copy build artifacts up with scp -O "<local>" "nucbox:C:/deploy/<project>/..."

# 3. Rebuild + restart (only the changed services rebuild)
ssh nucbox "cd /d C:\deploy\<project> && docker compose up -d --build"

# 4. Verify
ssh nucbox "cd /d C:\deploy\<project> && docker compose ps"
ssh nucbox "cd /d C:\deploy\<project> && docker compose logs --tail 40"
```

For image-based deploys (no build context on server): `docker compose pull` then
`docker compose up -d`.

## .env safety

```bash
# Back up before touching it, and only touch it for deliberate credential maintenance
ssh nucbox "cd /d C:\deploy\<project> && copy .env .env.bak"
```

Do not regenerate or template `.env` as part of a routine code deploy. If a deploy needs a new
variable, append it explicitly and tell the user what you added (never echo secret values).

## The RPG project

- Path on server: `C:\deploy\rpg`
- Running containers: `rpg-backend-1`, `rpg-frontend-1`, `rpg-rpg-admin-1`
- Published ports (from project memory): player app `8088 -> frontend:80`,
  admin app `8100 -> rpg-admin:8100`
- Project network: `rpg_app`

To let the RPG backend call the LLM through the connector, treat it as a client project:
attach `rpg-backend` to `codex-connector_default`, set `CODEX_CONNECTOR_BASE_URL=http://api:8080`
and `CONNECTOR_API_KEY` (from the project `.env`), then run the connector smoke test from inside
`rpg-backend-1`. See `connector-api.md` for the exact Compose snippet and smoke test. This is the
multi-model OpenRouter path's internal-mode alternative — the app sends prompts to the connector
instead of calling OpenRouter directly.

```bash
# Inspect, deploy, verify the RPG stack
ssh nucbox "cd /d C:\deploy\rpg && docker compose ps"
ssh nucbox "cd /d C:\deploy\rpg && docker compose up -d --build"
ssh nucbox "cd /d C:\deploy\rpg && docker compose logs --tail 40 rpg-backend"
```

## Live snapshot (containers seen at skill creation)

Connector + RPG were both healthy: `codex-connector-api`, `codex-telegram-bot`,
`rpg-backend-1`, `rpg-frontend-1`, `rpg-rpg-admin-1` (alongside unrelated `jewel-*`,
`assessment360-*`, `kriminalist-web`, `image-crop-tool`). Use a fresh `docker ps` each session —
this list drifts.
