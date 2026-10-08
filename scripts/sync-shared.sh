#!/usr/bin/env bash
# Each pack must be self-contained, so shared helpers are copied in. Edit shared/, then run this.
set -euo pipefail
cd "$(dirname "$0")/.."
for pack in packs/*/; do
  for f in shared/*.ts; do
    { echo "// Copied from shared/$(basename "$f") by scripts/sync-shared.sh. Edit the original."; cat "$f"; } > "$pack/hooks/$(basename "$f")"
  done
done
