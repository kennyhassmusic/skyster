#!/bin/bash
# Put the current game live on the public Skyster site (GitHub Pages): commit everything, push.
# GitHub rebuilds the site in about a minute; browsers may hold the old page for up to 10 minutes.
# Usage: tools/ship.sh "what changed"
set -euo pipefail
cd "$(dirname "$0")/.."
git add -A
if git diff --cached --quiet; then
  echo "Nothing new to ship."
else
  git commit -q -m "${1:-Update Skyster}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
git push -q origin main
echo "Shipped. Live shortly at https://kennyhassmusic.github.io/skyster/"
