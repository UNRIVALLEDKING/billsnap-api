#!/usr/bin/env bash
# Deploy BillSnap to AWS Lightsail (Port 8002, 1 GB RAM micro profile)
# Usage:
#   Direct local build: ./deploy-lightsail.sh
#   Prebuilt GHCR image: GHCR_OWNER=<owner> TAG=sha-abc123 ./deploy-lightsail.sh
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.lightsail.yml)

ready() {
  "${COMPOSE[@]}" exec -T "$1" bun -e \
    "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

if [ -n "${IMAGE_TAG:-}" ] || ([ -n "${TAG:-}" ] && [ -n "${GHCR_OWNER:-}" ]); then
  export IMAGE_TAG="${IMAGE_TAG:-ghcr.io/${GHCR_OWNER}/billdrop-api:${TAG}}"
  echo ">> pulling prebuilt images for $IMAGE_TAG..."
  "${COMPOSE[@]}" pull api1 worker
else
  echo ">> building container image locally..."
  "${COMPOSE[@]}" build api1
fi

echo ">> starting postgres..."
"${COMPOSE[@]}" up -d --wait postgres

echo ">> running database migrations..."
"${COMPOSE[@]}" run --rm --no-deps api1 bun run migrate

echo ">> starting api1..."
"${COMPOSE[@]}" up -d --no-deps --wait api1

echo ">> starting worker..."
"${COMPOSE[@]}" up -d --no-deps worker

echo ">> starting caddy on port 8002..."
"${COMPOSE[@]}" up -d caddy

echo ">> verifying service readiness..."
ok=0
for _ in $(seq 1 15); do
  if ready "api1"; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "FAILED: api1 not ready" >&2; exit 1; }

echo ">> testing reverse proxy endpoint on port 8002..."
curl -fsS --retry 5 --retry-delay 2 "http://localhost:8002/ready" >/dev/null

echo ">> successfully deployed BillSnap on port 8002!"
