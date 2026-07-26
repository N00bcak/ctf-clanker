# Codex Prompt: Implement `webui` for isolated Codex task management — v5

You are working in the `mecha-suit` repository. Implement the `webui` subsystem as a control plane for creating, running, steering, monitoring, and destroying isolated Codex tasks.

Read the attached planner document first: `webui_planner_document_v5.md`. Treat it as the durable source of truth. Do not rely only on this prompt after context compaction. At the start and end of each major implementation phase, reread the planner and update `webui/PLAN.status.md`.

This revised prompt intentionally includes hardening items that must not be skipped: Codex credential handling, honest network egress enforcement, reaper race avoidance, provider-interface consistency, file-browser path safety, SQLite concurrency settings, runner image build details, attachment/disk limits, bridge-owned context, Codex-home cleanup, secret redaction, explicit server-auth/cloud-live guards, reaper orphan policy, configuration schema consistency, and the limits of `codex exec` as a conversational steering mechanism.

## Mission

Build `webui`, a local browser-based control plane that can manage Codex tasks in isolation.

A Codex task is a fresh task environment containing:

- generated task-specific instructions;
- the user's initial prompt;
- optional attached files;
- access to mecha-suit shared skills/templates/families as read-only assets;
- an isolated writable workspace;
- a Codex process running inside the task environment;
- a steering window for follow-up instructions;
- a terminal attached to the same isolated environment.

The control plane must support two execution backends:

1. **Local backend**: run tasks sequentially on the user's Mac because the machine is resource-constrained.
2. **DigitalOcean backend**: dynamically create a small droplet for a task, run the task there, collect outputs, and destroy the droplet to avoid idle charges.

Do not start by making live DigitalOcean calls. Build the local MVP, provider abstraction, and dry-run cloud provider first. Live cloud calls must require explicit config and environment opt-in.

## Non-negotiable constraints

1. `webui` is a control plane, not the task workspace.
2. Codex must run inside the task environment, not directly on the host.
3. Each task must get its own task directory under:

   ```text
   webui/cache/<task_id>/
   ```

4. Each task's main writable workspace must be:

   ```text
   webui/cache/<task_id>/storage/
   ```

5. By default, a task has zero host-path permissions outside its own task directory.
6. Shared mecha-suit assets must be mounted or exposed read-only.
7. Extra host paths require an explicit per-task permissions config.
8. Local tasks must be processed by a queue with default concurrency `1`.
9. DigitalOcean tasks must be created dynamically and destroyed after finish, idle timeout, hard timeout, explicit destroy, or orphan cleanup.
10. Never print, persist, commit, or expose secrets such as API keys, Codex auth files, DigitalOcean tokens, SSH private keys, or local credential directories.
11. Do not delete or rewrite existing repo content outside `webui/` unless required and clearly documented.
12. Avoid destructive shell commands. No `rm -rf` outside generated task/cache/test directories.
13. If the repo already has conventions, package managers, or test commands, follow them.
14. Keep implementation incremental and testable.
15. Bind the development server to `127.0.0.1` by default. Do not expose it on a LAN address without explicit auth.
16. Configure SQLite for multiple components: WAL mode, `busy_timeout`, and explicit transaction boundaries.

## First actions

1. Inspect the repository layout.
2. Read root documentation files if present, especially `README.md`, `AGENTS.md`, `CLAUDE.md`, and `PROMPT.md`.
3. Read `webui_planner_document_v5.md` fully.
4. Inspect any existing `webui/` directory.
5. Create or update `webui/PLAN.status.md` with:
   - current phase;
   - completed work;
   - next actions;
   - risks/open questions;
   - files changed;
   - current credential strategy;
   - current Codex-home retention policy;
   - current network mode, enforcement status, and known limitations;
   - attachment/quota status;
   - redaction status.
6. Implement Phase 1 and Phase 2 first unless the repository already contains equivalent code.
7. Before implementing Phase 3, write the concrete Codex credential strategy into `webui/PLAN.status.md` and `webui/README.md`.

## Critical hardening items to implement or explicitly scaffold

### 1. Codex credential strategy

Phase 3 will fail unless Codex can authenticate. Do not ignore this.

Support a clear credential mode in config:

```yaml
codex:
  credentialMode: host-env-api-key   # none | host-env-api-key | copied-codex-home | broker
  apiKeyEnv: CODEX_API_KEY
  allowTerminalCredentialEnv: false
  failIfMissingCredential: true
  codexHomeRetention: purge-after-run   # purge-after-run | purge-on-finish | keep-until-task-delete
```

Required behavior:

- `none`: Codex runs are disabled and fail with a clear error.
- `host-env-api-key`: read the API key from the host environment and pass it only to the Codex invocation, not to the base container and not to normal terminal shells.
- `copied-codex-home`: disabled by default; config alone must never copy `~/.codex`. Import must require an explicit user action such as a UI confirmation or a CLI command naming a specific auth file/profile. Never blanket-copy the user's whole Codex directory.
- `broker`: future mode where the host/control plane mediates model calls and the task environment never receives the model credential.

For the MVP, implement `host-env-api-key` or fail clearly if no credential exists. Do not mount the user's personal `~/.codex` into task containers by default.

Concrete injection rule for `host-env-api-key`:

- Do **not** pass the key on `docker run`.
- Do **not** pass the key via a shell command line such as `CODEX_API_KEY=... codex exec ...`.
- Prefer either a stdin-based runner helper or a transient env file with mode `0600`, containing only the required Codex credential, passed to the one Codex process through `docker exec --env-file <temp-file> ... codex exec ...`.
- If using the stdin helper, send the secret through stdin to a purpose-built runner command that spawns Codex and then unsets its local secret variables. If using the env-file fallback, delete the transient env file as soon as the Codex process has started or exited; never log its contents.
- For remote DigitalOcean tasks, prefer the same stdin-based runner helper over SSH. If using the env-file fallback, upload a short-lived `0600` env file to a restricted path such as `/run/mecha/<task_id>/codex.env`, use it only for `docker exec --env-file`, then delete it. This still exposes the credential to the droplet while Codex runs. If that is unacceptable, use `broker` mode or do not run cloud Codex tasks.

Tell it like it is: any credential available to a Codex process running in the task environment may be exposed by that task. Prompt instructions do not prevent exfiltration. The practical MVP goal is to avoid leaking unrelated host secrets, not to make the Codex credential impossible for the task to observe.

`codex-home/` is secret-bearing. With `host-env-api-key`, keep generated config there but scrub session/history/runtime files after each run. With `copied-codex-home`, purge task-local copied auth on finish unless the user explicitly chooses retention. Never commit `codex-home/`.

### 2. Network egress model

Do not pretend Docker provides FQDN allowlisting by itself. It does not.

Use explicit modes, but keep the MVP default honest:

```yaml
network:
  mode: open              # none | open | codex-only | proxy-allowlist
  enforcement: open-warning   # open-warning | docker-none | sidecar-proxy | host-firewall | broker
  allow: []
```

Required behavior:

- `open`: normal Docker bridge networking. This is the honest MVP default if no enforcement exists. Show a UI warning and write a log/status warning because readable task data can be exfiltrated.
- `none`: no outbound network from the task container. This blocks in-runner Codex unless a host-side broker is used.
- `codex-only`: only valid when a real enforcement mechanism exists. If selected with unavailable or merely planned enforcement, refuse to start the task.
- `proxy-allowlist`: sidecar proxy or equivalent enforcement for specified hosts. If direct egress is not blocked, this mode is not implemented. If implemented as a proxy, it must be HTTP CONNECT pass-through only and must not terminate TLS or inspect API-key-bearing traffic.

Do not ship `network.mode: codex-only` with `enforcement: planned` as a default. That lies to the user. Until proxy/firewall/broker enforcement is real, default to `open` with `open-warning`, or fail closed when a stricter mode is requested.

### 3. Reaper race avoidance

Before creating a container or droplet, write a durable provisioning intent record to the DB. The reaper must not delete fresh resources just because the final provider state has not been persisted yet.

Ownership rule: the scheduler/DB layer owns provisioning-intent creation. Providers may describe the resource they intend to create and must receive the intent when provisioning, but providers should not independently create DB intent records.

Required mechanism:

- write `status = provisioning` before resource creation;
- include `intentId`, expected resource name, backend, and `reaperGraceUntil`;
- use provisioning-intent statuses `creating`, `attached`, `closed`, `abandoned`, and `failed`; mark an intent `closed` after the runner has been collected/destroyed or the task has otherwise reached a terminal cleanup state;
- label/tag resources with `mecha-webui`, `task_id`, and `intent_id`;
- default orphan behavior is `security.reaperOrphanPolicy: report`; the reaper may automatically destroy unknown managed resources only when that policy is `destroy`, after grace/TTL checks, and only if they are clearly tagged as managed by webui.

### 4. File browser path traversal prevention

All file-browser endpoints must resolve paths safely under `webui/cache/<task_id>/storage/`.

Required checks:

- decode and reject NUL bytes;
- reject absolute paths;
- use `path.resolve(base, requested)`;
- require the resolved path to stay under the resolved base path;
- handle symlinks so they cannot escape the workspace;
- apply the same checks to reads, writes, listings, deletes, and uploads.

Add unit tests for `../`, encoded traversal, absolute paths, symlink escapes, and normal nested files.

### 5. `codex exec` is not conversational

The Phase 3 one-shot bridge is allowed, but do not describe it as a real continuing conversation. Each `codex exec` run is a new invocation unless a richer bridge is used.

Required Phase 3 behavior:

- store prompt history in `logs/steering.jsonl` or equivalent;
- `webui`/the Codex bridge owns `control/MECHA_CONTEXT.md`, outside the mounted task workspace, and updates it atomically after each run;
- Codex may write findings, commands, and scratch notes to `storage/NOTES.md`, but generated task instructions must not tell Codex to maintain `MECHA_CONTEXT.md` itself;
- do not mount the authoritative context file into the task by default; inject its contents into follow-up prompts from the bridge;
- build each follow-up prompt from the latest durable `control/MECHA_CONTEXT.md` plus the new user instruction;
- avoid concatenating the entire conversation forever.

Phase 4 may use Codex SDK, app-server, or MCP-like continuation if practical.

### 6. Approval flow is a real integration problem

Do not mark Phase 4 complete merely because a SDK or app-server dependency was installed. Completion requires approvals to be surfaced through the UI or disabled safely.

Required behavior:

- if approvals are interactive, stream approval requests to the steering pane;
- persist pending approval state;
- let the user approve/deny from the UI;
- if the selected bridge cannot handle approvals, use a non-interactive policy and fail clearly instead of hanging invisibly.

### 7. Runner image build pipeline

Do not hand-wave the runner image.

Required behavior:

- provide `npm run runner:build` or equivalent;
- include a Dockerfile that installs only necessary baseline tools;
- keep CTF-heavy packages out of the default image unless explicitly profiled;
- support Docker Desktop, OrbStack, and Colima by avoiding hard-coded socket assumptions;
- if using Docker sockets rather than the Docker CLI, check common locations such as `/var/run/docker.sock`, `$HOME/.docker/run/docker.sock`, `$HOME/.colima/default/docker.sock`, and `$HOME/.orbstack/run/docker.sock`;
- fail with a clear diagnostic when Docker is unavailable.

### 8. Server exposure

For MVP, `webui` is local-only:

```yaml
server:
  host: 127.0.0.1
  port: 8787
  auth:
    mode: none          # none | token
    tokenEnv: WEBUI_AUTH_TOKEN
```

If `host` is changed to anything other than loopback, require `server.auth.mode: token` with a non-empty `WEBUI_AUTH_TOKEN`, or refuse to start unless `WEBUI_UNSAFE_ALLOW_NO_AUTH=1` is set. Token auth must apply to HTTP routes and WebSockets. Never send cloud credentials, Codex credentials, or SSH private keys to the browser.

### 9. Attachment, upload, and disk limits

Do not allow unbounded uploads or unbounded task cache growth.

Use this schema exactly in config and code:

```yaml
limits:
  attachments:
    maxFiles: 50
    maxFileBytes: 26214400       # 25 MiB
    maxTotalBytes: 104857600     # 100 MiB
  taskCacheDirQuotaMb: 2048
  quotaEnforcement: soft
  maxLogBytesPerFile: 52428800   # 50 MiB
```

Required behavior:

- count bytes while streaming uploads; reject uploads that exceed `limits.attachments.maxFiles`, oversized individual files, and oversized total attachment sets;
- apply the safe path resolver to uploaded paths and archive extraction paths;
- reject zip-slip/archive traversal if archive support is added;
- implement at least a soft quota scanner for `storage/`, `logs/`, `input/attachments/`, and the whole task cache;
- enforce `limits.taskCacheDirQuotaMb` against the full task directory; track workspace usage as part of that soft quota;
- cap or rotate logs using `limits.maxLogBytesPerFile`;
- never claim hard disk quotas unless the provider actually enforces them.

### 10. Secret redaction

Implement a central `SecretRedactor` before streaming logs/events to the browser or writing control-plane logs.

Required behavior:

- redact secret **values**, not only secret variable names;
- register values from configured secret environment variables such as `CODEX_API_KEY`, DigitalOcean tokens, and any SSH/private-key material the control plane handles;
- redact common secret-bearing names and headers such as `Authorization`, `Bearer`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `DIGITALOCEAN_TOKEN`, `DO_API_TOKEN`, and private-key blocks;
- apply redaction to Codex output events, provider logs, terminal logs when captured, error messages, and API responses;
- add tests proving literal secret values are masked.


## Desired architecture

Use TypeScript unless the existing repository clearly uses a different stack.

Recommended layout:

```text
webui/
├─ package.json
├─ README.md
├─ PLAN.status.md
├─ config/
│  └─ default.yaml
├─ server/
│  └─ src/
│     ├─ main.ts
│     ├─ config.ts
│     ├─ db.ts
│     ├─ scheduler.ts
│     ├─ reaper.ts
│     ├─ tasks/
│     │  ├─ createTask.ts
│     │  ├─ taskState.ts
│     │  ├─ permissions.ts
│     │  ├─ fileBrowser.ts
│     │  └─ generateTaskFiles.ts
│     ├─ providers/
│     │  ├─ Provider.ts
│     │  ├─ LocalDockerProvider.ts
│     │  ├─ DigitalOceanProvider.ts
│     │  └─ DryRunProvider.ts
│     ├─ codex/
│     │  ├─ CodexExecBridge.ts
│     │  ├─ CodexSdkBridge.ts
│     │  └─ AppServerBridge.ts
│     └─ terminal/
│        └─ ptyBridge.ts
├─ client/
│  └─ src/
│     ├─ TaskList.tsx
│     ├─ TaskView.tsx
│     ├─ SteeringPane.tsx
│     ├─ TerminalPane.tsx
│     ├─ FileBrowser.tsx
│     └─ PermissionsEditor.tsx
├─ runner/
│  ├─ Dockerfile
│  ├─ entrypoint.sh
│  └─ runnerd.ts
└─ cache/
   └─ .gitkeep
```

The exact layout may be adjusted to match repo conventions, but preserve the core separation:

- API/control plane;
- task scheduler;
- provider abstraction;
- local Docker provider;
- DigitalOcean provider scaffold;
- runner image/process;
- browser UI;
- task cache directories.

## Minimum implementation target

Complete a local MVP before live cloud work.

### Phase 1: task records, cache layout, safe file access

- Create tasks through an API endpoint.
- Generate `webui/cache/<task_id>/`.
- Generate task files:
  - `task.yaml`;
  - `permissions.yaml`;
  - `input/prompt.md`;
  - `input/attachments/`;
  - `storage/`;
  - `storage/NOTES.md` as an empty or seeded Codex-maintained scratch stub;
  - `control/`;
  - `control/MECHA_CONTEXT.md` as bridge-owned authoritative context outside the mounted workspace;
  - `codex-home/`;
  - `logs/`;
  - `output/`.
- Add attachment-size checks and task-cache soft quota checks.
- Store task state in SQLite or another durable local DB.
- Set SQLite WAL mode and `busy_timeout`.
- Implement safe file-browser path utilities and tests.
- Add `.gitignore` rules so cache contents, DB files, logs, and secrets are never committed.

### Phase 2: local Docker runner and terminal

- Build a runner container.
- Start one container per active local task.
- Mount only the task workspace and read-only mecha-suit assets.
- Enforce queue concurrency `1`.
- Add a terminal websocket using `xterm.js` on the client and Docker exec/PTY on the server.
- Confirm the terminal starts in `/workspace`.
- Detect Docker runtime availability and report clear errors.

### Phase 2.5: pre-Codex hardening gate

Do this before Phase 3:

- implement or explicitly configure the Codex credential mode;
- document whether network mode is enforced or only warned;
- refuse to start `codex-only` or `proxy-allowlist` tasks unless real enforcement is implemented;
- implement provisioning intent records and reaper grace periods;
- finish file-browser traversal tests;
- enforce attachment/upload limits and task-cache soft quotas;
- implement and test secret-value redaction;
- ensure terminal sessions do not inherit Codex credentials by default;
- update `PLAN.status.md` with remaining security limitations.

### Phase 3: Codex one-shot steering

- Add a `codex exec` bridge inside the runner.
- Send the initial prompt from the steering window.
- Stream output to the browser and logs.
- Inject `CODEX_API_KEY` only into the Codex invocation, preferably through a stdin runner helper; a transient `0600` env file passed to `docker exec --env-file` is an acceptable fallback. Never use command-line arguments or base-container environment for this secret.
- Allow follow-up prompts after the prior run completes, using bridge-owned `control/MECHA_CONTEXT.md` rather than assuming real conversational memory.
- Fail clearly if Codex credentials are unavailable.

### Phase 4: richer Codex steering

- Pick and document the Phase 4 bridge mechanism: Codex SDK, app-server, or another continuation-capable bridge. Until that decision is made, mark the bridge as one-shot in `PLAN.status.md`.
- Keep the one-shot `codex exec` fallback.
- Surface approval requests and streamed agent events in the UI.
- Do not hang invisibly on approval prompts.

### Phase 5: DigitalOcean dry-run provider

- Implement droplet creation, bootstrap, upload, remote runner, collection, and teardown as logged dry-run actions.
- Keep live cloud calls disabled until config explicitly enables them.
- Tag every intended droplet so the reaper can find and destroy orphaned resources.

### Phase 6: DigitalOcean live provider

- Create droplet.
- Apply strict tagging.
- Wait for SSH.
- Bootstrap runner.
- Upload bundle.
- Start runner remotely.
- Stream terminal through SSH.
- Collect files.
- Destroy droplet.
- Reap orphaned tagged droplets.

## Required task state machine

Use these states unless there is a strong reason to refine them:

```text
draft
  -> queued
  -> provisioning
  -> running
  -> idle
  -> collecting
  -> destroying
  -> finished

failed can happen from any active state.
orphaned means the DB references a runner/droplet/container that is missing or unmanaged.
```

State transitions must be explicit and logged.

## Required provider interface

Create a common interface for local and cloud execution. The scheduler/DB owns provisioning intents; providers receive an intent and must tag/label created resources with it.

```ts
export interface ProvisioningIntentStore {
  createIntent(task: CodexTask, plan: ProvisioningPlan): Promise<ProvisioningIntent>;
  bindResource(intentId: string, handle: RunnerHandle): Promise<void>;
  markClosed(intentId: string): Promise<void>;
  markFailed(intentId: string, error: string): Promise<void>;
}

export interface RunnerProvider {
  describeProvisioning(task: CodexTask): ProvisioningPlan;
  provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle>;
  start(task: CodexTask, handle: RunnerHandle): Promise<void>;
  openTerminal(task: CodexTask, handle: RunnerHandle): Promise<NodeJS.ReadWriteStream>;
  openEventStream(task: CodexTask, handle: RunnerHandle): Promise<AsyncIterable<TaskEvent>>;
  sendPrompt(task: CodexTask, handle: RunnerHandle, prompt: string): Promise<void>;
  collect(task: CodexTask, handle: RunnerHandle): Promise<void>;
  stop(task: CodexTask, handle: RunnerHandle): Promise<void>;
  destroy(task: CodexTask, handle: RunnerHandle): Promise<void>;
}
```

Provisioning sequence:

```text
scheduler selects queued task
  -> provider.describeProvisioning(task)
  -> intentStore.createIntent(task, plan)
  -> provider.provision(task, intent)
  -> intentStore.bindResource(intent.id, handle)
  -> provider.start(task, handle)
  -> on successful collect/destroy, intentStore.markClosed(intent.id)
```

## Permissions model

Each task must have a permissions file like:

```yaml
version: 1

network:
  mode: open              # none | open | codex-only | proxy-allowlist
  enforcement: open-warning
  allow: []

mounts: []
```

When adding extra mounts:

```yaml
mounts:
  - label: notes
    source: /Users/example/ctf-notes
    target: /mnt/notes
    mode: ro        # ro | rw | rx | rwx
```

Validate all extra mounts:

- canonicalize paths;
- reject symlink escapes;
- reject `/`, `$HOME`, `.ssh`, `.codex`, `.config`, cloud credential directories, and secret-bearing directories by default;
- require explicit config for every extra path;
- never mount DigitalOcean tokens, SSH private keys, or personal Codex auth caches into task containers.

## Local runner defaults

Default local config:

```yaml
local:
  enabled: true
  concurrency: 1
  provider: docker
  runnerImage: mecha-codex-runner:latest
  dockerHost: auto
```

Default local container behavior:

```text
/workspace                    rw  from webui/cache/<task_id>/storage
/root/.codex                  rw  from webui/cache/<task_id>/codex-home  # secret-bearing; scrub per retention policy
/mecha/shared                 ro  from repo shared/
/mecha/templates              ro  from repo templates/
/mecha/families               ro  from repo families/
```

If generated task skill indexes or wrappers are needed, create them as ordinary files inside `storage/` before container start. Do not add a separate `ro/rw` mount under `/workspace`; `/workspace` is already the task's writable workspace.

Use conservative container limits by default:

```text
1 CPU
1024 MiB RAM
pids-limit 512
cap-drop all
no-new-privileges
```

Add configurable profiles, but keep risky profiles opt-in and cloud-only unless explicitly overridden.

## DigitalOcean defaults

Scaffold these defaults:

```yaml
cloud:
  provider: digitalocean
  enabled: false
  dryRun: true
  liveEnvGuard: WEBUI_CLOUD_LIVE
  region: nyc3
  image: ubuntu-24-04-x64
  defaultSize: s-1vcpu-1gb
  maxConcurrent: 3
  idleTtlMinutes: 15
  hardTtlMinutes: 240
  destroyOnFinish: true
  backups: false
  snapshots: false
```

DigitalOcean provider requirements:

- never create a droplet unless `cloud.enabled === true`, `cloud.dryRun === false`, and `process.env[cloud.liveEnvGuard] === "1"`;
- tag all resources with `mecha-webui`, `task-<task_id>`, and the provisioning `intent_id`;
- avoid backups, snapshots, and volumes unless explicitly configured;
- use SSH from the local server to the droplet;
- do not expose runner ports publicly;
- collect the workspace before destruction;
- destroy droplets on finish, idle timeout, hard timeout, user stop, or orphan reaper action.

## Reaper

Implement a reaper loop early, even if cloud support is not complete.

Use this security config shape:

```yaml
security:
  reaperGraceSeconds: 120
  globalOrphanTtlMinutes: 30
  reaperOrphanPolicy: report   # report | destroy
```

Responsibilities:

- destroy idle local containers;
- destroy tasks that exceed hard TTL;
- mark missing containers as orphaned;
- respect provisioning grace periods;
- never delete freshly-created resources before the DB has had a chance to persist final provider state;
- when cloud is enabled, list droplets tagged `mecha-webui`; destroy known expired resources, but for unknown tagged resources use `security.reaperOrphanPolicy` (`report` by default, `destroy` only when explicitly configured) after grace/TTL checks;
- provide a clear `kill all mecha-webui resources` admin action.

## Browser UI

Minimum UI panes:

1. task list;
2. task detail/status;
3. steering window;
4. terminal;
5. file browser for `storage/` only;
6. permissions editor;
7. event log.

The UI does not need to be pretty at first. It must be clear and safe.

## API shape

Implement or approximate:

```http
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/start
POST   /api/tasks/:id/stop
POST   /api/tasks/:id/destroy
POST   /api/tasks/:id/prompt
PATCH  /api/tasks/:id/permissions
GET    /api/tasks/:id/files
GET    /api/tasks/:id/files/*path
PUT    /api/tasks/:id/files/*path
```

All file endpoints must use the safe path resolver.

WebSockets:

```http
WS /ws/tasks/:id/events
WS /ws/tasks/:id/terminal
```

## Generated task instructions

For each task, generate a task-local `AGENTS.md` or equivalent project instruction file inside `storage/`:

```md
# Mecha task instructions

You are operating inside an isolated task workspace.

Workspace:
- Primary writable workspace: /workspace
- Shared mecha-suit assets: /mecha, read-only
- Attached files: /workspace/attachments

Rules:
- Do not attempt to access paths outside mounted task paths.
- Use available skills when relevant.
- Record important commands and findings in /workspace/NOTES.md.
- Before declaring completion, summarize changed files, commands run, and unresolved risks.
```

Generate a per-task Codex config under the task's Codex home or workspace config. Use a non-interactive-safe configuration for `codex exec`; richer approval behavior belongs in Phase 4.

## Context compaction survival protocol

This project is vulnerable to context loss. Keep durable state in files.

At the end of every meaningful change, update `webui/PLAN.status.md` with:

```md
# webui status

## Current phase

## What is already implemented

## What remains

## Important architectural decisions

## Credential strategy

Current credentialMode:
Injection mechanism:
Whether terminal inherits credential:
Codex-home retention:
Known credential risks:

## Network mode and limitations

Current network.mode:
Current network.enforcement:
Is allowlist enforced:
Open-egress warning status:
If proxy is used, whether TLS termination is disabled:
Known network risks:

## Context ownership

Authoritative context path:
Is authoritative context mounted into task:
Codex-editable notes path:
Known context risks:

## Codex-home retention policy

Current policy:
Contains copied auth:
Cleanup behavior:

## Limits/quotas status

Attachment limits, including maxFiles/maxFileBytes/maxTotalBytes:
Task cache quota:
Log rotation limit:
Current usage/risk:

## Secret redaction status

Redacts configured secret values:
Redacts common secret-bearing names/headers:
Known redaction gaps:

## Reaper/orphan policy

Provisioning intent statuses used:
Current reaperOrphanPolicy:
Cloud live guard env var:
Known orphan risks:

## Docker runtime status

Detection method:
Socket paths checked if applicable:
Known runtime risks:

## Phase 4 bridge decision

Current bridge mode:
Approval mechanism status:
Known bridge risks:

## Files changed

## Tests/commands run

## Risks/open questions

## Next recommended action
```

When starting a new session or after compaction, first read:

1. `webui_planner_document_v5.md` if it has been copied into the repo;
2. `webui/PLAN.status.md`;
3. `webui/README.md`;
4. relevant source files.

## Completion criteria for this Codex run

A good first run should leave the repository with:

- a clear `webui/` implementation scaffold;
- task creation and durable cache layout;
- SQLite configured for WAL and busy timeout;
- provider abstraction;
- local queue with concurrency `1`;
- local Docker provider scaffold or working implementation;
- runner image build script and Docker runtime detection;
- terminal bridge scaffold or working implementation;
- safe file-browser utilities and tests;
- attachment-size and task-cache soft quota checks;
- central secret-redaction helper with tests;
- Codex credential strategy documented and partially implemented or clearly failing;
- honest network default: open-with-warning unless stricter enforcement is real;
- Codex bridge scaffold or working `codex exec` implementation;
- DigitalOcean provider scaffold with dry-run safety;
- reaper scaffold with provisioning intent/grace-period logic;
- documentation and status file;
- tests or at least runnable smoke checks.

Prioritize correctness, containment, and recoverability over visual polish. Do not let planning become procrastination: Phase 1 and Phase 2 may be collapsed into one commit if that is faster and does not skip the safety checks.
