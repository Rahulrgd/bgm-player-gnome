#!/usr/bin/env bash
# Build an installable bundle in dist/: dist/<uuid>.shell-extension.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/dist"

gnome-extensions pack "$ROOT" \
    --force \
    --out-dir="$ROOT/dist" \
    --extra-source="$ROOT/lib" \
    --extra-source="$ROOT/daemon" \
    --schema="$ROOT/schemas/org.gnome.shell.extensions.background-music-player.gschema.xml"

ls -l "$ROOT"/dist/*.zip
