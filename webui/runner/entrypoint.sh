#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /root/.codex
cd /workspace
exec "$@"
