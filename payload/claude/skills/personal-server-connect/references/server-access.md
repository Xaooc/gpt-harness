# Server Access

## Identity

- Host: NucBox, currently `192.168.1.103` (DHCP; may drift).
- User: `я` (single Cyrillic character — works as-is from Linux ssh).
- SSH aliases: `nucbox` and `jewel-deploy` (the same host; jewel repo ops scripts use `jewel-deploy`).
- Remote OS: Windows with Docker Desktop (Linux containers). SSH shell is `cmd.exe`.
- Client: Linux bash on bro-server.
- SSH key: `/home/bro/.ssh/nucbox-from-bro`, provisioned and working.
- `~/.ssh/config`: `Host nucbox jewel-deploy`, `HostName 192.168.1.103`, `User я`,
  `IdentityFile ~/.ssh/nucbox-from-bro`, `IdentitiesOnly yes`, `HostKeyAlias nucbox`,
  `StrictHostKeyChecking yes`. Use `ssh nucbox` and `scp … nucbox:`; the config supplies identity and checking.

The key must be owned by the current user and private (`chmod 600` if needed).
Do not copy or print credentials; refer to `credentials.local.md` when authorized.

## Finding NucBox after DHCP changes

Identify NucBox by its recorded SSH host key, never just its IP. Inspect the stored public
key with `ssh-keygen -F nucbox -f ~/.ssh/known_hosts` (`HostKeyAlias nucbox`).
Scan the LAN for that exact key. For example, from bash:

```bash
known=$(ssh-keygen -F nucbox -f ~/.ssh/known_hosts | awk '!/^#/ {print $2 " " $3}')
if [ -n "$known" ]; then
  for n in {1..254}; do
    ip="192.168.1.$n"
    found=$(ssh-keyscan -T 1 "$ip" 2>/dev/null | awk '!/^#/ {print $2 " " $3}')
    if comm -12 <(printf '%s\n' "$known" | sort) <(printf '%s\n' "$found" | sort) | rg -q .; then
      printf 'NucBox key matches %s\n' "$ip"
    fi
  done
fi
```

An empty stored key means stop and obtain a trusted fingerprint first. A scan only discovers
addresses; it does not authenticate new keys. After a match, update `HostName` in the
`Host nucbox jewel-deploy` entry in `~/.ssh/config`, then use `ssh nucbox` as usual.
Keep `HostKeyAlias nucbox` and `StrictHostKeyChecking yes`: a wrong IP fails loudly.
A different host key needs confirmation of a reinstall; never silently accept it.

## Basic checks

```bash
ssh nucbox "echo ssh-ok"
ssh nucbox "docker ps --format {{.Names}}"
ssh nucbox "docker network ls"
```

Keep remote command strings simple. Bash → ssh → the remote Windows shell introduces
quoting layers; use a remote `.bat` / `.cmd` file for complex commands.

## Host-local connector tunnel

The connector binds only to NucBox's loopback `127.0.0.1:4040`. From Linux:

```bash
ssh nucbox -N -L 127.0.0.1:4040:127.0.0.1:4040
```

Use `http://127.0.0.1:4040` locally, e.g. `curl http://127.0.0.1:4040/healthz`.
Containers deployed on NucBox use `http://api:8080` on the Docker network instead
(see `connector-api.md`).
