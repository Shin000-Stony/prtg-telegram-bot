// ============================================================
// MONITORING STATUS EVALUATOR
// ============================================================

// ============================================================
// NORMALIZE SENSOR STATUS
// ============================================================

function normalizeSensorStatus(status) {

    if (!status) {
        return "UNKNOWN";
    }

    const normalized = String(status).trim().toUpperCase();

    if (normalized.includes("UP")) {
        return "UP";
    }

    if (normalized.includes("DOWN")) {
        return "DOWN";
    }

    if (normalized.includes("WARNING")) {
        return "WARNING";
    }

    if (normalized.includes("UNUSUAL")) {
        return "UNUSUAL";
    }

    if (normalized.includes("PAUSED")) {
        return "PAUSED";
    }

    return "UNKNOWN";
}

// ============================================================
// EVALUATE CUSTOMER STATE
// ============================================================

function evaluateCustomerState(primarySensor) {

    if (!primarySensor) {
        return "UNMAPPED";
    }

    if (!primarySensor.status) {
        return "UNKNOWN";
    }

    const status = normalizeSensorStatus(primarySensor.status);

    if (status === "PAUSED") {
        return "PAUSED";
    }

    return status;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    normalizeSensorStatus,
    evaluateCustomerState
};