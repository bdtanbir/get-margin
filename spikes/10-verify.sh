#!/usr/bin/env bash
# Task 5 companion: independently confirm spikes/out-enc.pdf is genuinely encrypted and
# spikes/out-dec.pdf is not, using two engines that are NOT MuPDF — a raw byte-level check
# and Apple's CoreGraphics PDF renderer (Quick Look, the same engine Preview/Finder use).
# macOS-only (strings/qlmanage). Run from anywhere:
#   bash spikes/10-verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENC=spikes/out-enc.pdf
DEC=spikes/out-dec.pdf

if [[ ! -f "$ENC" || ! -f "$DEC" ]]; then
  echo "Missing $ENC or $DEC — run 'pnpm tsx spikes/10-encryption.ts' first to generate them." >&2
  exit 1
fi

echo "=== 1. strings | grep -i Encrypt (raw byte scan, no PDF parser, not MuPDF) ==="
echo "--- $ENC (expect a hit: an /Encrypt dictionary) ---"
strings "$ENC" | grep -i Encrypt || echo "(no match)"
echo
echo "--- $DEC (expect NO hit) ---"
if strings "$DEC" | grep -i Encrypt; then
  echo "UNEXPECTED: decrypted file still contains an /Encrypt reference"
else
  echo "(no match, as expected)"
fi

echo
echo "=== 2. qlmanage -t (Apple CoreGraphics PDF renderer — independent of MuPDF) ==="
OUTDIR=$(mktemp -d)
mkdir -p "$OUTDIR/enc" "$OUTDIR/dec"
qlmanage -t -s 400 -o "$OUTDIR/enc" "$ENC" >/dev/null
qlmanage -t -s 400 -o "$OUTDIR/dec" "$DEC" >/dev/null
ENC_PNG="$OUTDIR/enc/$(basename "$ENC").png"
DEC_PNG="$OUTDIR/dec/$(basename "$DEC").png"
ENC_SIZE=$(stat -f%z "$ENC_PNG" 2>/dev/null || echo "MISSING")
DEC_SIZE=$(stat -f%z "$DEC_PNG" 2>/dev/null || echo "MISSING")
echo "encrypted-file thumbnail: $ENC_PNG ($ENC_SIZE bytes)"
echo "decrypted-file thumbnail: $DEC_PNG ($DEC_SIZE bytes)"
echo "Expectation (measured at spike time: enc=5717B, dec=20472B): the encrypted thumbnail is"
echo "small — CoreGraphics falls back to a generic grey padlock placeholder icon because it cannot"
echo "render page content without a password — while the decrypted thumbnail is substantially"
echo "larger because it contains real rendered page text. Open both PNGs to confirm visually:"
echo "  open \"$ENC_PNG\" \"$DEC_PNG\""
