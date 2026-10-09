#!/usr/bin/env bash
# HTML -> PDF with headless Chrome. beta-004 is a copy of beta-003, so the two files are byte-identical.
set -euo pipefail
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
for page in html/*.html; do
  out="$(basename "${page%.html}").pdf"
  rm -f "$out"
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="$PWD/$out" "file://$PWD/$page" 2>/dev/null
  [ -s "$out" ] || { echo "Chrome produced no $out" >&2; exit 1; }
done
cp beta-003.pdf beta-004.pdf
ls -1 *.pdf | wc -l
shasum -a 256 beta-003.pdf beta-004.pdf
