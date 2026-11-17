#!/usr/bin/env bash
set -euo pipefail

# BillDrop Disaster Recovery Restore Script (Target RTO <= 2h)
BACKUP_FILE="${1:-}"

if [[ -z "${BACKUP_FILE}" ]]; then
  echo "Usage: $0 <path_or_s3_uri_to_backup_dump>"
  exit 1
fi

if [[ "${BACKUP_FILE}" =~ ^s3:// ]]; then
  LOCAL_FILE="/tmp/restore_$(date +%s).dump"
  echo "[$(date -u)] Downloading backup from R2 (${BACKUP_FILE})..."
  aws --endpoint-url "${R2_ENDPOINT_URL}" s3 cp "${BACKUP_FILE}" "${LOCAL_FILE}"
  BACKUP_FILE="${LOCAL_FILE}"
fi

echo "[$(date -u)] Restoring database from ${BACKUP_FILE}..."
PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" pg_restore \
  -h "${POSTGRES_HOST:-postgres}" \
  -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-billdrop}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  "${BACKUP_FILE}"

echo "[$(date -u)] Restore completed successfully."
