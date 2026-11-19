#!/bin/sh
# Shared CI checks (GitHub and Forgejo): JS syntax, Ghost theme validation, compose files, API smoke test.
set -eu
echo "== JS syntax"
for f in server.js ocr/server.js theme/assets/js/*.js; do node --check "$f"; done

echo "== Ghost theme (gscan: errors fail, warnings are fine)"
npx -y gscan theme

echo "== API smoke test"
DATA_DIR="$(mktemp -d)" PORT=3999 GHOST_URL=http://127.0.0.1:9 node server.js > /tmp/api.log 2>&1 &
pid=$!
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3999/api/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
kill "$pid" 2>/dev/null || true
[ -n "$ok" ] || { cat /tmp/api.log; echo "health check failed"; exit 1; }
echo "health ok"
