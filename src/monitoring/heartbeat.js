const db = require("../database/database");

// ============================================================
// QUERIES
// ============================================================

const getHeartbeat = db.prepare(`
    SELECT * FROM monitoring_heartbeat
    WHERE id = 1
    LIMIT 1
`);

const updateHeartbeat = db.prepare(`
    UPDATE monitoring_heartbeat
    SET
        last_cycle_at = @last_cycle_at,
        last_successful_cycle_at = @last_successful_cycle_at,
        last_cycle_duration_ms = @last_cycle_duration_ms,
        last_cycle_target_count = @last_cycle_target_count,
        last_error = @last_error,
        updated_at = @updated_at
    WHERE id = 1
`);

// ============================================================
// HELPERS
// ============================================================

function getNow() {
    return new Date().toISOString();
}

// ============================================================
// RECORD CYCLE
// ============================================================

function recordCycle(options) {

    const now = getNow();

    const {
        success,
        durationMs,
        targetCount,
        error
    } = options;

    const existing = getHeartbeat.get();

    updateHeartbeat.run({
        last_cycle_at: now,
        last_successful_cycle_at: success ? now : existing.last_successful_cycle_at,
        last_cycle_duration_ms: durationMs,
        last_cycle_target_count: targetCount,
        last_error: error || null,
        updated_at: now
    });
}

// ============================================================
// GET HEARTBEAT
// ============================================================

function getHeartbeatData() {

    return getHeartbeat.get();
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    recordCycle,
    getHeartbeatData
};