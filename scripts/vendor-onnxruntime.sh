#!/bin/bash
# Vendor onnxruntime-web (MIT, Microsoft) into renderer/vendor/onnxruntime-web/ for the desktop piano cover worker.
# Pinned: the npm tarball's integrity, the SHA-256 of every file we copy, and the licence texts.
#   scripts/vendor-onnxruntime.sh           download from npm and jsDelivr, verify, copy
#   scripts/vendor-onnxruntime.sh --check   only verify the files already in the repo (no network)
set -euo pipefail

VERSION="1.31.1"
NPM_INTEGRITY="sha512-5GeH+bWQ+HxM10z7erGlsWqryrwMbSvm/1tkIsKTT48g0fI19VXVVC435t4t7VsPdSQeS7NmuZPXrQ73k82URw=="
SHA_ORT_MJS="c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234"
SHA_GLUE_MJS="30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3"
SHA_WASM="4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d"
SHA_LICENSE="2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"
SHA_NOTICES="143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3"
LICENSE_URL="https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v${VERSION}/LICENSE"
NOTICES_URL="https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v${VERSION}/ThirdPartyNotices.txt"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/renderer/vendor/onnxruntime-web"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
expect() { # file expected-sha
  local got
  got="$(sha256_of "$1")"
  if [ "$got" != "$2" ]; then echo "error: SHA-256 mismatch for $1 (expected $2, got $got)" >&2; exit 1; fi
}
verify_out() {
  expect "$OUT/ort.wasm.min.mjs" "$SHA_ORT_MJS"
  expect "$OUT/ort-wasm-simd-threaded.mjs" "$SHA_GLUE_MJS"
  expect "$OUT/ort-wasm-simd-threaded.wasm" "$SHA_WASM"
  expect "$OUT/LICENSE" "$SHA_LICENSE"
  expect "$OUT/ThirdPartyNotices.txt" "$SHA_NOTICES"
}

if [ "${1:-}" = "--check" ]; then
  verify_out
  echo "onnxruntime-web $VERSION files match the pinned SHA-256 values"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts "onnxruntime-web@$VERSION" >/dev/null
GOT_INTEGRITY="$(node -e "const l=require('./package-lock.json');console.log(l.packages['node_modules/onnxruntime-web'].integrity)")"
if [ "$GOT_INTEGRITY" != "$NPM_INTEGRITY" ]; then
  echo "error: npm integrity mismatch for onnxruntime-web@$VERSION (got $GOT_INTEGRITY)" >&2
  exit 1
fi
DIST="$TMP/node_modules/onnxruntime-web/dist"
curl -fsSL -o "$TMP/LICENSE" "$LICENSE_URL"
curl -fsSL -o "$TMP/ThirdPartyNotices.txt" "$NOTICES_URL"
expect "$DIST/ort.wasm.min.mjs" "$SHA_ORT_MJS"
expect "$DIST/ort-wasm-simd-threaded.mjs" "$SHA_GLUE_MJS"
expect "$DIST/ort-wasm-simd-threaded.wasm" "$SHA_WASM"
expect "$TMP/LICENSE" "$SHA_LICENSE"
expect "$TMP/ThirdPartyNotices.txt" "$SHA_NOTICES"

mkdir -p "$OUT"
cp "$DIST/ort.wasm.min.mjs" "$DIST/ort-wasm-simd-threaded.mjs" "$DIST/ort-wasm-simd-threaded.wasm" "$OUT/"
cp "$TMP/LICENSE" "$TMP/ThirdPartyNotices.txt" "$OUT/"
printf 'onnxruntime-web %s (MIT)\nnpm integrity %s\nSource: https://www.npmjs.com/package/onnxruntime-web/v/%s\nFiles: ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs, ort-wasm-simd-threaded.wasm (CPU WebAssembly with SIMD and threads; no WebGPU/JSEP build)\nLicence texts: LICENSE, ThirdPartyNotices.txt (microsoft/onnxruntime v%s)\n' \
  "$VERSION" "$NPM_INTEGRITY" "$VERSION" "$VERSION" > "$OUT/SOURCE.txt"
verify_out
echo "vendored onnxruntime-web $VERSION into $OUT"
