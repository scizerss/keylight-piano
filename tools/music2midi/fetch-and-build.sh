#!/bin/bash
# Fetch and verify the pinned Music2MIDI checkpoint, then build the Core ML packages for Xcode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${KEYLIGHT_MUSIC2MIDI_CACHE:-$SCRIPT_DIR/.cache}"
CKPT_DIR="$CACHE_DIR/ckpts"
REPO_DIR="${MUSIC2MIDI_REPO:-$CACHE_DIR/repo}"
COREML_DIR="${KEYLIGHT_MODELS_DIR:-$CACHE_DIR/coreml}"

CKPT_NAME="epoch.799-step.119200.ckpt"
CKPT_URL="https://github.com/ytinyui/music2midi/releases/download/0.1.0/${CKPT_NAME}"
CKPT_SHA256="c2423b5e7ff42be0d6fd768d94f8dbc2669b2ecf01e4b082e64b21ea31daade6"
UPSTREAM_REPO="https://github.com/ytinyui/music2midi.git"
UPSTREAM_COMMIT="e0d31d6606a04c6fde35e5a2e753daf155c20dfe"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

mkdir -p "$CKPT_DIR" "$COREML_DIR"
CKPT_PATH="$CKPT_DIR/$CKPT_NAME"

if [ -f "$CKPT_PATH" ]; then
  got="$(sha256_of "$CKPT_PATH")"
  if [ "$got" != "$CKPT_SHA256" ]; then
    echo "Existing checkpoint SHA-256 mismatch ($got); re-downloading..." >&2
    rm -f "$CKPT_PATH"
  fi
fi

if [ ! -f "$CKPT_PATH" ]; then
  echo "Downloading $CKPT_URL ..."
  tmp="${CKPT_PATH}.part"
  curl -fL --retry 3 -o "$tmp" "$CKPT_URL"
  got="$(sha256_of "$tmp")"
  if [ "$got" != "$CKPT_SHA256" ]; then
    rm -f "$tmp"
    echo "error: SHA-256 mismatch for $CKPT_NAME (expected $CKPT_SHA256, got $got)" >&2
    exit 1
  fi
  mv "$tmp" "$CKPT_PATH"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --filter=blob:none "$UPSTREAM_REPO" "$REPO_DIR"
fi
if ! git -C "$REPO_DIR" cat-file -e "$UPSTREAM_COMMIT^{commit}" 2>/dev/null; then
  git -C "$REPO_DIR" fetch --quiet "$UPSTREAM_REPO" "$UPSTREAM_COMMIT"
fi
SOURCE_DIR="$(mktemp -d "$CACHE_DIR/source.XXXXXXXX")"
trap 'rm -rf "$SOURCE_DIR"' EXIT
git -C "$REPO_DIR" archive "$UPSTREAM_COMMIT" | tar -xf - -C "$SOURCE_DIR"

PYTHON="${MUSIC2MIDI_PYTHON:-$CACHE_DIR/venv/bin/python}"
if [ ! -x "$PYTHON" ]; then
  echo "error: Python interpreter with torch + coremltools not found at $PYTHON." >&2
  echo "Set MUSIC2MIDI_PYTHON=/path/to/venv/bin/python and re-run." >&2
  exit 1
fi

"$PYTHON" "$SCRIPT_DIR/export_coreml.py" \
  --ckpt "$CKPT_PATH" \
  --repo "$SOURCE_DIR" \
  --out-dir "$COREML_DIR" \
  "$@"
