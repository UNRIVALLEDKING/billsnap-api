#!/usr/bin/env bash
set -euo pipefail

# BillDrop Database Backup Script (RPO <= 5m, RTO <= 2h)
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_DIR="/tmp/backups"
BACKUP_FILE="${BACKUP_DIR}/billdrop_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"

echo "[$(date -u)] Starting database dump..."
PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" pg_dump \
  -h "${POSTGRES_HOST:-postgres}" \
  -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-billdrop}" \
  -Fc \
  -Z 6 \
  -f "${BACKUP_FILE}"

echo "[$(date -u)] Backup created: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))"

# If R2/S3 environment is configured, upload to bucket
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  echo "[$(date -u)] Uploading backup to R2 storage..."
  aws --endpoint-url "${R2_ENDPOINT_URL}" \
    s3 cp "${BACKUP_FILE}" "s3://${BACKUP_S3_BUCKET}/backups/daily/billdrop_${TIMESTAMP}.dump"
  echo "[$(date -u)] Upload completed."
fi

# Clean up local backup file older than 7 days
find "${BACKUP_DIR}" -type f -name "*.dump" -mtime +7 -delete

echo "[$(date -u)] Backup job finished successfully."
