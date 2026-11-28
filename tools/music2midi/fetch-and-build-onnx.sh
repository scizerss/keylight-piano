#!/bin/bash
# Fetch and verify the pinned Music2MIDI checkpoint, export the ONNX pair the desktop app runs, check it against the golden
# fixture and write manifest.json (sizes and SHA-256 of both files). Output: tools/music2midi/.cache/onnx/ (never in git).
#   MUSIC2MIDI_PYTHON=/path/to/music2midi/venv/bin/python tools/music2midi/fetch-and-build-onnx.sh
# Python needs the versions pinned in README.md (torch 2.4.1, onnx 1.23.2, onnxruntime 1.32.0 ...); with those the export is
# byte for byte the pair below. Another toolchain may write different bytes that are just as correct: the golden-fixture token
# check in export_onnx.py has to pass either way, and KEYLIGHT_ONNX_ACCEPT_DIFFERENT=1 accepts files that differ from the pins.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CACHE_DIR="${KEYLIGHT_MUSIC2MIDI_CACHE:-$SCRIPT_DIR/.cache}"
CKPT_DIR="$CACHE_DIR/ckpts"
REPO_DIR="${MUSIC2MIDI_REPO:-$CACHE_DIR/repo}"
ONNX_DIR="${KEYLIGHT_ONNX_DIR:-$CACHE_DIR/onnx}"

# keep in step with fetch-and-build.sh (scripts/test-music2midi-tools.js checks that)
CKPT_NAME="epoch.799-step.119200.ckpt"
CKPT_URL="https://github.com/ytinyui/music2midi/releases/download/0.1.0/${CKPT_NAME}"
CKPT_SHA256="c2423b5e7ff42be0d6fd768d94f8dbc2669b2ecf01e4b082e64b21ea31daade6"
UPSTREAM_REPO="https://github.com/ytinyui/music2midi.git"
UPSTREAM_COMMIT="e0d31d6606a04c6fde35e5a2e753daf155c20dfe"
ENCODER_SHA256="9b82390ce4dda7987dcb2b404dc77e1b6b108ca8cd62378aab64b03d73dec2b4"
DECODER_SHA256="ed161b9143779393478f0814c16ec4f74693d19f5ac2d68ea5eb45d3c0ecc412"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

mkdir -p "$CKPT_DIR" "$ONNX_DIR"
CKPT_PATH="$CKPT_DIR/$CKPT_NAME"
if [ -f "$CKPT_PATH" ] && [ "$(sha256_of "$CKPT_PATH")" != "$CKPT_SHA256" ]; then
  echo "Existing checkpoint SHA-256 mismatch; downloading again..." >&2
  rm -f "$CKPT_PATH"
fi
if [ ! -f "$CKPT_PATH" ]; then
  echo "Downloading $CKPT_URL ..."
  curl -fL --retry 3 -o "$CKPT_PATH.part" "$CKPT_URL"
  got="$(sha256_of "$CKPT_PATH.part")"
  if [ "$got" != "$CKPT_SHA256" ]; then
    rm -f "$CKPT_PATH.part"
    echo "error: SHA-256 mismatch for $CKPT_NAME (expected $CKPT_SHA256, got $got)" >&2
    exit 1
  fi
  mv "$CKPT_PATH.part" "$CKPT_PATH"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --filter=blob:none "$UPSTREAM_REPO" "$REPO_DIR"
fi
if ! git -C "$REPO_DIR" cat-file -e "$UPSTREAM_COMMIT^{commit}" 2>/dev/null; then
  git -C "$REPO_DIR" fetch --quiet "$UPSTREAM_REPO" "$UPSTREAM_COMMIT"
fi
SOURCE_DIR="" STAGE_DIR=""
trap 'rm -rf ${SOURCE_DIR:+"$SOURCE_DIR"} ${STAGE_DIR:+"$STAGE_DIR"} "$ONNX_DIR/encoder.onnx.new" "$ONNX_DIR/decoder.onnx.new" "$ONNX_DIR/manifest.json.new"' EXIT
SOURCE_DIR="$(mktemp -d "$CACHE_DIR/source.XXXXXXXX")"
STAGE_DIR="$(mktemp -d "$CACHE_DIR/stage.XXXXXXXX")"
git -C "$REPO_DIR" archive "$UPSTREAM_COMMIT" | tar -xf - -C "$SOURCE_DIR"

PYTHON="${MUSIC2MIDI_PYTHON:-$CACHE_DIR/venv/bin/python}"
if [ ! -x "$PYTHON" ]; then
  echo "error: Python with torch and onnxruntime not found at $PYTHON. Set MUSIC2MIDI_PYTHON=/path/to/venv/bin/python." >&2
  exit 1
fi

FIXTURES="$ROOT/ios/KeylightTests/Fixtures"
"$PYTHON" "$SCRIPT_DIR/export_onnx.py" \
  --repo "$SOURCE_DIR" --ckpt "$CKPT_PATH" --out-dir "$STAGE_DIR" \
  --golden "$FIXTURES/golden_3s.json" --golden-wav "$FIXTURES/golden_3s.wav"

for pair in "encoder:$ENCODER_SHA256" "decoder:$DECODER_SHA256"; do
  name="${pair%%:*}"; want="${pair#*:}"; got="$(sha256_of "$STAGE_DIR/$name.onnx")"
  if [ "$got" != "$want" ] && [ "${KEYLIGHT_ONNX_ACCEPT_DIFFERENT:-0}" != "1" ]; then
    echo "error: $name.onnx is $got, the pin is $want (different torch/onnx versions? set KEYLIGHT_ONNX_ACCEPT_DIFFERENT=1 to accept it)" >&2
    exit 1
  fi
done
node "$SCRIPT_DIR/write-onnx-manifest.mjs" "$STAGE_DIR" --ckpt-sha256 "$CKPT_SHA256" --commit "$UPSTREAM_COMMIT" --precision weight-fp16

# Nothing reaches $ONNX_DIR before every file is verified: copy all three beside their targets, then rename (manifest last),
# so a failed copy never leaves a new encoder next to an old manifest.
for f in encoder.onnx decoder.onnx manifest.json; do mv -f "$STAGE_DIR/$f" "$ONNX_DIR/$f.new"; done
for f in encoder.onnx decoder.onnx manifest.json; do mv -f "$ONNX_DIR/$f.new" "$ONNX_DIR/$f"; done
echo "ONNX models ready in $ONNX_DIR"
