# AGENTS.md

## Purpose

This repository develops CTF-solving Codex skills and the WebUI that runs them
in isolated local or cloud tasks.

## Boundaries

- Keep CTF skills under `families/ctf/`.
- Keep runtime instructions in each `SKILL.md` and passive detail in
  `references/`.
- Keep WebUI code, runner configuration, and tests under `webui/`.
- Do not add skill symlink installers; the WebUI deploys its local skill family.
- CTF skills never spawn, request, or rely on subagents.

## Development

- Use Node.js 22.5 or newer.
- Install with `npm --prefix webui ci`.
- Run `npm --prefix webui test` after WebUI changes.
- Run `npm --prefix webui run build` after TypeScript or client changes.
- Run `npm --prefix webui run runner:build` after runner changes.
- Preserve dry-run guards around cloud operations.
- Never mount host credential directories, Docker sockets, SSH directories, or
  cloud tokens into task containers.

## Change Discipline

- State assumptions before broad changes.
- Match nearby code and test style.
- Keep changes surgical and remove only artifacts made obsolete by the change.
- Add no abstraction, option, dependency, or file without a current need.
- Preserve user changes and inspect Git state before editing.
- Report verification evidence and remaining operational risk.
