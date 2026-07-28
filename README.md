# CTF Clanker

CTF Clanker combines eight CTF-solving Codex skills with a WebUI for isolated
local Docker and guarded DigitalOcean tasks.

## Layout

```text
families/ctf/   CTF skill family
webui/          task control plane, runner, client, and tests
```

The repository was extracted from Mecha Suit with the original history for
both paths. The skills and WebUI version together.

## Develop

Requirements:

- Node.js 22.5 or newer
- Docker for local isolated tasks
- Codex authentication at `~/.codex/auth.json` for native local runs

Install and verify:

```bash
npm --prefix webui ci
npm --prefix webui test
npm --prefix webui run build
npm --prefix webui run runner:build
```

Run the WebUI:

```bash
npm --prefix webui run dev
```

Open <http://127.0.0.1:8787>. The local runner mounts `families/ctf/`
read-only as the task's Codex skills.

DigitalOcean remains dry-run by default. Live cloud calls require the explicit
configuration and environment guards documented in `webui/README.md`.

## Security

The local Docker setup is a practical CTF baseline, not a malware-analysis or
container-escape boundary. Use a disposable VM for hostile kernel payloads,
suspected container escapes, or untrusted malware.

Prompt instructions are not a security boundary. Isolation comes from narrow
mounts, dropped capabilities, resource limits, credential handling, and
explicit network policy.
