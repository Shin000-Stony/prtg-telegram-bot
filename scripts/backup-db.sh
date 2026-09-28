#!/usr/bin/env bash
#
# Backup/Restore for PRTG Telegram Bot SQLite database
#
# - Backup: uses SQLite backup API via Node helper (WAL-aware, consistent)
# - Restore: validates backup BEFORE stopping bot or touching target
#            fails closed if Docker status/stop is unavailable
#
# Environment:
#   DATA_DIR       (default: ./data)
#   DB_FILE        (default: prtg_bot.db)
#   BACKUP_DIR     (default: $DATA_DIR/backups)
#   COMPOSE_PROJECT_NAME  (default: directory name, for docker compose -p)
#   BACKUP_OFFLINE=true   skip Docker interactions (testing only)
#
# Usage (project root):
#   ./scripts/backup-db.sh backup
#   ./scripts/backup-db.sh restore <backup-file>
#   ./scripts/backup-db.sh list
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "${PROJECT_ROOT}")}"
export COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_ROOT}/docker-compose.yml}"

DATA_DIR="${DATA_DIR:-${PROJECT_ROOT}/data}"
DB_FILE="${DB_FILE:-prtg_bot.db}"
BACKUP_DIR="${BACKUP_DIR:-${DATA_DIR}/backups}"
DB_PATH="${DATA_DIR}/${DB_FILE}"
OFFLINE="${BACKUP_OFFLINE:-false}"

timestamp() { date +%Y%m%d_%H%M%S; }

list_backups() {
    echo "Backups in ${BACKUP_DIR}:"
    ls -lt "${BACKUP_DIR}"/*.db 2>/dev/null || echo "(none)"
}

check_docker_compose() {
    if ! command -v docker compose >/dev/null 2>&1; then
        echo "ERROR: docker compose not found" >&2
        return 1
    fi
    if [ "$OFFLINE" = "true" ]; then
        return 0
    fi
    # Verify compose file exists
    if [ ! -f "${COMPOSE_FILE}" ]; then
        echo "ERROR: Compose file not found: ${COMPOSE_FILE}" >&2
        return 1
    fi
    # Verify bot service is defined in compose project
    local services
    if ! services=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
        config --services 2>&1); then
        echo "ERROR: docker compose config failed: ${services}" >&2
        return 1
    fi
    if ! echo "${services}" | grep -qx "bot"; then
        echo "ERROR: 'bot' service not found in compose config" >&2
        return 1
    fi
    return 0
}

is_bot_running() {
    # Returns 0 (true) if bot is running, 1 (false) if not, or 2 on error
    local status
    status=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
        ps --format '{{.State}}' bot 2>&1) || {
        echo "ERROR: Failed to check bot container status: ${status}" >&2
        return 2
    }
    if [ "${status}" = "running" ]; then
        return 0
    else
        return 1
    fi
}

do_backup() {
    if [ ! -f "${DB_PATH}" ]; then
        echo "ERROR: Database not found at ${DB_PATH}" >&2
        return 1
    fi

    mkdir -p "${BACKUP_DIR}"
    local ts tmp_out final_out
    ts=$(timestamp)
    tmp_out="${BACKUP_DIR}/${DB_FILE}.tmp.${ts}.db"
    final_out="${BACKUP_DIR}/${DB_FILE}.backup.${ts}.db"

    # Use Node helper with SQLite backup API (WAL-aware)
    if ! node "${SCRIPT_DIR}/sqlite-backup.js" "${DB_PATH}" "${tmp_out}" >/dev/null 2>&1; then
        rm -f "${tmp_out}"
        echo "ERROR: Backup failed (sqlite-backup.js returned non-zero)" >&2
        return 1
    fi

    # Validate the backup BEFORE publishing the final name
    if ! node "${SCRIPT_DIR}/validate-db.js" "${tmp_out}" >/dev/null 2>&1; then
        rm -f "${tmp_out}"
        echo "ERROR: Backup validation failed (integrity or schema check)" >&2
        return 1
    fi

    # Handle timestamp collision
    if [ -e "${final_out}" ]; then
        local suffix=1
        while [ -e "${BACKUP_DIR}/${DB_FILE}.backup.${ts}.${suffix}.db" ]; do
            suffix=$((suffix + 1))
        done
        final_out="${BACKUP_DIR}/${DB_FILE}.backup.${ts}.${suffix}.db"
    fi

    mv "${tmp_out}" "${final_out}"
    echo "Backup created: ${final_out}"
    echo "Size: $(du -h "${final_out}" | cut -f1)"
}

do_restore() {
    local backup_file="${1:-}"

    # 1. Validate input backup before touching anything
    if [ -z "${backup_file}" ]; then
        echo "Usage: $0 restore <backup-file>" >&2
        return 1
    fi

    if [ ! -f "${backup_file}" ]; then
        echo "ERROR: Backup file not found: ${backup_file}" >&2
        return 1
    fi

    # Validate backup BEFORE touching target, Docker, or anything else
    if ! node "${SCRIPT_DIR}/validate-db.js" "${backup_file}" >/dev/null 2>&1; then
        echo "ERROR: Backup file failed validation (invalid SQLite or schema mismatch)" >&2
        return 1
    fi

    mkdir -p "${DATA_DIR}" "${BACKUP_DIR}"

    # 2. Prepare staging: copy backup to temp file and validate
    local tmp_staging="${DB_PATH}.restore.staging"
    cp "${backup_file}" "${tmp_staging}"

    # Validate staging copy before any Docker/target operations
    if ! node "${SCRIPT_DIR}/validate-db.js" "${tmp_staging}" >/dev/null 2>&1; then
        rm -f "${tmp_staging}"
        echo "ERROR: Staging copy failed validation — restore aborted" >&2
        echo "Target DB unchanged." >&2
        return 1
    fi
    echo "Staging validated successfully."

    # 3. Determine bot status through compose context (for non-offline mode)
    local was_running=false

    if [ "${OFFLINE}" = "true" ]; then
        echo "OFFLINE mode: skipping Docker interactions (operator confirms bot is stopped)" >&2
    else
        if ! check_docker_compose; then
            echo "ERROR: Docker compose unavailable — cannot determine bot status" >&2
            echo "  Set BACKUP_OFFLINE=true to restore without Docker." >&2
            rm -f "${tmp_staging}"
            return 1
        fi

        # Get bot container status — fail closed on Docker error (no `|| true`)
        local bot_status
        local bot_status_rc
        bot_status=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
            ps --format '{{.State}}' bot 2>/dev/null) || bot_status_rc=$?
        if [ "${bot_status_rc:-0}" -ne 0 ]; then
            echo "ERROR: Failed to check bot container status (Docker exit ${bot_status_rc})" >&2
            rm -f "${tmp_staging}"
            return 1
        fi

        # Only "running" means bot is up; any other non-empty state (paused, restarting, unknown)
        # is NOT safe — fail closed
        if [ "${bot_status}" = "running" ]; then
            was_running=true
        elif [ -n "${bot_status}" ]; then
            echo "ERROR: Bot container in state '${bot_status}' — cannot safely restore" >&2
            echo "  Stop/restart bot manually, then retry restore." >&2
            rm -f "${tmp_staging}"
            return 1
        fi
        # Empty output = not running (container not found)
    fi

    # 4. Stop bot if running, then verify it stopped
    if [ "${was_running}" = "true" ]; then
        echo "Stopping bot container..."
        local stop_status
        stop_status=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
            stop bot 2>&1) || {
            echo "ERROR: Failed to stop bot container: ${stop_status}" >&2
            echo "Restore aborted — target DB unchanged." >&2
            rm -f "${tmp_staging}"
            return 1
        }
        # Verify bot actually stopped — whitelist known stopped states
        sleep 2
        local verify_status
        local verify_rc=0
        verify_status=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
            ps --format '{{.State}}' bot 2>/dev/null) || verify_rc=$?

        # Fail closed on Docker command error
        if [ "${verify_rc}" -ne 0 ]; then
            echo "ERROR: Cannot verify bot stopped (Docker exit ${verify_rc})" >&2
            echo "Restore aborted — target DB/WAL/SHM unchanged." >&2
            rm -f "${tmp_staging}"
            return 1
        fi

        # Whitelist: empty (container not found) = stopped = safe
        # Any non-empty state (running, paused, restarting, unknown) = NOT safe
        if [ -n "${verify_status}" ]; then
            echo "ERROR: Bot not stopped — container state is '${verify_status}' (expected empty/stopped)" >&2
            echo "Refusing to proceed with restore." >&2
            echo "Target DB/WAL/SHM unchanged." >&2
            rm -f "${tmp_staging}"
            return 1
        fi
    fi

    # 5. Secure target lama (recovery backup for healthy target, quarantine for corrupted)
    local recovery_file=""

    if [ -f "${DB_PATH}" ]; then
        # Validate target is a healthy DB before using it as recovery source
        if node "${SCRIPT_DIR}/validate-db.js" "${DB_PATH}" >/dev/null 2>&1; then
            local recovery_ts
            recovery_ts=$(timestamp)
            recovery_file="${BACKUP_DIR}/${DB_FILE}.recovery.${recovery_ts}.db"
            if ! node "${SCRIPT_DIR}/sqlite-backup.js" "${DB_PATH}" "${recovery_file}" >/dev/null 2>&1; then
                echo "ERROR: Failed to create recovery backup — aborting before overwrite" >&2
                echo "Target DB unchanged." >&2
                rm -f "${tmp_staging}"
                return 1
            fi
            echo "Recovery backup saved: ${recovery_file}"
        else
            # Target DB is corrupted — quarantine DB + WAL/SHM
            # DB file MUST be quarantined (required for swap)
            local quarantine_ts
            quarantine_ts=$(timestamp)
            echo "WARNING: Target DB failed validation — quarantining existing files" >&2

            if ! mv "${DB_PATH}" "${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}" 2>/dev/null; then
                echo "ERROR: Failed to quarantine corrupted DB file — restore aborted" >&2
                rm -f "${tmp_staging}"
                return 1
            fi
            echo "Quarantined: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}"

            # WAL/SHM: skip if absent, MUST succeed if present
            if [ -f "${DB_PATH}-wal" ]; then
                if ! mv "${DB_PATH}-wal" "${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.wal" 2>/dev/null; then
                    echo "ERROR: Failed to quarantine WAL file — restore aborted" >&2
                    echo "Quarantined DB: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}" >&2
                    rm -f "${tmp_staging}"
                    return 1
                fi
                echo "Quarantined: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.wal"
            fi

            if [ -f "${DB_PATH}-shm" ]; then
                if ! mv "${DB_PATH}-shm" "${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.shm" 2>/dev/null; then
                    echo "ERROR: Failed to quarantine SHM file — restore aborted" >&2
                    echo "Quarantined DB: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}" >&2
                    if [ -f "${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.wal" ]; then
                        echo "Quarantined WAL: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.wal" >&2
                    fi
                    rm -f "${tmp_staging}"
                    return 1
                fi
                echo "Quarantined: ${BACKUP_DIR}/${DB_FILE}.quarantine.${quarantine_ts}.shm"
            fi
        fi
    fi

    # 6. Atomic swap: validated staging → target
    # Set permissions for container (UID 1000 per docker-compose)
    chown 1000:1000 "${tmp_staging}" 2>/dev/null || true
    chmod 664 "${tmp_staging}"
    mv "${tmp_staging}" "${DB_PATH}"

    # Clean up stale WAL/SHM from the OLD db if writer left any before swap
    [ -f "${DB_PATH}-wal" ]  && rm -f "${DB_PATH}-wal"
    [ -f "${DB_PATH}-shm" ] && rm -f "${DB_PATH}-shm"

    echo "Restore complete."

    # 7. Restart only if previously running and restore succeeded
    if [ "${was_running}" = "true" ]; then
        echo "Bot was running before restore. Starting bot container..."
        local start_status
        start_status=$(docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" \
            start bot 2>&1) || {
            echo "ERROR: Bot failed to start after restore" >&2
            echo "DB restored but bot is STOPPED." >&2
            echo "Recovery backup available: ${recovery_file:-N/A}" >&2
            return 1
        }
        echo "Bot started successfully."
    else
        echo "Bot was not running before restore. Not starting container."
    fi

    if [ -n "${recovery_file}" ]; then
        echo "Recovery backup: ${recovery_file}"
    fi
}

case "${1:-}" in
    backup)
        do_backup
        ;;
    restore)
        do_restore "${2:-}"
        ;;
    list)
        list_backups
        ;;
    *)
        echo "Usage: $0 {backup|restore <backup-file>|list}" >&2
        exit 1
        ;;
esac
