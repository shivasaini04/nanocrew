#!/bin/bash
# Backup the NanoCrew SQLite database.
#
# Usage:
#   ./scripts/backup-db.sh              # keeps last 7 backups (default)
#   ./scripts/backup-db.sh 14           # keeps last 14 backups
#
# Add to crontab for daily 3 AM backups:
#   0 3 * * * /path/to/nanocrew-main/scripts/backup-db.sh >> /var/log/nanocrew-backup.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

DB_FILE="$PROJECT_ROOT/store/messages.db"
BACKUP_DIR="$PROJECT_ROOT/store/backups"
KEEP="${1:-7}"
TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"
DEST="$BACKUP_DIR/messages-$TIMESTAMP.db"

if [ ! -f "$DB_FILE" ]; then
  echo "[backup-db] ERROR: database not found at $DB_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# SQLite's hot-backup: copy via the .backup command so the copy is
# consistent even if the orchestrator is writing concurrently.
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_FILE" ".backup '$DEST'"
else
  cp "$DB_FILE" "$DEST"
fi

SIZE="$(du -sh "$DEST" | cut -f1)"
echo "[backup-db] $(date -Iseconds)  saved $DEST ($SIZE)"

# Prune: keep the $KEEP most recent backups, delete the rest
BACKUP_COUNT="$(ls -1 "$BACKUP_DIR"/messages-*.db 2>/dev/null | wc -l)"
if [ "$BACKUP_COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/messages-*.db | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm "$old"
    echo "[backup-db] pruned $old"
  done
fi
