#!/bin/zsh
# Developer ID signs, notarizes and staples a built Keylight.app, then writes a fresh zip next to it.
#   scripts/sign-mac.sh <path/to/Keylight.app> [out.zip]
# Needs (all outside the repo, never committed):
#   KEYLIGHT_SIGN_DIR   folder with devid.key + devid.cer. A private keychain
#                       is made there once; the login keychain and the keychain search list are left as they were.
#   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER configure the App Store Connect API key used by notarytool.
# The Developer ID certificate can only be made by the Account Holder (developer.apple.com, Developer ID Application, G2).
set -euo pipefail
APP=${1:?usage: sign-mac.sh <Keylight.app> [out.zip]}
APP=${APP:A}
OUT=${2:-${APP:h}/Keylight-mac-signed.zip}
ROOT=${0:A:h:h}
DIR=${KEYLIGHT_SIGN_DIR:?Set KEYLIGHT_SIGN_DIR to the signing credential directory}
ASC_KEY_ID=${ASC_KEY_ID:?Set ASC_KEY_ID to the App Store Connect API key ID}
ASC_ISSUER=${ASC_ISSUER:?Set ASC_ISSUER to the App Store Connect issuer ID}
ASC_KEY=${ASC_KEY_PATH:?Set ASC_KEY_PATH to the App Store Connect API key file}
KC=$DIR/keylight-signing.keychain-db
ENT=$ROOT/scripts/mac-entitlements.plist
fail() { echo "error: $*" >&2; exit 1; }
[[ -d $APP && -f $DIR/devid.key && -f $DIR/devid.cer && -f $ASC_KEY && -f $ENT ]] || fail "missing app, devid.key/devid.cer in $DIR, the API key or $ENT"

# One-time private keychain (random password kept beside it, 0600). create-keychain adds it to the user search list,
# so the list is put back straight after. A failed setup removes the half-made keychain and the p12, so a rerun starts clean.
setup_keychain() {
  local SAVED P12PASS ok=0
  SAVED=("${(@f)$(security list-keychains -d user | sed 's/^ *"//; s/"$//')}")
  {
    ( umask 077; openssl rand -hex 24 > "$DIR/keychain.pass" )
    security create-keychain -p "$(<"$DIR/keychain.pass")" "$KC"
    security list-keychains -d user -s "${SAVED[@]}"
    security set-keychain-settings "$KC"      # no auto-lock timeout
    P12PASS=$(openssl rand -hex 12)
    openssl x509 -inform der -in "$DIR/devid.cer" -out "$DIR/devid.pem"
    ( umask 077
      openssl pkcs12 -export -legacy -inkey "$DIR/devid.key" -in "$DIR/devid.pem" -out "$DIR/devid.p12" -passout "pass:$P12PASS" 2>/dev/null \
        || openssl pkcs12 -export -inkey "$DIR/devid.key" -in "$DIR/devid.pem" -out "$DIR/devid.p12" -passout "pass:$P12PASS" )
    security unlock-keychain -p "$(<"$DIR/keychain.pass")" "$KC"
    security import "$DIR/devid.p12" -k "$KC" -P "$P12PASS" -T /usr/bin/codesign >/dev/null
    curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$DIR/DeveloperIDG2CA.cer"
    security import "$DIR/DeveloperIDG2CA.cer" -k "$KC" >/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(<"$DIR/keychain.pass")" "$KC" >/dev/null
    ok=1
  } always {
    rm -f "$DIR/devid.p12"
    security list-keychains -d user -s "${SAVED[@]}" || true
    (( ok )) || { security delete-keychain "$KC" 2>/dev/null || true; rm -f "$KC"; }
  }
}
[[ -f $KC ]] || setup_keychain
security unlock-keychain -p "$(<"$DIR/keychain.pass")" "$KC"
ID=$(security find-identity -v -p codesigning "$KC" | awk -F'"' '/Developer ID Application/ {print $2; exit}')
[[ -n $ID ]] || fail "no Developer ID Application identity in $KC"
echo "Signing as: $ID"

# Executables get the entitlements; libraries are signed plainly (entitlements mean nothing on a dylib).
sign_exe() { codesign --force --timestamp --options runtime --entitlements "$ENT" --keychain "$KC" -s "$ID" "$1"; }
sign_lib() { codesign --force --timestamp --options runtime --keychain "$KC" -s "$ID" "$1"; }
xattr -cr "$APP"
# 1. every Mach-O file (checked with `file`, whatever its name or mode), deepest first;
# 2. every nested bundle, deepest first; 3. the app.
n=0
for f in ${(f)"$(find "$APP/Contents" -type f | awk '{print length, $0}' | sort -rn | cut -d' ' -f2-)"}; do
  kind=$(file -b "$f")
  [[ $kind == *Mach-O* ]] || continue
  if [[ $kind == *executable* ]]; then sign_exe "$f" >/dev/null || fail "could not sign $f"
  else sign_lib "$f" >/dev/null || fail "could not sign $f"; fi
  (( ++n ))
done
for b in ${(f)"$(find "$APP/Contents" -type d \( -name '*.framework' -o -name '*.app' \) | awk '{print length, $0}' | sort -rn | cut -d' ' -f2-)"}; do
  if [[ $b == *.app ]]; then sign_exe "$b" >/dev/null; else sign_lib "$b" >/dev/null; fi
  (( ++n ))
done
sign_exe "$APP"
codesign --verify --deep --strict "$APP"
echo "signed $n nested items and the app"

# Notarize, staple, zip.
WORK=$(mktemp -d)
OUT_TMP=''
trap 'rm -rf "$WORK"; [[ -z $OUT_TMP ]] || rm -f "$OUT_TMP"' EXIT
TMPZ=$WORK/notarize.zip
ditto -c -k --keepParent "$APP" "$TMPZ"
xcrun notarytool submit "$TMPZ" --key "$ASC_KEY" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER" --wait --timeout 30m | tee "${APP:h}/notarize.log"
grep -q 'status: Accepted' "${APP:h}/notarize.log" || fail "notarization was not accepted (see ${APP:h}/notarize.log; xcrun notarytool log <id> ... for details)"
xcrun stapler staple "$APP"
spctl -a -vvv -t exec "$APP"
OUT_TMP=$(mktemp "${OUT}.XXXXXX")
ditto -c -k --keepParent "$APP" "$OUT_TMP"
mv -f "$OUT_TMP" "$OUT"
OUT_TMP=''
echo "done: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
