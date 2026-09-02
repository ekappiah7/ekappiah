#!/usr/bin/env sh
# Download the Firebase browser SDK into vendor/firebase/ so the app can serve
# it from its own origin instead of gstatic.com.
#
# Why you might want this:
#   - some networks and captive portals block gstatic.com outright
#   - same-origin means one fewer DNS + TLS handshake on a slow connection
#   - the service worker can then cache it, so a cold start works offline
#
# Usage:  sh expenses/vendor/fetch-sdk.sh
# Then add  "sdk_base": "/expenses/vendor/firebase"  to the config you paste
# into Settings → Family sharing.

set -eu

VERSION="${FIREBASE_SDK_VERSION:-10.14.1}"
DIR="$(dirname "$0")/firebase"
BASE="https://www.gstatic.com/firebasejs/$VERSION"

mkdir -p "$DIR"
for module in firebase-app.js firebase-auth.js firebase-firestore.js; do
  printf 'fetching %s ... ' "$module"
  curl -fsS -o "$DIR/$module" "$BASE/$module"
  # The published builds import each other by absolute gstatic URL, which would
  # defeat the point of hosting them here. Point them at their neighbours.
  sed -i.bak "s|$BASE/|./|g" "$DIR/$module"
  rm -f "$DIR/$module.bak"
  printf '%s bytes\n' "$(wc -c < "$DIR/$module" | tr -d ' ')"
done

echo "Done. Firebase SDK $VERSION is in $DIR"
