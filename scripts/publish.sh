#!/usr/bin/env bash
# Upload a state's county files to its release, one at a time. GitHub allows ~1,000 uploads an hour per
# repository; when that runs out, wait for the hourly reset and carry on.
set -u
TAG="$1"
shopt -s nullglob
files=(out/*.json)
if [ ${#files[@]} -eq 0 ]; then echo "nothing to publish"; exit 0; fi

wait_for_reset() {
  local reset now
  reset=$(gh api rate_limit --jq .resources.core.reset 2>/dev/null || echo 0)
  now=$(date +%s)
  local secs=$(( reset - now + 15 ))
  [ "$secs" -lt 60 ] && secs=60
  echo "GitHub upload limit reached; waiting $(( secs / 60 )) min for it to reset"
  sleep "$secs"
}

retry() {
  for attempt in $(seq 1 12); do
    if out=$("$@" 2>&1); then return 0; fi
    if grep -qi "rate limit" <<<"$out"; then wait_for_reset; else echo "$out" | tail -2; sleep 20; fi
  done
  echo "giving up: $*"
  return 1
}

gh release view "$TAG" >/dev/null 2>&1 || retry gh release create "$TAG" --title "Roads: ${TAG#roads-}" \
  --notes "County road files for the Roads Less Traveled app. Road data © OpenStreetMap contributors, ODbL. Rebuilt monthly."
failed=0
n=0
for f in "${files[@]}"; do
  retry gh release upload "$TAG" "$f" --clobber || failed=$((failed + 1))
  n=$((n + 1))
  [ $((n % 50)) -eq 0 ] && echo "$n of ${#files[@]} uploaded"
done
echo "uploaded $((n - failed)) of ${#files[@]} files"
[ "$failed" -eq 0 ]
