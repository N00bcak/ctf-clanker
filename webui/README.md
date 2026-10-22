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
- CTF skills: `families/ctf/`, mounted read-only at `/etc/codex/skills`
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

## Execution queue

`POST /api/tasks/:id/start` accepts a run with HTTP 202. The server queues the
stored initial prompt, provisions the runner, and invokes Codex; clients must
not submit the initial prompt separately. Repeated Start requests are idempotent
while a run is pending or active. `POST /api/tasks/:id/prompt` queues a follow-up
with HTTP 202 and rejects overlapping requests for the same task.

Local runs use FIFO admission within the configured concurrency limit. Every
finished turn releases its runner after cleanup: a valid solved report becomes
`done`, an unresolved or missing report becomes `needs-attention`, and execution
errors become `failed`. Unresolved tasks require an explicit follow-up; they do
not block later tasks. Stop and Mark Done also release capacity. Cleanup errors
remain visible on the task and reserve capacity until Stop succeeds.

Pending prompts survive restart. Interrupted active runs are cleaned up and
marked for attention rather than automatically replayed. Workspaces, outputs,
and Codex session files are retained for follow-ups; `purge-after-run` still
removes transient history and logs, but preserves resumable session files.
No external flag submission is performed.

## Permissions and workspace synchronization

The Permissions inspector reads the saved manifest and the runtime's supported
network modes from `GET /api/tasks/:id/permissions`. Stop must finish before
permissions can be changed; queued, active, and collecting tasks return HTTP 409.
Local Docker supports `open` and `none`; cloud and host runtimes currently support
`open`. Saving updates the manifest and task metadata. The next local run
recreates a stopped container when its permission fingerprint changed, retaining
the workspace and Codex sessions.

Cloud execution requires `rsync` on the host; cloud bootstrap installs it on the
droplet. Each turn uploads the host workspace before execution. During execution,
the server attempts a snapshot after ten seconds and schedules the next attempt
ten seconds after the preceding transfer finishes. The Files inspector shows the
last complete snapshot and its synchronization time. These live snapshots are
provisional because the solver may still be writing files. Failed transfers keep
the previous snapshot and retry; cloud file writes and deletions return HTTP 409
until execution and final collection finish.

Stop and turn completion collect the stopped remote workspace before releasing
capacity and updating bridge context. A failed final collection preserves the
remote workspace and can be retried with Stop. Existing cloud runners without
sync metadata are collected before a new upload. Snapshots use staged generations
and the existing task cache quota; symlinks are never followed outside the
workspace, and credentials outside the workspace are not transferred.

Every cloud Start checks the live-call guards, including retained runners.
With dry-run disabled, disabling new starts still permits cleanup of recorded
resources. Dry-run itself prohibits live cleanup and preserves the resource
record. Destroy deletes a recorded resource without depending on SSH or file
collection; an already absent droplet counts as successfully deleted.
