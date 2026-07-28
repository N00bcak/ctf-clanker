# CTF Clanker

CTF Clanker provides a WebUI to solve CTF challenges autonomously with.
Its principal advantage is the ability to deploy completely locally, but also supports DigitalOcean for cloud-based runs. 

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

Install the dependencies and build the local runner:

```bash
./setup.sh
```

Run the unit, production-build, and live Docker checks:

```bash
./test.sh
```

Run the WebUI:

```bash
./run.sh
```

Open the URL printed by `npm` (it defaults to `http://127.0.0.1:8787`, 
since this is a local instance). The local runner mounts `families/ctf/`
read-only at Codex's container-level `/etc/codex/skills` location.

DigitalOcean remains dry-run by default. Live cloud calls require the explicit
configuration and environment guards documented in `webui/README.md`.

## Security

The local Docker setup is a practical CTF baseline, not a malware-analysis or
container-escape boundary. Use a disposable VM for hostile kernel payloads,
suspected container escapes, or untrusted malware.

Prompt instructions are not a security boundary. Isolation comes from narrow
mounts, dropped capabilities, resource limits, credential handling, and
explicit network policy.
