#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

npm --prefix "$REPO_DIR/webui" test
npm --prefix "$REPO_DIR/webui" run build
MECHA_WEBUI_LIVE_DOCKER=1 npm --prefix "$REPO_DIR/webui" test -- tests/liveSmoke.test.ts
