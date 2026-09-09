const db = require("../database/database");

// ============================================================
// QUERIES
// ============================================================

const getStateByCustomer = db.prepare(`
    SELECT * FROM customer_monitoring_state
    WHERE customer_id = ?
    LIMIT 1
`);

const insertState = db.prepare(`
    INSERT INTO customer_monitoring_state (
        customer_id,
        current_state,
        previous_state,
        last_operational_state,
        pending_state,
        pending_count,
        primary_sensor_objid,
        primary_sensor_name,
        last_value,
        last_checked_at,
        last_changed_at,
        monitoring_backend,
        last_latency_ms,
        last_packet_loss,
        last_alert_state,
        last_alert_at,
        updated_at
    )
    VALUES (
        @customer_id,
        @current_state,
        @previous_state,
        @last_operational_state,
        @pending_state,
        @pending_count,
        @primary_sensor_objid,
        @primary_sensor_name,
        @last_value,
        @last_checked_at,
        @last_changed_at,
        @monitoring_backend,
        @last_latency_ms,
        @last_packet_loss,
        @last_alert_state,
        @last_alert_at,
        @updated_at
    )
`);

const updateState = db.prepare(`
    UPDATE customer_monitoring_state
    SET
        current_state = @current_state,
        previous_state = @previous_state,
        last_operational_state = @last_operational_state,
        pending_state = @pending_state,
        pending_count = @pending_count,
        primary_sensor_objid = @primary_sensor_objid,
        primary_sensor_name = @primary_sensor_name,
        last_value = @last_value,
        last_checked_at = @last_checked_at,
        last_changed_at = @last_changed_at,
        monitoring_backend = @monitoring_backend,
        last_latency_ms = @last_latency_ms,
        last_packet_loss = @last_packet_loss,
        last_alert_state = @last_alert_state,
        last_alert_at = @last_alert_at,
        updated_at = @updated_at
    WHERE customer_id = @customer_id
`);

const getAllStates = db.prepare(`
    SELECT * FROM customer_monitoring_state
    ORDER BY customer_id ASC
`);

// ============================================================
// HELPERS
// ============================================================

function getNow() {
    return new Date().toISOString();
}

function isOperationalState(state) {
    return state === "UP" || state === "DOWN";
}

// ============================================================
// LOAD STATE
// ============================================================

function loadState(customerId) {

    return getStateByCustomer.get(customerId);
}

// ============================================================
// SAVE STATE
// ============================================================

function saveState(customerId, currentState, primarySensor, extra = {}) {

    const now = getNow();
    const existing = getStateByCustomer.get(customerId);

    let previousState = null;
    let lastOperationalState = null;
    let lastChangedAt = null;
    let pendingState = null;
    let pendingCount = 0;
    let lastAlertState = null;
    let lastAlertAt = null;

    if (existing) {
        previousState = existing.current_state;
        lastOperationalState = existing.last_operational_state;
        lastChangedAt = existing.last_changed_at;
        pendingState = existing.pending_state;
        pendingCount = existing.pending_count;
        lastAlertState = existing.last_alert_state;
        lastAlertAt = existing.last_alert_at;
    }

    if (isOperationalState(currentState)) {
        lastOperationalState = currentState;
    }

    const changedAt =
        existing && existing.current_state !== currentState
            ? now
            : (lastChangedAt || now);

    if (existing) {
        updateState.run({
            customer_id: customerId,
            current_state: currentState,
            previous_state: previousState,
            last_operational_state: lastOperationalState,
            pending_state: pendingState,
            pending_count: pendingCount,
            primary_sensor_objid: primarySensor?.objid || null,
            primary_sensor_name: primarySensor?.name || null,
            last_value: primarySensor?.lastvalue || null,
            last_checked_at: now,
            last_changed_at: changedAt,
            monitoring_backend: extra.backend || existing.monitoring_backend || "none",
            last_latency_ms: extra.latencyMs !== undefined ? extra.latencyMs : existing.last_latency_ms,
            last_packet_loss: extra.packetLoss !== undefined ? extra.packetLoss : existing.last_packet_loss,
            last_alert_state: lastAlertState,
            last_alert_at: lastAlertAt,
            updated_at: now
        });
    } else {
        insertState.run({
            customer_id: customerId,
            current_state: currentState,
            previous_state: null,
            last_operational_state: lastOperationalState,
            pending_state: null,
            pending_count: 0,
            primary_sensor_objid: primarySensor?.objid || null,
            primary_sensor_name: primarySensor?.name || null,
            last_value: primarySensor?.lastvalue || null,
            last_checked_at: now,
            last_changed_at: now,
            monitoring_backend: extra.backend || "none",
            last_latency_ms: extra.latencyMs !== undefined ? extra.latencyMs : null,
            last_packet_loss: extra.packetLoss !== undefined ? extra.packetLoss : null,
            last_alert_state: null,
            last_alert_at: null,
            updated_at: now
        });
    }

    return {
        previousState: previousState,
        currentState,
        lastOperationalState,
        pendingState,
        pendingCount,
        lastAlertState,
        changed: existing ? existing.current_state !== currentState : false
    };
}

// ============================================================
// SAVE TRANSITION RESULT
// ============================================================

function saveTransitionResult(customerId, result, event, extra = {}) {

    const now = getNow();
    const existing = getStateByCustomer.get(customerId);

    if (!existing) {
        return null;
    }

    let lastAlertState = existing.last_alert_state;
    let lastAlertAt = existing.last_alert_at;

    if (event) {
        lastAlertState = result.confirmedState;
        lastAlertAt = now;
    }

    updateState.run({
        customer_id: customerId,
        current_state: result.confirmedState,
        previous_state: existing.current_state,
        last_operational_state: result.confirmedState,
        pending_state: result.pendingState,
        pending_count: result.pendingCount,
        primary_sensor_objid: existing.primary_sensor_objid,
        primary_sensor_name: existing.primary_sensor_name,
        last_value: existing.last_value,
        last_checked_at: now,
        last_changed_at: result.event ? now : existing.last_changed_at,
        monitoring_backend: extra.backend || existing.monitoring_backend || "none",
        last_latency_ms: extra.latencyMs !== undefined ? extra.latencyMs : existing.last_latency_ms,
        last_packet_loss: extra.packetLoss !== undefined ? extra.packetLoss : existing.last_packet_loss,
        last_alert_state: lastAlertState,
        last_alert_at: lastAlertAt,
        updated_at: now
    });

    return {
        previousState: existing.current_state,
        currentState: result.confirmedState,
        lastOperationalState: result.confirmedState,
        pendingState: result.pendingState,
        pendingCount: result.pendingCount,
        lastAlertState,
        event
    };
}

// ============================================================
// LOAD ALL STATES
// ============================================================

function loadAllStates() {

    return getAllStates.all();
}

// ============================================================
// RESET MONITORING STATE
// ============================================================

function resetMonitoringState(customerId) {

    const now = getNow();

    const reset = db.prepare(`
        UPDATE customer_monitoring_state
        SET
            current_state = 'UNKNOWN',
            previous_state = NULL,
            last_operational_state = NULL,
            pending_state = NULL,
            pending_count = 0,
            primary_sensor_objid = NULL,
            primary_sensor_name = NULL,
            last_value = NULL,
            last_checked_at = NULL,
            last_changed_at = NULL,
            monitoring_backend = 'none',
            last_latency_ms = NULL,
            last_packet_loss = NULL,
            last_alert_state = NULL,
            last_alert_at = NULL,
            updated_at = ?
        WHERE customer_id = ?
    `);

    const result = reset.run(now, customerId);

    if (result.changes === 0) {

        const insertReset = db.prepare(`
            INSERT INTO customer_monitoring_state (
                customer_id,
                current_state,
                previous_state,
                last_operational_state,
                pending_state,
                pending_count,
                primary_sensor_objid,
                primary_sensor_name,
                last_value,
                last_checked_at,
                last_changed_at,
                monitoring_backend,
                last_latency_ms,
                last_packet_loss,
                last_alert_state,
                last_alert_at,
                updated_at
            )
            VALUES (
                ?,
                'UNKNOWN',
                NULL,
                NULL,
                NULL,
                0,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                'none',
                NULL,
                NULL,
                NULL,
                NULL,
                ?
            )
        `);

        insertReset.run(customerId, now);
    }

    console.log(
        `[MONITOR] State reset for customer ${customerId}`
    );
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    loadState,
    saveState,
    saveTransitionResult,
    loadAllStates,
    resetMonitoringState
};