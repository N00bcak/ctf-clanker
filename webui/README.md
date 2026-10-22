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

Local Docker runs use FIFO admission within worker, CPU, and RAM ceilings:

```yaml
local:
  concurrency: 8
  defaultCpu: 1
  cpuBudget: 6
  defaultMemoryMb: 2048
  memoryBudgetMb: 8192
```

RAM settings use Docker's binary units (2048 MB here is 2 GiB). Each active
execution reserves its full fixed RAM limit. The effective worker RAM budget is
the smaller of `memoryBudgetMb` and Docker's reported total RAM minus a single
1 GiB runtime reserve. This configuration permits four workers from the global
budget, or fewer when Docker has less memory. The maximum of eight workers
remains a ceiling; low observed RAM usage never permits overcommit. Unmanaged
containers and Docker/WebUI overhead are outside the managed-worker budget.

The server samples Docker every five seconds and allocates CPU from the last
30 seconds of peak usage plus 25% headroom. Each worker retains a minimum of
`min(0.25, cpuBudget / concurrency)` CPU. Combined CPU limits stay within the
configured budget and Docker's CPU capacity. The first fitting task starts
immediately; additional concurrent workers require 30 seconds of sustained CPU
usage below 70% of capacity with existing worker demand satisfied. Admissions
ramp by at most one worker per observation window. RAM caps remain fixed and
running workers are not preempted. A worker's initial CPU allocation is bounded
by `defaultCpu` and available shared capacity.

Omitted CPU and RAM budgets default to `concurrency * defaultCpu` and
`concurrency * defaultMemoryMb`. Insufficient Docker capacity, stale telemetry,
and unconfirmed limit updates pause admissions and appear in the queue's Local
Docker panel. `GET /api/scheduler` exposes configured/effective ceilings,
reservations, available usage readings, and per-task waiting reasons without
starting work. Limits on retained containers are reconciled before restart;
resource changes preserve their workspace and filesystem. Host-broker and cloud
execution retain their existing admission behavior.

Every finished turn releases its runner after cleanup: a valid solved report becomes
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

## CTFd import

The host-side `ctfd-import` skill uses Playwright to collect authenticated CTFd
challenges and upload one draft task per challenge. See
[`../families/ctf/ctfd-import/SKILL.md`](../families/ctf/ctfd-import/SKILL.md)
for the workflow and command reference. Install Chromium once with
`npm exec -- playwright install chromium`, then use `npm run ctfd:import -- --help`.
Browser profiles remain outside task containers; the runner image is unchanged.

`POST /api/tasks` still accepts JSON. It also accepts multipart with one `task`
JSON field (without inline attachments) and binary file parts named by their
workspace paths, e.g. `attachments/7/handout.zip`. Multipart paths use ASCII
letters, numbers, `_`, `-`, `.`, and `/`, without empty or traversal segments.
The existing attachment quotas apply; task metadata is limited to 1 MiB.

Both intake formats accept optional `source`:
`{ platform: "ctfd", competition, account, challengeId, contentHash }`.
`competition` is a base HTTP(S) URL without credentials/query/fragment;
`account` is a stable team/user scope; `challengeId` is a decimal string;
`contentHash` is a lowercase SHA-256 digest of the imported content.
An additive SQLite `task_sources` table preserves identities across restarts.
Creation returns 201; identical-source retries return the existing task with 200;
changed content returns 409. Existing JSON clients and tasks remain compatible.
Start drafts separately with `POST /api/tasks/:id/start`.

Browser fixture checks require installed Chromium:
`CTFD_BROWSER_TEST=1 npm test -- --run tests/ctfdImport.test.ts`.
For real-platform verification, seed a disposable CTFd 3.8.1 checkout using
`tests/fixtures/ctfd_import.py` (its pinned Python requirements must be installed,
and the CTFd checkout must be on `PYTHONPATH`), then set
`CTFD_TEST_URL=http://127.0.0.1:18787` for that same test command. The real-platform
test exercises login, protected attachments, deduplication, and queue execution
using a fake solver; it does not spend model credits or provision cloud resources.
