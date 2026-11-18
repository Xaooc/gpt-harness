---
name: personal-server-connect
description: >-
  Connect to the user's personal Windows Docker server (SSH alias nucbox) over SSH to
  inspect Docker state, deploy or update Docker Compose projects, wire containers to the
  private Codex connector API, manage connector credentials safely, and run authenticated
  connector smoke tests. Use this skill whenever the work involves the personal/home server,
  deploying or redeploying the RPG project (or any project) to that server, SSH access to
  nucbox or jewel-deploy, Docker Compose operations on the remote, the Codex connector, CONNECTOR_API_KEY,
  CODEX_CONNECTOR_BASE_URL, http://api:8080, the /v1/runs endpoint, the codex-connector_default
  network, or "connect an LLM through the connector" — even if the user doesn't name the server
  or the connector explicitly but clearly means "push this to my server" or "let my app call the LLM".
---

# Personal Server + Codex Connector

This skill connects to the user's personal Windows server **NucBox** running Docker Desktop, deploys
Docker Compose projects to it, and wires those projects to a private **Codex connector API**
so applications can call an LLM (Codex/GPT) over HTTP without managing model credentials
themselves. The connector holds the LLM login; clients just send prompts to `/v1/runs`.

## Security first — read before doing anything

- **Never print, log, echo, or paste the SSH private key or the connector API key into chat,
  commits, or final answers.** Credentials live in `references/credentials.local.md` (gitignored)
  and the SSH key in `/home/bro/.ssh/nucbox-from-bro`. Refer to them by path, never by value.
- The connector is **private**. Never bind it to `0.0.0.0` or expose port 4040/8080 publicly.
- **Never overwrite a remote `.env` during a deploy.** Back it up first if you must touch it.
- Client projects store the **plain** `CONNECTOR_API_KEY`; the connector stores only SHA-256
  hashes. Don't try to "sync" them by copying plaintext into the connector.
- The remote is **Windows + OpenSSH**; remote commands run under `cmd.exe`. Do not use Linux
  host commands (`chmod`, `cat`, `rm`, `ls`, `ss`, `netstat`). See `references/windows-docker.md`.

## Quick orientation

| Thing | Value |
|-------|-------|
| Remote | `nucbox` SSH alias (currently `я@192.168.1.103`, Cyrillic username) |
| Same host | `jewel-deploy` SSH alias, used by the jewel repo's ops scripts |
| SSH key | `/home/bro/.ssh/nucbox-from-bro` (ed25519) |
| Connector container | `codex-connector-api` |
| Connector path on server | `C:\deploy\codex-connector` |
| RPG project path on server | `C:\deploy\rpg` |
| Connector network | `codex-connector_default` (external) |
| Base URL from an attached container | `http://api:8080` |
| Base URL from host / SSH tunnel | `http://127.0.0.1:4040` |

## Connecting (always works the same way)

Run these commands from Linux bash. `~/.ssh/config` has `Host nucbox jewel-deploy` with
`HostName 192.168.1.103`, `User я`, `IdentityFile ~/.ssh/nucbox-from-bro`, `IdentitiesOnly yes`,
`HostKeyAlias nucbox`, and `StrictHostKeyChecking yes`. The key is provisioned and works.
`jewel-deploy` is the same host, used by the jewel repo's ops scripts.

```bash
ssh nucbox "echo ssh-ok"
ssh nucbox "docker ps --format {{.Names}}"
```

NucBox currently uses `192.168.1.103`; DHCP can change it. Find it by the `nucbox` SSH host key
recorded in `~/.ssh/known_hosts`, then update `HostName` in `~/.ssh/config`
(see `references/server-access.md`). `HostKeyAlias nucbox` makes a wrong IP fail loudly.
Keep remote commands quote-light: they still execute under the remote Windows shell.

## What to read for the task at hand

- **Connecting, key setup, tunnels, troubleshooting** → `references/server-access.md`
- **Deploying / updating a Compose project (incl. the RPG project)** → `references/deploy.md`
- **Wiring a project to the connector + the full HTTP API contract** → `references/connector-api.md`
- **Windows/cmd.exe command rules and gotchas** → `references/windows-docker.md`
- **Actual key, connector key, and hashes** → `references/credentials.local.md` (local-only, gitignored)

## Standard workflow

1. **Connect** and confirm with `echo ssh-ok`, then `docker ps`.
2. **Inspect** the target project on the server (`cd /d C:\deploy\<project> && docker compose ps`).
3. **Deploy/update** following `references/deploy.md` — pull/build, then `docker compose up -d`.
   Never clobber the remote `.env`.
4. **Wire to the connector** (if the app needs the LLM): attach the app container to
   `codex-connector_default`, set `CODEX_CONNECTOR_BASE_URL=http://api:8080` and
   `CONNECTOR_API_KEY` (see `references/connector-api.md`).
5. **Smoke test** from inside the deployed container so DNS, network, env injection, auth, and
   HTTP are all exercised together — `/healthz` then an authenticated `/v1/runs` round-trip.
6. **Report** what changed and the smoke-test result. Never include secrets in the report.
