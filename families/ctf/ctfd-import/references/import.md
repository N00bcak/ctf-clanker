# Host command reference

Run from the clanker checkout. Paths passed to npm scripts are relative to
`webui/`; use absolute profile and output paths to avoid ambiguity.

```bash
npm --prefix webui ci
npm --prefix webui exec -- playwright install chromium
npm --prefix webui run ctfd:import -- login --url https://ctf.example
npm --prefix webui run ctfd:import -- run --url https://ctf.example --account team:42 --out /tmp/ctf-import
```

The login command opens a browser and waits for Enter after authentication.
Profiles default to `~/.local/share/ctf-clanker/browsers/<competition hash>` with
owner-only directory permissions. `--profile /absolute/path` selects a separate
account profile; close other browsers using that profile before running.

- `crawl`: collect only; requires `--url`, `--account`, and `--out`.
- `import`: ingest an existing bundle; requires `--out`.
- `run`: crawl then import, continuing complete challenges after partial failures.
- `--clanker URL`: override the local server address.
- `--start`: queue imported drafts; repeated imports do not restart completed tasks.
- `--ids 1,2` and `--categories web,crypto`: intersect filters; category names are exact.
- `--include-solved`: include challenges marked solved by the current account.
- `--headed`: show the crawl browser for inspection.

The helper has 25 MiB/file and 100 MiB/challenge download ceilings. The server also
enforces its configured file count, file size, total size, and task cache quotas.
Clanker authentication is read from `WEBUI_AUTH_TOKEN`. The clanker destination is
host input, never derived from a challenge. Use HTTPS for remote authenticated
clanker servers.

## Bundle and retry behavior

`manifest.json` uses clanker's version-1 batch schema. Companion files are under
`files/<challenge-name>/` (for example, `files/off-by-one/`); select these with
their relative paths preserved when using the WebUI's existing batch importer.
`report.json` includes source identity,
file checksums, task IDs/links, and per-challenge collection/import failures.
Signed attachment download URLs and cookies are not written into the manifest.
Descriptions are retained verbatim and may themselves contain challenge-specific
access information; treat the bundle as private competition material.

Folder names use lowercase ASCII letters, digits, and hyphens, with accents
normalized and a 100-character limit. Names without usable characters fall back
to `challenge`; reserved device names are prefixed with `challenge-`. Collisions
append the CTFd challenge ID, followed by a counter if necessary. The numeric ID
remains in source metadata. The report's `folders` map retains chosen names across
filtered crawls, retries, and challenge renames. Older numbered bundles keep their
recorded paths when resumed or collected again, preserving import identity and
checksums.

Writes use temporary files followed by rename. A partial challenge checkpoints
each downloaded file and verifies its checksum before reuse. Completed challenges
are fetched again on a new crawl so changed handouts can be detected. Imports
verify checksums again. Use one process per output directory.

The source key is `(ctfd, normalized competition base URL, account scope,
challenge ID)`. A retry returns the same task, including after a lost create
response. Changed prompt/file content produces HTTP 409 and leaves existing work
untouched. Inspect that difference before choosing a new task manually; the
helper does not automatically create revisions or overwrite a task.

## CTFd compatibility

Collection prefers participant-session `GET /api/v1/challenges` and
`GET /api/v1/challenges/<id>`. List entries marked hidden/solved are skipped by
default. Details supply description, category, tags, points, connection_info,
files, and hints whose content is already exposed to the participant. Unknown
hint IDs are not unlocked. Authenticated file downloads follow bounded HTTP(S)
redirects with cookies scoped to each destination.

If structured endpoints fail, the helper reads visible `[challenge-id]` or
`[data-challenge-id]` elements and common CTFd modal fields. Themes without these
markers or plugins with separate instance controls need browser inspection.
The crawler does not promise exhaustive support for arbitrary plugins or API
pagination introduced by a custom deployment.

Sources: [CTFd challenge API](https://github.com/CTFd/CTFd/blob/3.8.1/CTFd/api/v1/challenges.py),
[Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).
