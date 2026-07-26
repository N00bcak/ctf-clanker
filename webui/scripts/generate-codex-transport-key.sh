#!/usr/bin/env bash
set -euo pipefail

KEY_DIR="${CODEX_HOME:-${HOME}/.codex}/mecha-webui"
KEY_PATH="${KEY_DIR}/transport_ed25519"
FORCE=0

if [ "${1:-}" = "--force" ]; then
    FORCE=1
fi

if [ -e "${KEY_PATH}" ] || [ -e "${KEY_PATH}.pub" ]; then
    if [ "${FORCE}" -ne 1 ]; then
        printf 'refusing to overwrite existing key: %s\n' "${KEY_PATH}" >&2
        printf 'rerun with --force to replace it\n' >&2
        exit 1
    fi
    rm -f "${KEY_PATH}" "${KEY_PATH}.pub"
fi

mkdir -p "${KEY_DIR}"
chmod 0700 "${KEY_DIR}"
ssh-keygen -t ed25519 -N '' -f "${KEY_PATH}" -C "mecha-webui-codex-transport"
chmod 0600 "${KEY_PATH}"
chmod 0644 "${KEY_PATH}.pub"

printf 'created %s\n' "${KEY_PATH}"
printf 'created %s.pub\n' "${KEY_PATH}"
