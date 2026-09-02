#!/usr/bin/env sh
# Re-download the self-hosted webfonts from Google Fonts into vendor/fonts/.
#
# The files are committed, so you do not need this to build or deploy — it is
# here to make the vendoring reproducible and to bump versions later.
#
# Serving the fonts from our own origin means no third-party request on load,
# no gstatic dependency, and type that survives going offline.
#
# Usage:  sh vendor/fetch-fonts.sh

set -eu
DIR="$(dirname "$0")/fonts"
SPEC="family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&family=Yellowtail&display=swap"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

mkdir -p "$DIR"
curl -fsS -A "$UA" "https://fonts.googleapis.com/css2?$SPEC" -o "$DIR/google.css"

python3 - "$DIR" <<'PY'
import re, sys, pathlib, urllib.request, os
d = pathlib.Path(sys.argv[1])
css = (d / 'google.css').read_text()
blocks = re.findall(r'/\*\s*([\w\-\[\]]+)\s*\*/\s*(@font-face\s*\{.*?\})', css, re.S)
out, seen = [], {}
for subset, block in blocks:
    if subset not in ('latin', 'latin-ext'):
        continue                      # other scripts are never used by this app
    fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    url = re.search(r'url\((https://[^)]+\.woff2)\)', block).group(1)
    name = f"{fam.replace(' ', '')}-{subset}.woff2"
    if url not in seen:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        (d / name).write_bytes(urllib.request.urlopen(req, timeout=60).read())
        seen[url] = name
        print('fetched', name)
    out.append(block.replace(url, './' + seen[url]))
(d / 'fonts.css').write_text(
    "/* Self-hosted from Google Fonts — latin subsets only, fetched by\n"
    "   vendor/fetch-fonts.sh. Served from our own origin, so there is no\n"
    "   third-party request on load and the PWA keeps its type offline. */\n\n"
    + "\n\n".join(out) + "\n")
os.remove(d / 'google.css')
print('wrote fonts.css with', len(out), '@font-face rules')
PY
