# WebUI Testing Spec

## Purpose And Scope

This spec governs tests under `webui/tests`.

The WebUI suite verifies the task-control plane: configuration, task creation,
SQLite persistence, scheduler/provider behavior, permissions, file access,
logs, Codex bridges, client UI surfaces, and safety boundaries.

This spec complements the repository-level `./test.sh` harness. The root
harness protects Mecha Suit architecture and install behavior. The WebUI suite
protects executable WebUI behavior.

## Core Principle

Tests may be broad, realistic, cross-module, and integration-heavy.

The default test run must still be:

- deterministic
- local
- non-metered
- repeatable
- confined to disposable test data
- safe to run on a developer machine without special credentials

Prefer realistic local fakes, deterministic transcripts, temporary
filesystems, and injected dependencies over live services.

## Default Guardrails

Normal tests must not:

- call DigitalOcean or any other metered cloud API
- call paid model APIs or hosted inference APIs
- provision real cloud resources
- mutate real user workspaces or repositories
- read or write the host `~/.codex`
- read or write host SSH keys, cloud tokens, shell history, or private config
- depend on a developer's real Docker containers, droplets, or Codex sessions
- require network access
- leave durable task cache, log, coverage, build, or key artifacts as source

Normal tests may:

- use `testConfig()` and `tempDir()` from `helpers.ts`
- create files under temporary directories
- use SQLite databases under temporary directories
- inject fake providers and bridges
- replay deterministic Codex app-server transcripts
- assert safety failures and guardrail behavior

Any test that can touch a live service, real Docker runtime, real Codex
process, account API, or metered system must be skipped by default and gated
by an explicit environment variable whose name makes the cost or risk visible.

## Unit Tests

Unit tests should cover small, isolated behavior with no live dependencies.

Use unit tests for:

- config validation and exposure guards
- path normalization and traversal rejection
- symlink escape checks
- redaction and secret pattern handling
- quota math and attachment limits
- credential-copying helpers
- command construction
- permission validation
- serialization and deserialization helpers

Unit tests should be fast, deterministic, and focused on one behavioral
contract at a time.

## Module Integration Tests

Module integration tests should exercise cooperating server modules without
starting real Docker, real cloud resources, or real Codex processes.

Use module integration tests for:

- task creation and generated task files
- scheduler/provider handoff
- provisioning intent records
- permission read/write behavior
- file browser list/read/write/delete behavior
- log writing and log capping
- quota enforcement across task directories
- database persistence across close/reopen boundaries
- bridge context updates

These tests should use temporary directories and injected fakes. They should
assert both state changes and durable outputs such as files, logs, and database
records.

## Route And Server Integration Tests

Server route tests should use `buildServer()` injection and Fastify
`app.inject()` rather than opening network ports.

Route tests should cover:

- task creation, listing, reading, start, stop, destroy, and prompt routes
- auth behavior for token-protected routes
- permission update routes
- file list/read/write/delete routes
- log routes
- error responses and redacted error messages
- fake provider lifecycle behavior
- fake host and native Codex bridge output behavior

Do not use real providers in normal route tests. Route tests should prove that
server modules are wired correctly while provider, bridge, and live execution
details stay injectable.

## Client And UI Tests

Client tests may use Testing Library, jsdom, browser automation, or another
local UI test tool when the interaction is worth testing through UI behavior.

Client/UI tests should cover:

- create task flows
- task selection and refresh behavior
- permissions editing
- file browsing
- event log rendering
- terminal surfaces with fake WebSocket implementations
- steering and prompt submission
- error and loading states for important workflows

Use fake APIs, fake WebSockets, or injected local servers by default. Browser
workflow tests are allowed when they remain local, deterministic, and
non-metered.

## Contract Tests

Contract tests should protect shapes that other modules or future agents depend
on.

Use contract tests for:

- API response shapes
- task schema fields
- provisioning intent and handle fields
- config defaults
- permission formats
- event and log record formats
- provider interface expectations
- generated files such as `task.yaml`, `permissions.yaml`, and
  `MECHA_CONTEXT.md`

When a public shape changes intentionally, update the contract test and the
nearby documentation in the same change.

## Codex App-Server Transcript Tests

Codex app-server behavior should be tested by replaying deterministic local
JSON-RPC transcripts.

Transcript tests should cover:

- session startup
- thread ID persistence
- prompt send/resume behavior
- approval response behavior
- output item parsing
- stderr/stdout redaction
- app-server exit handling

Real Codex app-server execution is allowed only in opt-in smoke tests. It must
not run in the default `npm test` path.

## Failure-Mode Tests

Tests should exercise important failures, not only happy paths.

Add failure-mode coverage for:

- missing auth
- malformed config
- invalid paths and URL encoding
- denied mounts
- missing Docker runtime
- failed provider provisioning
- stale or missing runner handles
- quota breaches
- corrupted or missing logs
- bridge failures
- app-server protocol errors
- unsupported credential or runtime modes

Failure tests should assert clear errors, redaction, cleanup, and persisted
state where relevant.

## Security Regression Tests

Safety boundaries are first-class behavior.

Keep regression tests for:

- path traversal rejection
- symlink escape rejection
- token auth enforcement
- secret redaction in strings, JSON, logs, and bridge output
- copying only task-local `auth.json`
- not copying Codex sessions, history, or logs
- denied host mounts such as `/`, `~`, `~/.ssh`, `~/.codex`, and cloud config
- cloud live-call guards
- no accidental exposure of host secrets to client responses

Security tests should prefer concrete exploit-shaped inputs over broad
assertions.

## Idempotency Tests

Repeated operations should not corrupt state or leak resources.

Use idempotency tests for:

- repeated permission writes
- repeated task lifecycle actions where the API permits them
- task cleanup and destroy behavior
- bridge context updates
- log appends and log rotation/capping
- install/uninstall-like behavior when WebUI adds analogous setup scripts

If an operation is intentionally not idempotent, test the explicit failure mode.

## State-Machine Tests

Task status transitions should be tested as a state machine.

Cover legal and illegal transitions across:

- `draft`
- `queued`
- `provisioning`
- `running`
- `idle`
- `collecting`
- `destroying`
- `finished`
- `failed`
- `orphaned`

State-machine tests should verify database state, emitted events, provider
calls, and cleanup behavior.

## Persistence And Restart Tests

Persistence tests should close and reopen durable state.

Use restart-style tests for:

- tasks
- provisioning intents
- runner handles
- provider state
- logs
- Codex thread IDs
- status after scheduler or server recreation

These tests should use temp SQLite paths and temp task directories. They should
not depend on a real long-running server process.

## Property And Fuzz-Style Tests

Property and fuzz-style tests are allowed when bounded, deterministic, and
local.

Good targets include:

- path normalization
- traversal and NUL-byte rejection
- redaction patterns
- quota sizing
- config validation
- permission validation
- log capping boundaries

Keep generated input sizes bounded. Seed randomness or use deterministic input
tables so failures are reproducible.

## Snapshot And Golden Tests

Snapshot and golden tests are allowed when the output is stable and meaningful.

Good targets include:

- `task.yaml`
- `permissions.yaml`
- `MECHA_CONTEXT.md`
- small generated command payloads
- small DOM fragments for stable client rendering
- app-server JSON-RPC transcript fixtures

Avoid broad snapshots that make harmless UI or formatting changes painful.
Prefer small, named fixtures with clear intent.

## Compatibility Tests

Compatibility tests should protect behavior that can break old tasks or known
runtime modes.

Use compatibility tests for:

- older task records when schemas evolve
- config migration expectations
- command construction across credential modes
- command construction across container, host, and droplet runtimes
- provider payloads that must remain stable
- generated task file formats consumed by Codex or external tools

When compatibility is intentionally broken, document the migration or explicit
drop in the same change.

## Performance And Resource Tests

Performance and resource tests should use local synthetic data.

Use them for:

- log capping
- large directory listing behavior
- quota enforcement
- bounded memory behavior for file and log operations
- scheduler behavior under small synthetic queues

Do not benchmark live providers or metered APIs in normal tests. Keep thresholds
coarse enough to catch accidental unbounded behavior without making the suite
flaky.

## Opt-In Live Smoke Tests

Live smoke tests are allowed only when skipped by default.

They must:

- use explicit opt-in environment variables
- make cost, network, or provisioning risk visible in the variable name
- avoid destructive operations unless the variable name and test name make that
  explicit
- clean up resources they create
- skip when required credentials or tools are absent

Allowed examples:

- Docker runtime/image checks gated by `MECHA_WEBUI_LIVE_DOCKER=1`
- real Codex app-server checks gated by an explicit Codex live variable
- DigitalOcean account checks gated by `MECHA_WEBUI_LIVE_DO=1` plus token env

Cloud provisioning tests are more dangerous than account checks. They require a
separate explicit gate and must prove cleanup.

## Generated Artifacts

The following are generated artifacts, not source artifacts:

- `coverage/`
- `dist/`
- `build/`
- `cache/`
- logs
- task workspaces
- generated SSH keys
- SQLite databases
- `node_modules/`

Generated artifacts may be inspected during verification, but they should not
be committed.

## Verification Commands

Use these commands based on the change surface:

- `npm test` for WebUI behavior changes.
- `npm run build` for TypeScript, server, or client changes.
- `npm run test:coverage` when coverage behavior or coverage baseline matters.
- root `./test.sh` when repo-level architecture, docs, install scripts,
  templates, or skill behavior changes.

If a test cannot be run, state exactly which command was skipped and why.

## Adding New Tests

When adding tests:

1. Choose the narrowest layer that catches the risk.
2. Add integration coverage when the bug or feature crosses module boundaries.
3. Include safety/failure assertions for auth, paths, credentials, mounts,
   cloud guards, and destructive behavior when relevant.
4. Keep default tests local and non-metered.
5. Use opt-in live smoke tests only when fakes or transcripts cannot prove the
   behavior.
6. Prefer clear assertions over broad snapshots.
