#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
node scripts/check-syntax.mjs
bash -n install.sh test-all.sh
node --test
