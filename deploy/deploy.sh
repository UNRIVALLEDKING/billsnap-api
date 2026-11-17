#!/usr/bin/env bash
# Usage (on the VPS, in /srv/billdrop): GHCR_OWNER=<owner> TAG=sha-abc123 ./deploy.sh
# Optional: COMPOSE_FILES="-f docker-compose.yml -f docker-compose.staging.yml", SMOKE_URL=https://api.example.com
set -euo pipefail

cd "$(dirname "$0")"
: "${TAG:?set TAG, e.g. sha-abc123}"
: "${GHCR_OWNER:?set GHCR_OWNER}"
export TAG GHCR_OWNER

# shellcheck disable=SC2206
COMPOSE=(docker compose ${COMPOSE_FILES:--f docker-compose.yml})

ready() { # ready <service>: exec /ready inside the container
  "${COMPOSE[@]}" exec -T "$1" bun -e \
    "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

echo ">> pull $TAG"
"${COMPOSE[@]}" pull api1 api2 worker

echo ">> start postgres"
"${COMPOSE[@]}" up -d --wait postgres

echo ">> migrate"
"${COMPOSE[@]}" run --rm --no-deps api1 bun run migrate

echo ">> rolling api restart"
for svc in api1 api2; do
  "${COMPOSE[@]}" up -d --no-deps --wait "$svc"
done

echo ">> worker restart"
"${COMPOSE[@]}" up -d --no-deps worker

echo ">> caddy"
"${COMPOSE[@]}" up -d caddy

echo ">> smoke test /ready"
for svc in api1 api2; do
  ok=0
  for _ in $(seq 1 15); do
    if ready "$svc"; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "FAILED: $svc not ready" >&2; exit 1; }
done
if [ -n "${SMOKE_URL:-}" ]; then
  curl -fsS --retry 5 --retry-delay 2 "$SMOKE_URL/ready" >/dev/null
fi

# Record the tag (keep the previous one for rollback).
[ -f .deployed_tag ] && cp .deployed_tag .previous_tag
echo "$TAG" > .deployed_tag
echo ">> deployed $TAG"
