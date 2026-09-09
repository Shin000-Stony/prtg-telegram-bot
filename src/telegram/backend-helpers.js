const { SCOPES } = require("../constants/scopes");

// ============================================================
// BACKEND HELPERS
// ============================================================

function backendLabel(backend) {

    switch (backend) {
        case "prtg":
            return "📡 PRTG SENSOR";
        case "icmp_ping":
            return "🌐 DIRECT ICMP PING";
        case "none":
            return "None";
        default:
            return "❓ UNKNOWN";
    }
}

function backendShort(backend) {

    switch (backend) {
        case "prtg":
            return "📡 PRTG";
        case "icmp_ping":
            return "🌐 DIRECT PING";
        case "none":
            return "None";
        default:
            return "❓";
    }
}

function getExpectedBackend(scope) {

    switch (scope) {
        case SCOPES.PRTG:
            return "prtg";
        case SCOPES.NOT_IN_PRTG:
            return "icmp_ping";
        case SCOPES.PIC_MANAGED:
            return "none";
        default:
            return "none";
    }
}

function formatLatency(ms) {

    if (ms === null || ms === undefined) {
        return "-";
    }

    const fixed = Number(ms).toFixed(1);

    return `${fixed} ms`;
}

function formatPacketLoss(loss) {

    if (loss === null || loss === undefined) {
        return "-";
    }

    return `${Number(loss)}%`;
}

function getAlertingStatus(customer, state, monitoringBackend, globalAlertsEnabled) {

    if (!customer.enabled) {
        return {
            enabled: false,
            label: "Disabled"
        };
    }

    if (!globalAlertsEnabled) {
        return {
            enabled: false,
            label: "⚠️ GLOBAL ALERTS DISABLED"
        };
    }

    const scope = customer.monitoring_scope || SCOPES.PRTG;

    if (scope === SCOPES.PIC_MANAGED) {
        return {
            enabled: false,
            label: "Disabled"
        };
    }

    if (!state || state === "UNKNOWN" || state === "UNMAPPED" || state === "PAUSED") {
        return {
            enabled: false,
            label: "Disabled"
        };
    }

    return {
        enabled: true,
        label: "✅ ENABLED"
    };
}

function getMonitoringBackendFromState(monitoringState, expectedBackend) {

    if (!monitoringState) {
        return expectedBackend;
    }

    const observed = monitoringState.monitoring_backend;

    if (observed && observed !== "none") {
        return observed;
    }

    return expectedBackend;
}

module.exports = {
    backendLabel,
    backendShort,
    getExpectedBackend,
    formatLatency,
    formatPacketLoss,
    getAlertingStatus,
    getMonitoringBackendFromState
};
