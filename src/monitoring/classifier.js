const { SCOPES } = require("../constants/scopes");
const { isValidIPv4 } = require("./direct-ping");
const { normalizeSensorStatus } = require("./evaluator");
const { isSensorPaused } = require("../prtg/inventory");

const config = require("../config/env");

// ============================================================
// CLASSIFICATION CATEGORIES
// ============================================================

const CLASSIFICATIONS = {
    ACTIVE_PRTG: "active_prtg",
    ACTIVE_ICMP: "active_icmp",
    PAUSED_PRTG: "paused_prtg",
    UNRESOLVED_PRTG: "unresolved_prtg",
    PIC_MANAGED: "pic_managed",
    DISABLED: "disabled"
};

const CLASSIFICATION_DISPLAY = {
    [CLASSIFICATIONS.ACTIVE_PRTG]: {
        icon: "📡",
        shortIcon: "📡",
        label: "ACTIVE PRTG"
    },
    [CLASSIFICATIONS.ACTIVE_ICMP]: {
        icon: "🌐",
        shortIcon: "🌐",
        label: "DIRECT PING"
    },
    [CLASSIFICATIONS.PAUSED_PRTG]: {
        icon: "⏸",
        shortIcon: "⏸",
        label: "PAUSED-ONLY"
    },
    [CLASSIFICATIONS.UNRESOLVED_PRTG]: {
        icon: "🧩",
        shortIcon: "🧩",
        label: "UNRESOLVED PRTG"
    },
    [CLASSIFICATIONS.PIC_MANAGED]: {
        icon: "👤",
        shortIcon: "👤",
        label: "PIC MANAGED"
    },
    [CLASSIFICATIONS.DISABLED]: {
        icon: "🚫",
        shortIcon: "🚫",
        label: "DISABLED"
    }
};

// ============================================================
// SENSOR STATUS HELPERS
// ============================================================

function sensorStatusToState(status) {
    if (!status) {
        return "UNKNOWN";
    }

    return normalizeSensorStatus(status);
}

function isSensorActive(status) {
    return !isSensorPaused(status);
}

// ============================================================
// CLASSIFY CUSTOMER
// ============================================================

function classifyCustomer(customer, inventoryItem, monitoringState, cfg) {

    const cfgDirectPing = cfg || config;

    if (!customer || !customer.enabled) {
        return {
            category: CLASSIFICATIONS.DISABLED,
            active: false,
            backend: null,
            state: null,
            reason: customer && !customer.enabled ? "disabled" : "unknown"
        };
    }

    const scope = customer.monitoring_scope || SCOPES.PRTG;

    if (scope === SCOPES.PIC_MANAGED) {
        return {
            category: CLASSIFICATIONS.PIC_MANAGED,
            active: false,
            backend: null,
            state: null,
            reason: "pic_managed"
        };
    }

    if (scope === SCOPES.NOT_IN_PRTG) {

        const directPingEnabled = cfgDirectPing.directPing && cfgDirectPing.directPing.enabled;
        const validIp = isValidIPv4(customer.ip);

        if (directPingEnabled && validIp) {
            return {
                category: CLASSIFICATIONS.ACTIVE_ICMP,
                active: true,
                backend: "icmp_ping",
                state: monitoringState ? monitoringState.current_state : null,
                reason: null
            };
        }

        return {
            category: CLASSIFICATIONS.ACTIVE_ICMP,
            active: false,
            backend: "icmp_ping",
            state: null,
            reason: directPingEnabled ? "invalid_ip" : "direct_ping_disabled"
        };
    }

    if (scope === SCOPES.PRTG) {

        const mapping = inventoryItem || {};

        if (
            !mapping ||
            mapping.mappingStatus !== "mapped" ||
            !mapping.prtgObjid
        ) {
            return {
                category: CLASSIFICATIONS.UNRESOLVED_PRTG,
                active: false,
                backend: null,
                state: null,
                reason: "mapping_missing"
            };
        }

        const sensorCount = mapping.sensorCount || 0;
        const activeSensorCount = mapping.activeSensorCount || 0;

        if (sensorCount > 0 && activeSensorCount === 0) {
            return {
                category: CLASSIFICATIONS.PAUSED_PRTG,
                active: false,
                backend: "prtg",
                state: null,
                reason: "all_sensors_paused"
            };
        }

        return {
            category: CLASSIFICATIONS.ACTIVE_PRTG,
            active: true,
            backend: "prtg",
            state: monitoringState ? monitoringState.current_state : null,
            reason: null
        };
    }

    return {
        category: CLASSIFICATIONS.DISABLED,
        active: false,
        backend: null,
        state: null,
        reason: "unknown_scope"
    };
}

// ============================================================
// BUILD CENTRALIZED SUMMARY
// ============================================================

function buildMonitoringSummary(inventoryOverride) {

    const { loadInventory } = require("../prtg/inventory");
    const { loadAllStates } = require("./state-store");

    const inventory = inventoryOverride || loadInventory();
    const allStates = loadAllStates();

    const stateByCustomer = {};
    for (const s of allStates) {
        stateByCustomer[s.customer_id] = s;
    }

    const summary = {
        totalCustomers: inventory.length,

        classifications: {
            [CLASSIFICATIONS.ACTIVE_PRTG]: 0,
            [CLASSIFICATIONS.ACTIVE_ICMP]: 0,
            [CLASSIFICATIONS.PAUSED_PRTG]: 0,
            [CLASSIFICATIONS.UNRESOLVED_PRTG]: 0,
            [CLASSIFICATIONS.PIC_MANAGED]: 0,
            [CLASSIFICATIONS.DISABLED]: 0
        },

        active: {
            total: 0,
            up: 0,
            down: 0,
            warning: 0,
            unusual: 0,
            unknown: 0
        },

        prtg: {
            targets: 0,
            up: 0,
            down: 0,
            warning: 0,
            unusual: 0,
            paused: 0,
            unknown: 0
        },

        icmp: {
            targets: 0,
            up: 0,
            down: 0,
            unknown: 0
        },

        pausedOnly: 0,
        unresolvedPrtg: 0,
        picManaged: 0,
        disabled: 0
    };

    for (const item of inventory) {

        const customer = {
            id: item.customerId,
            client_id: item.clientId,
            name: item.name,
            ip: item.ip,
            location: item.location,
            service_id: item.serviceId,
            description: item.description,
            enabled: item.enabled,
            monitoring_scope: item.monitoringScope
        };

        const state = stateByCustomer[item.customerId] || null;
        const classification = classifyCustomer(customer, item, state, config);

        summary.classifications[classification.category]++;

        if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {
            summary.pausedOnly++;
        } else if (classification.category === CLASSIFICATIONS.UNRESOLVED_PRTG) {
            summary.unresolvedPrtg++;
        } else if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {
            summary.picManaged++;
        } else if (classification.category === CLASSIFICATIONS.DISABLED) {
            summary.disabled++;
        }

        if (classification.active) {
            summary.active.total++;

            const currentState = classification.state || "UNKNOWN";
            const normalized = normalizeSensorStatus(currentState) || "UNKNOWN";

            if (classification.backend === "prtg") {
                summary.prtg.targets++;

                switch (normalized) {
                    case "UP": summary.prtg.up++; break;
                    case "DOWN": summary.prtg.down++; break;
                    case "WARNING": summary.prtg.warning++; break;
                    case "UNUSUAL": summary.prtg.unusual++; break;
                    case "PAUSED": summary.prtg.paused++; break;
                    default: summary.prtg.unknown++; break;
                }
            }

            if (classification.backend === "icmp_ping") {
                summary.icmp.targets++;

                switch (normalized) {
                    case "UP": summary.icmp.up++; break;
                    case "DOWN": summary.icmp.down++; break;
                    default: summary.icmp.unknown++; break;
                }
            }

            if (normalized === "UP") {
                summary.active.up++;
            } else if (normalized === "DOWN") {
                summary.active.down++;
            } else if (normalized === "WARNING") {
                summary.active.warning++;
            } else if (normalized === "UNUSUAL") {
                summary.active.unusual++;
            } else {
                summary.active.unknown++;
            }
        }
    }

    return summary;
}

// ============================================================
// FORMATTING HELPERS
// ============================================================

const TIMEZONE = "Asia/Makassar";

function formatDateTime(dateStr) {

    if (!dateStr) {
        return "-";
    }

    const date = new Date(dateStr);

    if (isNaN(date.getTime())) {
        return "-";
    }

    const formatted = date.toLocaleString("en-GB", {
        timeZone: TIMEZONE,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });

    return formatted.replace(",", " •") + " WITA";
}

function formatDateTimeRelative(dateStr) {

    return formatDateTime(dateStr);
}

const STATE_ICONS = {
    UP: "🟢",
    DOWN: "🔴",
    WARNING: "🟡",
    UNUSUAL: "🟠",
    PAUSED: "⏸",
    UNKNOWN: "⚪"
};

function stateIcon(state) {

    if (!state) {
        return "⚪";
    }

    const normalized = normalizeSensorStatus(state);

    return STATE_ICONS[normalized] || "⚪";
}

const STATE_LABELS = {
    UP: "UP",
    DOWN: "DOWN",
    WARNING: "WARNING",
    UNUSUAL: "UNUSUAL",
    PAUSED: "PAUSED",
    UNKNOWN: "UNKNOWN"
};

function stateLabel(state) {

    if (!state) {
        return "UNKNOWN";
    }

    const normalized = normalizeSensorStatus(state);

    return STATE_LABELS[normalized] || "UNKNOWN";
}

function formatStateDisplay(state) {

    return `${stateIcon(state)} ${stateLabel(state)}`;
}

function formatLatency(ms) {

    if (ms === null || ms === undefined || ms === "") {
        return "-";
    }

    const num = Number(ms);

    if (isNaN(num)) {
        return "-";
    }

    return `${num.toFixed(1)} ms`;
}

function formatPacketLoss(loss) {

    if (loss === null || loss === undefined || loss === "") {
        return "-";
    }

    const num = Number(loss);

    if (isNaN(num)) {
        return "-";
    }

    return `${num}%`;
}

function formatDuration(ms) {

    if (ms === null || ms === undefined || ms === "") {
        return "-";
    }

    const num = Number(ms);

    if (isNaN(num) || num < 0) {
        return "-";
    }

    if (num < 1000) {
        return `${num} ms`;
    }

    if (num < 60000) {
        return `${(num / 1000).toFixed(1)} s`;
    }

    const minutes = Math.floor(num / 60000);
    const seconds = Math.floor((num % 60000) / 1000);

    return `${minutes}m ${seconds}s`;
}

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";

function sectionSeparator() {
    return SEPARATOR;
}

const CLASSIFICATION_ICONS = {
    [CLASSIFICATIONS.ACTIVE_PRTG]: "📡",
    [CLASSIFICATIONS.ACTIVE_ICMP]: "🌐",
    [CLASSIFICATIONS.PAUSED_PRTG]: "⏸",
    [CLASSIFICATIONS.UNRESOLVED_PRTG]: "🧩",
    [CLASSIFICATIONS.PIC_MANAGED]: "👤",
    [CLASSIFICATIONS.DISABLED]: "🚫"
};

const CLASSIFICATION_LABELS = {
    [CLASSIFICATIONS.ACTIVE_PRTG]: "ACTIVE PRTG",
    [CLASSIFICATIONS.ACTIVE_ICMP]: "DIRECT PING",
    [CLASSIFICATIONS.PAUSED_PRTG]: "PAUSED-ONLY",
    [CLASSIFICATIONS.UNRESOLVED_PRTG]: "UNRESOLVED PRTG",
    [CLASSIFICATIONS.PIC_MANAGED]: "PIC MANAGED",
    [CLASSIFICATIONS.DISABLED]: "DISABLED"
};

function classificationIcon(category) {
    return CLASSIFICATION_ICONS[category] || "❓";
}

function classificationLabel(category) {
    return CLASSIFICATION_LABELS[category] || "UNKNOWN";
}

function classificationDisplay(category) {

    return `${classificationIcon(category)} ${classificationLabel(category)}`;
}

function safe(value, fallback = 0) {

    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    if (typeof value === "number" && isNaN(value)) {
        return fallback;
    }

    return value;
}

function isAlertEligible(category) {

    return category === CLASSIFICATIONS.ACTIVE_PRTG ||
        category === CLASSIFICATIONS.ACTIVE_ICMP;
}

// ============================================================
// CUSTOMER LIST ITEM FORMATTING
// ============================================================

function formatClientListItem(item, classification, state) {

    const icon = classificationIcon(classification.category);
    let statePart = "";

    if (classification.active) {
        statePart = ` • ${formatStateDisplay(state ? state.current_state : null)}`;
    }

    let secondLine = "";

    if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {
        secondLine = item.description || item.name;
    } else if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {
        secondLine = `Sensors: ${safe(item?.sensorCount, 0)} (${safe(item?.pausedSensorCount, 0)} paused)`;
    } else if (classification.category === CLASSIFICATIONS.UNRESOLVED_PRTG) {
        secondLine = "No mapping";
    } else if (classification.category === CLASSIFICATIONS.DISABLED) {
        secondLine = "Disabled";
    }

    const header = `#${item.clientId} ${item.name}`;
    const scope = icon;
    const line1 = `${scope} ${header}${statePart}`;

    const parts = [line1];

    if (item.description && item.description !== item.name) {
        if (secondLine) {
            parts.push(`${secondLine} • ${item.ip}`);
        } else {
            parts.push(`${item.description} • ${item.ip}`);
        }
    } else if (secondLine) {
        parts.push(`${secondLine} • ${item.ip}`);
    } else if (item.ip) {
        parts.push(item.ip);
    }

    return parts.join("\n");
}

// ============================================================
// CUSTOMER DETAIL FORMATTING
// ============================================================

function formatCustomerHeader(customer, classification) {

    const catIcon = classificationIcon(classification.category);

    const lines = [
        `${catIcon} CUSTOMER DETAIL`,
        "",
        `#${customer.client_id} ${customer.name}`
    ];

    if (customer.location) {
        lines.push(`📍 ${customer.location}`);
    }

    lines.push(`🌐 ${customer.ip}`);

    if (customer.service_id) {
        lines.push(`🆔 Service ID: ${customer.service_id}`);
    }

    if (customer.description && customer.description !== customer.name) {
        lines.push(`🔗 ${customer.description}`);
    }

    return lines;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    CLASSIFICATIONS,
    CLASSIFICATION_DISPLAY,

    classifyCustomer,
    buildMonitoringSummary,

    sensorStatusToState,
    isSensorActive,

    formatDateTime,
    formatDateTimeRelative,
    formatStateDisplay,
    stateIcon,
    stateLabel,
    formatLatency,
    formatPacketLoss,
    formatDuration,
    sectionSeparator,

    classificationIcon,
    classificationLabel,
    classificationDisplay,
    isAlertEligible,

    formatClientListItem,
    formatCustomerHeader
};
