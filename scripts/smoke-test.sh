#!/usr/bin/env bash
# End-to-end smoke test for the eventlens upload chain.
# Tests: /sign → PUT to R2 → /meta → public read. No secrets are hardcoded;
# the passcode is read from a hidden prompt.
set -euo pipefail

WORKER="https://eventlens-worker.angelos-papamichail.workers.dev"
read -rsp "Passcode: " PASSCODE; echo

ID="smoke-$(uuidgen | tr 'A-Z' 'a-z')"
DATE="$(date +%F)"
echo "→ id=$ID date=$DATE"

echo "1) /sign ..."
SIGN=$(curl -fsS -X POST "$WORKER/sign" \
  -H "x-passcode: $PASSCODE" -H "content-type: application/json" \
  -d "{\"id\":\"$ID\",\"eventDate\":\"$DATE\",\"originalName\":\"smoke.avif\"}")
UPLOAD_URL=$(printf '%s' "$SIGN" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadUrl'])")
PUBLIC_URL=$(printf '%s' "$SIGN" | python3 -c "import sys,json;print(json.load(sys.stdin)['publicUrl'])")
echo "   ok → $PUBLIC_URL"

echo "2) PUT to R2 ..."
printf 'fake-avif-bytes-for-smoke-test' > /tmp/eventlens-smoke.bin
curl -fsS -X PUT "$UPLOAD_URL" -H "content-type: image/avif" --data-binary @/tmp/eventlens-smoke.bin -o /dev/null
echo "   ok"

echo "3) /meta ..."
curl -fsS -X POST "$WORKER/meta" \
  -H "x-passcode: $PASSCODE" -H "content-type: application/json" \
  -d "{\"id\":\"$ID\",\"original_name\":\"smoke.avif\",\"width\":100,\"height\":50,\"bytes\":30}" -o /dev/null
echo "   ok"

echo "4) public read ..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_URL")
echo "   GET $PUBLIC_URL → $CODE"

echo "5) re-sign confirmed id (expect 409) ..."
RC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WORKER/sign" \
  -H "x-passcode: $PASSCODE" -H "content-type: application/json" \
  -d "{\"id\":\"$ID\",\"eventDate\":\"$DATE\"}")
echo "   re-sign → $RC"

rm -f /tmp/eventlens-smoke.bin
echo
[ "$CODE" = "200" ] && [ "$RC" = "409" ] && echo "✅ PASS — full chain works (id=$ID)" || echo "⚠ CHECK — public=$CODE resign=$RC"
echo "Cleanup test row:  bunx wrangler d1 execute eventlens --remote --command \"DELETE FROM photos WHERE id='$ID'\""
