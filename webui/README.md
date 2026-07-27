# Mecha WebUI

`webui` is a local browser control plane for isolated Codex tasks. It creates
per-task cache directories, starts local Docker runners, exposes a terminal and
steering pane, and keeps cloud execution behind dry-run and live-call guards.

## Run

```bash
npm install
npm run runner:build
npm run dev
```

The server binds to `127.0.0.1:8787` by default. Non-loopback hosts require
token auth unless `WEBUI_UNSAFE_ALLOW_NO_AUTH=1` is set.

When the New Task dialog opens, the server starts `codex app-server` from the
configured local runner image, queries its `model/list` catalog, and presents
the result as a dropdown. This keeps model discovery aligned with the runtime
that will execute local tasks. If the runner image is unavailable, the server
may use the host app-server as a visibly labeled fallback. Leaving the selection
on **Codex default** omits the model override so Codex chooses its current
default.

Codex profiles are not imported into isolated tasks. A profile is a named
`$CODEX_HOME/<name>.config.toml` configuration layer and may contain broader
settings such as MCP servers or model-catalog overrides. The runner receives
only explicit task settings plus its task-local authentication copy.

## Security Model

Prompt instructions are not a security boundary. Isolation comes from the task
directory layout, Docker or cloud runners, explicit mounts, network settings,
and credential handling.

Default behavior:

- task cache: `webui/cache/<task_id>/`
- writable workspace: `webui/cache/<task_id>/storage/`
- runner workspace: `/workspace`
- shared Mecha Suit assets: `/mecha/shared`, `/mecha/templates`,
  `/mecha/families`, mounted read-only
- network: `open` with an explicit warning
- Codex credential mode: `codex-auth-json`
- Codex home retention: `purge-after-run`

For ordinary CTF artifact analysis, the local Docker configuration is a useful
baseline: Linux capabilities are dropped, privilege escalation is disabled,
resources are capped, mounts are narrow, and the Docker socket is not exposed.
It is not the right boundary for suspected container escapes, hostile kernel
payloads, or untrusted malware. Those should run in a disposable VM with
disposable credentials and a stricter network policy.

The task workspace is always `webui/cache/<task_id>/storage/`. Inside Docker,
that same workspace is mounted at `/workspace`.

Codex can run in two modes:

- `native-codex-app-server`: copies only `auth.json` into the task-local
  `codex-home/`, then runs `codex app-server --listen stdio://` inside the
  Docker container or DigitalOcean droplet. The bridge stores the Codex thread
  ID and resumes it on follow-up prompts when possible.
- `host-codex-broker`: runs the host `codex` CLI with `-C <task storage>`,
  `--sandbox workspace-write`, and no `--add-dir`. This is an opt-in local
  shortcut that uses the host Codex login and is not Docker-contained.

Generate the DigitalOcean SSH transport key with:

```bash
webui/scripts/generate-codex-transport-key.sh
```

The script writes `~/.codex/mecha-webui/transport_ed25519` with mode `0600`
and refuses to overwrite existing keys unless `--force` is passed.

## Cloud Guard

DigitalOcean support starts in dry-run mode. Live calls require all of:

- `cloud.enabled: true`
- `cloud.dryRun: false`
- `WEBUI_CLOUD_LIVE=1`
- a host-side DigitalOcean token
- `~/.codex/auth.json` from `codex login`
- the generated Mecha WebUI transport key

No DigitalOcean token or SSH private key is mounted into task containers.
Task containers and droplets do receive a task-local copy of `auth.json` so
Codex can run natively inside the isolated environment.

## Development Status

`PLAN.status.md` is the durable implementation record. Read it with
`webui_planner_document_v5.md` before continuing a later implementation pass.
