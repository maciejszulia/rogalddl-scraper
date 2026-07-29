#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX=${PREFIX:-"$HOME/.local"}
LIB_PARENT="$PREFIX/lib"
TARGET="$LIB_PARENT/rogalddl"
BIN_DIR="$PREFIX/bin"
STAGE=''
BACKUP=''

cleanup() {
  if [[ -n "$STAGE" && -e "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
}
trap cleanup EXIT INT TERM

node -e 'const major=Number(process.versions.node.split(".")[0]); if(major<22){console.error("Node.js 22+ is required");process.exit(1)}'
mkdir -p -- "$LIB_PARENT" "$BIN_DIR"
STAGE=$(mktemp -d "$LIB_PARENT/.rogalddl-install.XXXXXX")
mkdir -p -- "$STAGE/lib"
cp -- "$SOURCE_DIR/package.json" "$SOURCE_DIR/rogalddl.mjs" "$STAGE/"
cp -- "$SOURCE_DIR"/lib/*.mjs "$STAGE/lib/"
chmod 0755 "$STAGE/rogalddl.mjs"

if [[ -e "$TARGET" ]]; then
  BACKUP="$LIB_PARENT/.rogalddl-backup.$$"
  mv -- "$TARGET" "$BACKUP"
fi
if ! mv -- "$STAGE" "$TARGET"; then
  if [[ -n "$BACKUP" && -e "$BACKUP" ]]; then mv -- "$BACKUP" "$TARGET"; fi
  exit 1
fi
STAGE=''
rm -rf -- "$BACKUP"

WRAPPER=$(mktemp "$BIN_DIR/.rogalddl.XXXXXX")
cat >"$WRAPPER" <<'WRAPPER_EOF'
#!/bin/sh
PREFIX_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$PREFIX_DIR/lib/rogalddl/rogalddl.mjs" "$@"
WRAPPER_EOF
chmod 0755 "$WRAPPER"
mv -f -- "$WRAPPER" "$BIN_DIR/rogalddl"

printf 'Installed: %s\n' "$BIN_DIR/rogalddl"
for tool in yt-dlp mpv; do
  if ! command -v "$tool" >/dev/null 2>&1; then printf 'WARNING: missing optional runtime command: %s\n' "$tool" >&2; fi
done
if ! command -v fpcalc >/dev/null 2>&1; then
  printf 'INFO: fpcalc missing; metadata-only scans work, audio fingerprint modes will report a limitation.\n' >&2
fi
printf 'Run: %s doctor\n' "$BIN_DIR/rogalddl"
