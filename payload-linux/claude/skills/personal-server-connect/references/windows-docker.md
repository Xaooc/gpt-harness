# Windows / cmd.exe Remote Command Rules

Remote commands over SSH execute under **cmd.exe**, not bash. Use Windows-native syntax.

| Need | Use (Windows) | Not (Linux) |
|------|---------------|-------------|
| Make a directory | `mkdir C:\path\to\dir` | `mkdir -p` |
| Show a file | `type file` | `cat file` |
| Delete a file | `del file` | `rm file` |
| Change drive + dir | `cd /d C:\path && ...` | `cd /path` |
| List processes/ports | `docker ps --format {{.Ports}}` | `ss`, `netstat`, `lsof` |
| Set key permissions | `icacls` | `chmod` |

## Patterns

- Always `cd /d` when changing to another drive before a Compose command:
  `cd /d C:\deploy\codex-connector && docker compose ps`
- Port discovery comes from Docker, not from host network tools:
  `docker ps --format {{.Names}}:{{.Ports}}`
- Quoting is three layers deep (Linux bash → ssh → cmd.exe). Keep remote command strings simple.
  For anything with many quotes or pipes, write a `.bat`/`.cmd` on the server and run it, or pass
  the inner command to `sh -lc "..."` via `docker exec` (the container is Linux even though the
  host is Windows).

## Common remote commands

```bash
ssh nucbox "docker ps --format {{.Names}}"
ssh nucbox "cd /d C:\deploy\codex-connector && docker compose ps"
ssh nucbox "cd /d C:\deploy\codex-connector && docker compose logs --tail 30"
ssh nucbox "docker network ls"
ssh nucbox \
  "docker network inspect codex-connector_default --format {{json .Containers}}"
```

## Known Docker networks on this server (reference)

`agents-net`, `bridge`, `host`, `none`, `codex-connector_default`, `rpg_app`,
`image-crop-tool_default`, `jewel_default`, `kriminalist_default`, `openclaw_default`,
and several `assessment360_*` networks. The one that matters for connector wiring is
**`codex-connector_default`**.
