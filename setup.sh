#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for command_name in node npm docker; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "error: required command not found: $command_name" >&2
        exit 1
    fi
done

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)' || {
    echo "error: Node.js 22.5 or newer is required" >&2
    exit 1
}

docker info >/dev/null
npm --prefix "$REPO_DIR/webui" ci
npm --prefix "$REPO_DIR/webui" run runner:build

echo "CTF Clanker is ready. Start it with: $REPO_DIR/run.sh"
