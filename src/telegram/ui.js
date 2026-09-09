const {
    CLASSIFICATIONS,
    classificationIcon,
    classificationLabel,
    formatStateDisplay,
    formatLatency,
    formatPacketLoss,
    formatDateTime,
    formatDuration,
    isAlertEligible
} = require("../monitoring/classifier");

const {
    backendLabel,
    getExpectedBackend,
    getMonitoringBackendFromState,
    getAlertingStatus
} = require("./backend-helpers");

const {
    SCOPES,
    scopeDisplay
} = require("../constants/scopes");

const config = require("../config/env");

// ============================================================
// CONSTANTS
// ============================================================

const SEP = "━━━━━━━━━━━━━━━━━━━━";

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(text) {

    if (text === null || text === undefined) {
        return "";
    }

    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ============================================================
// SEPARATOR
// ============================================================

function separator() {
    return SEP;
}

// ============================================================
// SAFE VALUE
// ============================================================

function safe(value, fallback = "-") {

    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    if (typeof value === "number" && isNaN(value)) {
        return fallback;
    }

    return value;
}

// ============================================================
// SCOPE LABEL
// ============================================================

function formatScopeLabel(scope) {

    const s = scope || "prtg";

    if (s === SCOPES.PRTG || s === "prtg") {
        return "📡 PRTG";
    }

    if (s === SCOPES.NOT_IN_PRTG || s === "not_in_prtg") {
        return "🚫 NOT IN PRTG";
    }

    if (s === SCOPES.PIC_MANAGED || s === "pic_managed") {
        return "👤 PIC MANAGED";
    }

    return safe(s);
}

// ============================================================
// OPERATOR CARD BUILDER
// ============================================================

function operatorCard(title, identityLines, ...sections) {

    const lines = [];

    lines.push(title);
    lines.push("");

    lines.push(...identityLines);
    lines.push("");

    lines.push(SEP);
    lines.push("");

    for (let i = 0; i < sections.length; i++) {

        const section = sections[i];

        lines.push(...section);

        if (i < sections.length - 1) {
            lines.push("");
            lines.push(SEP);
            lines.push("");
        }
    }

    return lines;
}

// ============================================================
// SECTION BUILDER
// ============================================================

function section(title, ...bodyLines) {

    const lines = [];

    if (title) {
        lines.push(title);
    }

    lines.push(...bodyLines);

    return lines;
}

// ============================================================
// FOOTER
// ============================================================

function formatFooter(extraLines = []) {

    const lines = [];

    for (const line of extraLines) {
        lines.push(line);
    }

    return lines;
}

// ============================================================
// CUSTOMER IDENTITY
// ============================================================

function formatCustomerIdentity(customer) {

    const lines = [];

    lines.push(`#${customer.client_id} ${customer.name}`);

    if (customer.location) {
        lines.push(`📍 ${customer.location}`);
    }

    lines.push(`🌐 ${customer.ip}`);

    if (customer.service_id) {
        lines.push(`🆔 ${customer.service_id}`);
    }

    if (customer.description && customer.description !== customer.name) {
        lines.push(`🔗 ${customer.description}`);
    }

    return lines;
}

function formatCustomerIdentityCompact(customer) {

    const lines = [
        `#${customer.client_id} ${customer.name}`,
        `🌐 ${customer.ip}`
    ];

    return lines;
}

// ============================================================
// MESSAGE FORMATTERS (Minimal Message family)
// ============================================================

function successMessage(title, bodyLines = []) {

    const lines = [];

    lines.push(`✅ ${title}`);
    lines.push("");

    if (bodyLines.length > 0) {
        lines.push(...bodyLines);
        lines.push("");
    }

    return lines.join("\n");
}

function errorMessage(message, detail = null) {

    const lines = [];

    lines.push(`❌ ${message}`);

    if (detail) {
        lines.push("");
        lines.push(detail);
    }

    return lines.join("\n");
}

function warningMessage(message, detail = null) {

    const lines = [];

    lines.push(`⚠️ ${message}`);

    if (detail) {
        lines.push("");
        lines.push(detail);
    }

    return lines.join("\n");
}

function accessDeniedMessage() {

    return "⛔ ACCESS DENIED\n\nThis command is only available for admins.";
}

function infoMessage(message, detail = null) {

    const lines = [];

    lines.push(`ℹ️ ${message}`);

    if (detail) {
        lines.push("");
        lines.push(detail);
    }

    return lines.join("\n");
}

// ============================================================
// CONFIRMATION MESSAGE
// ============================================================

function confirmationMessage(title, identityLines, bodyLines, confirmCommand, cancelCommand = "/cancel") {

    const lines = [];

    lines.push(`⚠️ ${title}`);
    lines.push("");

    lines.push(...identityLines);
    lines.push("");

    lines.push(SEP);
    lines.push("");

    lines.push(...bodyLines);

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push(`✅ ${confirmCommand}`);
    lines.push(`❌ ${cancelCommand}`);

    return lines.join("\n");
}

// ============================================================
// STATUS SUMMARY RENDER
// ============================================================

function renderStatusSummary(summary) {

    const now = new Date().toISOString();
    const timestamp = formatDateTime(now);

    const lines = [
        "📊 MONITORING STATUS",
        ""
    ];

    if (summary.active.down > 0) {
        lines.push("🔴 ATTENTION REQUIRED");
    } else if (summary.active.warning > 0 || summary.active.unusual > 0) {
        lines.push("🟡 DEGRADED");
    } else {
        lines.push("🟢 ALL SYSTEMS NORMAL");
    }

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("📡 PRTG");
    lines.push("");
    lines.push("Targets");
    lines.push(String(summary.prtg.targets));
    lines.push("🟢 UP");
    lines.push(String(summary.prtg.up));
    lines.push("🔴 DOWN");
    lines.push(String(summary.prtg.down));
    lines.push("🟡 WARNING");
    lines.push(String(summary.prtg.warning));
    lines.push("🟠 UNUSUAL");
    lines.push(String(summary.prtg.unusual));
    lines.push("⚪ UNKNOWN");
    lines.push(String(summary.prtg.unknown));

    lines.push("");
    lines.push("🌐 DIRECT PING");
    lines.push("");
    lines.push("Targets");
    lines.push(String(summary.icmp.targets));
    lines.push("🟢 UP");
    lines.push(String(summary.icmp.up));
    lines.push("🔴 DOWN");
    lines.push(String(summary.icmp.down));
    lines.push("⚪ UNKNOWN");
    lines.push(String(summary.icmp.unknown));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("📈 ACTIVE MONITORING");
    lines.push("");
    lines.push("🟢 UP");
    lines.push(String(summary.active.up));
    lines.push("🔴 DOWN");
    lines.push(String(summary.active.down));
    lines.push("⚪ UNKNOWN");
    lines.push(String(summary.active.unknown));
    lines.push("");
    lines.push("Total");
    lines.push(String(summary.active.total));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("📋 OTHER CUSTOMERS");
    lines.push("");
    lines.push("⏸ Paused");
    lines.push(String(summary.pausedOnly));
    lines.push("🧩 Unresolved");
    lines.push(String(summary.unresolvedPrtg));
    lines.push("👤 PIC Managed");
    lines.push(String(summary.picManaged));
    lines.push("🚫 Disabled");
    lines.push(String(summary.disabled));
    lines.push("");
    lines.push("Total Customers");
    lines.push(String(summary.totalCustomers));

    lines.push("");
    lines.push(SEP);
    lines.push("");
    lines.push(`🕒 ${timestamp}`);

    return lines.join("\n");
}

// ============================================================
// CUSTOMER STATUS DETAIL
// ============================================================

function renderCustomerStatus(customer, inventoryItem, classification, monitoringState) {

    const catIcon = classificationIcon(classification.category);
    const title = `${catIcon} CUSTOMER STATUS`;
    const identity = formatCustomerIdentity(customer);

    if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {

        return operatorCard(
            title,
            identity,
            section(
                "📡 PRTG",
                "",
                "Mapping",
                "✅ MAPPED",
                "",
                "State",
                "⏸ PAUSED-ONLY",
                "",
                "Sensors",
                `• Total  : ${safe(inventoryItem?.sensorCount, 0)}`,
                `• Paused : ${safe(inventoryItem?.pausedSensorCount, 0)}`,
                `• Active : ${safe(inventoryItem?.activeSensorCount, 0)}`
            ),
            section(
                "🔔 Alerting",
                "⏸ INACTIVE"
            ),
            section(
                "ℹ️ Semua sensor PRTG sedang paused."
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.UNRESOLVED_PRTG) {

        return operatorCard(
            title,
            identity,
            section(
                "📡 PRTG",
                "",
                "Mapping",
                "🧩 UNRESOLVED",
                "",
                "Backend",
                "Not active"
            ),
            section(
                "🔔 Alerting",
                "Inactive until mapping is resolved"
            ),
            section(
                "ℹ️ Customer berada dalam scope PRTG,",
                "tetapi mapping device/sensor belum tersedia."
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {

        const scopeLabel = formatScopeLabel(customer.monitoring_scope);

        return operatorCard(
            title,
            identity,
            section(
                "🧭 Monitoring Scope",
                scopeLabel,
                "",
                "Backend",
                "External / PIC"
            ),
            section(
                "🤖 Bot Monitoring",
                "Not active",
                "",
                "🔔 Alerting",
                "Disabled"
            ),
            section(
                "ℹ️ Monitoring dikelola oleh PIC terkait."
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.DISABLED) {

        return operatorCard(
            title,
            identity,
            section(
                "Customer State",
                "🚫 DISABLED",
                "",
                "Bot Monitoring",
                "Not active",
                "",
                "Alerting",
                "Disabled"
            ),
            section(
                "ℹ️ Customer dinonaktifkan pada registry bot."
            )
        ).join("\n");

    } else if (classification.active) {

        const expectedBackend = getExpectedBackend(customer.monitoring_scope || SCOPES.PRTG);
        const activeBackend = getMonitoringBackendFromState(monitoringState, expectedBackend);
        const backendLbl = backendLabel(activeBackend);
        const stateText = monitoringState?.current_state || "UNKNOWN";
        const statusDisplay = formatStateDisplay(stateText);

        const sections = [];

        if (activeBackend === "prtg") {

            let monitoringBody = [
                "📡 Monitoring",
                "",
                "Scope",
                "📡 PRTG",
                "",
                "Backend",
                backendLbl
            ];

            if (inventoryItem?.primarySensor) {
                monitoringBody.push("");
                monitoringBody.push("Sensor");
                monitoringBody.push(`⭐ ${inventoryItem.primarySensor.name}`);
            }

            monitoringBody.push("");
            monitoringBody.push("Status");
            monitoringBody.push(statusDisplay);

            if (monitoringState?.last_value) {
                monitoringBody.push("");
                monitoringBody.push("Last Value");
                monitoringBody.push(monitoringState.last_value);
            }

            sections.push(section(...monitoringBody));

        } else if (activeBackend === "icmp_ping") {

            let monitoringBody = [
                "🌐 Monitoring",
                "",
                "Scope",
                formatScopeLabel(customer.monitoring_scope),
                "",
                "Backend",
                backendLbl,
                "",
                "Status",
                statusDisplay
            ];

            if (monitoringState?.last_latency_ms !== undefined && monitoringState?.last_latency_ms !== null) {
                monitoringBody.push("");
                monitoringBody.push("Latency");
                monitoringBody.push(formatLatency(monitoringState.last_latency_ms));
            }

            if (monitoringState?.last_packet_loss !== undefined && monitoringState?.last_packet_loss !== null) {
                monitoringBody.push("");
                monitoringBody.push("Packet Loss");
                monitoringBody.push(formatPacketLoss(monitoringState.last_packet_loss));
            }

            sections.push(section(...monitoringBody));
        }

        const alerting = getAlertingStatus(
            customer,
            monitoringState?.current_state,
            activeBackend,
            config.monitoring.alertsEnabled
        );

        const footerLines = [];

        footerLines.push("🔔 Alerting");
        footerLines.push(alerting.label);

        if (monitoringState?.last_checked_at) {
            footerLines.push("");
            footerLines.push("🕒 Checked");
            footerLines.push(formatDateTime(monitoringState.last_checked_at));
        }

        if (customer.monitoring_note) {
            footerLines.push("");
            footerLines.push("📝 Note");
            footerLines.push(customer.monitoring_note);
        }

        sections.push(section(...footerLines));

        const cardLines = operatorCard(title, identity, ...sections);

        return cardLines.join("\n");
    }

    return operatorCard(
        title,
        identity,
        section("Classification", classificationLabel(classification.category))
    ).join("\n");
}

// ============================================================
// CLIENT DETAIL
// ============================================================

function renderClientDetail(customer, inventoryItem, classification, monitoringState) {

    const catIcon = classificationIcon(classification.category);
    const title = `${catIcon} CUSTOMER DETAIL`;
    const identity = formatCustomerIdentity(customer);

    const sections = [];

    sections.push(section(
        "🧭 Monitoring Scope",
        formatScopeLabel(customer.monitoring_scope)
    ));

    if (classification.active) {

        const expectedBackend = getExpectedBackend(customer.monitoring_scope || SCOPES.PRTG);
        const activeBackend = getMonitoringBackendFromState(monitoringState, expectedBackend);
        const backendLbl = backendLabel(activeBackend);

        sections.push(section(
            "🌐 Monitoring Backend",
            backendLbl
        ));

    } else if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {

        sections.push(section(
            "👤 Monitoring Backend",
            "External / PIC"
        ));

    } else {

        sections.push(section(
            "Monitoring Backend",
            "Not active"
        ));
    }

    if (classification.active && customer.enabled) {

        sections.push(section("✅ Enabled", "YES"));

    } else {

        sections.push(section("✅ Enabled", "NO"));
    }

    if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {

        sections.push(section(
            "Classification",
            "⏸ PAUSED-ONLY",
            "",
            "Sensors",
            `${safe(inventoryItem?.sensorCount, 0)} total`,
            `${safe(inventoryItem?.pausedSensorCount, 0)} paused`,
            `${safe(inventoryItem?.activeSensorCount, 0)} active`
        ));

    } else if (classification.category === CLASSIFICATIONS.DISABLED) {

        sections.push(section(
            "Customer State",
            "🚫 DISABLED"
        ));
    }

    if (customer.monitoring_note) {
        sections.push(section(
            "📝 Note",
            customer.monitoring_note
        ));
    }

    return operatorCard(title, identity, ...sections).join("\n");
}

// ============================================================
// CLIENTS LIST
// ============================================================

function formatClientListItem(item, classification, state) {

    const icon = classificationIcon(classification.category);
    let statePart = "";

    if (classification.active) {

        const stateText = formatStateDisplay(state ? state.current_state : null);
        statePart = ` • ${stateText}`;
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
    const line1 = `${icon} ${header}${statePart}`;

    const parts = [line1];

    if (item.description && item.description !== item.name) {

        if (secondLine) {
            parts.push(`    ${secondLine} • ${item.ip}`);
        } else {
            parts.push(`    ${item.description} • ${item.ip}`);
        }

    } else if (secondLine) {

        parts.push(`    ${secondLine} • ${item.ip}`);

    } else if (item.ip) {

        parts.push(`    ${item.ip}`);
    }

    return parts.join("\n");
}

// ============================================================
// MAPPING SUMMARY
// ============================================================

function renderMappingSummary(summary) {

    const lines = [
        "🗺 PRTG MAPPING",
        ""
    ];

    lines.push("📡 PRTG CUSTOMERS");
    lines.push("");
    lines.push("✅ Active Mapped");
    lines.push(String(summary.prtg.targets));
    lines.push("⏸ Paused-only");
    lines.push(String(summary.pausedOnly));
    lines.push("🧩 Unresolved");
    lines.push(String(summary.unresolvedPrtg));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("🌐 FALLBACK");
    lines.push("");
    lines.push("Direct Ping");
    lines.push(String(summary.icmp.targets));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("👤 EXTERNAL");
    lines.push("");
    lines.push("PIC Managed");
    lines.push(String(summary.picManaged));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    if (summary.disabled > 0) {

        lines.push("🚫 DISABLED");
        lines.push("");
        lines.push("Disabled");
        lines.push(String(summary.disabled));
        lines.push("");
        lines.push(SEP);
        lines.push("");
    }

    lines.push("Total Customers");
    lines.push(String(summary.totalCustomers));

    return lines.join("\n");
}

// ============================================================
// MAPPING DETAIL
// ============================================================

function renderMappingDetail(customer, inventoryItem, classification, monitoringState) {

    const catIcon = classificationIcon(classification.category);
    const title = `${catIcon} PRTG MAPPING`;
    const identity = formatCustomerIdentity(customer);

    if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {

        return operatorCard(
            title,
            identity,
            section(
                "Mapping",
                "✅ MAPPED",
                "",
                "State",
                "⏸ PAUSED-ONLY"
            ),
            section(
                "📡 Device",
                "",
                safe(inventoryItem?.devices?.[0]?.device, "No device")
            ),
            section(
                "Sensors",
                `Total  : ${safe(inventoryItem?.sensorCount, 0)}`,
                `Paused : ${safe(inventoryItem?.pausedSensorCount, 0)}`,
                `Active : ${safe(inventoryItem?.activeSensorCount, 0)}`
            ),
            section(
                "Primary Sensor",
                "None while paused"
            ),
            section(
                "🕒 Last Verified",
                safe(inventoryItem?.lastVerifiedAt, "Never")
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.UNRESOLVED_PRTG) {

        return operatorCard(
            title,
            identity,
            section(
                "Mapping",
                "🧩 UNRESOLVED",
                "",
                "PRTG Device",
                "Not mapped"
            ),
            section(
                "🧭 Monitoring",
                "Not active"
            ),
            section(
                "ℹ️ Use PRTG search/mapping commands",
                "to resolve this customer."
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {

        return operatorCard(
            title,
            identity,
            section(
                "Scope",
                "👤 PIC MANAGED"
            ),
            section(
                "PRTG Mapping",
                "Not required",
                "",
                "Monitoring Ownership",
                "External / PIC"
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.DISABLED) {

        return operatorCard(
            title,
            identity,
            section(
                "Mapping",
                "🚫 DISABLED"
            ),
            section(
                "Bot Monitoring",
                "Not active",
                "",
                "Alerting",
                "Disabled"
            ),
            section(
                "ℹ️ Customer is disabled in the registry."
            )
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.ACTIVE_PRTG && inventoryItem) {

        const device = inventoryItem.devices?.[0];
        const primarySensor = inventoryItem.primarySensor;
        const stateText = monitoringState?.current_state || "UNKNOWN";

        const sections = [];

        sections.push(section(
            "Mapping",
            "✅ MAPPED"
        ));

        if (device) {

            const sourceLabel = device.mappingSource === "manual" ? "🛠 Manual" : "🤖 Automatic";
            const modeLabel = device.mappingMode === "explicit_sensor" ? "🎯 EXPLICIT SENSOR" : "🤖 Auto Primary";

            sections.push(section(
                "Source",
                sourceLabel,
                "",
                "Mode",
                modeLabel
            ));

            sections.push(section(
                "📡 PRTG Device",
                "",
                safe(device.device, "No device"),
                "",
                "Device ObjID",
                safe(device.objid, "-")
            ));
        }

        if (primarySensor) {

            sections.push(section(
                "Primary Sensor",
                `⭐ ${primarySensor.name}`,
                "",
                "Sensor ObjID",
                safe(primarySensor.objid, "-")
            ));

            if (monitoringState?.current_state) {

                sections.push(section(
                    "Status",
                    formatStateDisplay(monitoringState.current_state)
                ));
            }

        } else {

            sections.push(section(
                "Primary Sensor",
                "Not assigned"
            ));
        }

        if (customer.monitoring_note) {
            sections.push(section(
                "📝 Note",
                customer.monitoring_note
            ));
        }

        return operatorCard(
            title,
            identity,
            ...sections
        ).join("\n");

    } else if (classification.category === CLASSIFICATIONS.ACTIVE_ICMP) {

        const stateText = monitoringState?.current_state || "UNKNOWN";

        const sections = [];

        sections.push(section(
            "Scope",
            formatScopeLabel(customer.monitoring_scope)
        ));

        sections.push(section(
            "PRTG Mapping",
            "Not required currently"
        ));

        sections.push(section(
            "Fallback Monitoring",
            "🌐 DIRECT ICMP PING"
        ));

        sections.push(section(
            "Status",
            formatStateDisplay(stateText)
        ));

        if (monitoringState?.last_latency_ms !== undefined && monitoringState?.last_latency_ms !== null) {

            sections.push(section(
                "Latency",
                formatLatency(monitoringState.last_latency_ms)
            ));
        }

        if (monitoringState?.last_packet_loss !== undefined && monitoringState?.last_packet_loss !== null) {

            sections.push(section(
                "Packet Loss",
                formatPacketLoss(monitoringState.last_packet_loss)
            ));
        }

        if (customer.monitoring_note) {
            sections.push(section(
                "📝 Note",
                customer.monitoring_note
            ));
        }

        return operatorCard(
            title,
            identity,
            ...sections
        ).join("\n");
    }

    return operatorCard(
        title,
        identity,
        section("Classification", classificationLabel(classification.category))
    ).join("\n");
}

// ============================================================
// HEALTH SUMMARY
// ============================================================

function renderHealthSummary(summary, heartbeat) {

    const lines = [
        "🩺 BOT HEALTH",
        ""
    ];

    let allHealthy = true;

    lines.push("🤖 Telegram");
    lines.push("✅ Connected");

    lines.push("");

    lines.push("📡 PRTG API");
    lines.push("✅ Healthy");

    lines.push("");

    lines.push("🌐 Direct Ping");
    lines.push(config.directPing?.enabled ? "✅ Healthy" : "❌ Disabled");

    lines.push("");

    lines.push("🗄 Database");
    lines.push("✅ Healthy");

    lines.push("");

    lines.push("⚙️ Monitoring Engine");

    if (heartbeat && heartbeat.last_successful_cycle_at) {
        lines.push("✅ Running");
    } else {
        lines.push("❓ No successful cycle yet");
        allHealthy = false;
    }

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("📊 Monitoring");
    lines.push("");
    lines.push("PRTG Targets");
    lines.push(String(summary.prtg.targets));
    lines.push("Ping Targets");
    lines.push(String(summary.icmp.targets));
    lines.push("Total Active");
    lines.push(String(summary.active.total));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("⏸ Paused");
    lines.push(String(summary.pausedOnly));
    lines.push("🧩 Unresolved");
    lines.push(String(summary.unresolvedPrtg));
    lines.push("👤 PIC Managed");
    lines.push(String(summary.picManaged));

    lines.push("");
    lines.push(SEP);
    lines.push("");

    lines.push("🔔 Alerts");

    if (config.telegram.chatId) {
        lines.push(config.monitoring.alertsEnabled ? "✅ ENABLED" : "❌ DISABLED");
    } else {
        lines.push("❌ DISABLED (no chat_id)");
    }

    lines.push("");
    lines.push("⏱ Poll Interval");
    lines.push(`${config.monitoring.pollInterval} seconds`);

    if (heartbeat && heartbeat.last_cycle_at) {
        lines.push("");
        lines.push("🔄 Last Cycle");
        lines.push(formatDateTime(heartbeat.last_cycle_at));
    }
    if (heartbeat && heartbeat.last_cycle_duration_ms !== null) {

        lines.push("");
        lines.push("⏱ Duration");
        lines.push(formatDuration(heartbeat.last_cycle_duration_ms));

    }
    if (heartbeat && heartbeat.last_error) {
        lines.push("");
        lines.push("⚠️ Last Error");
        lines.push(String(heartbeat.last_error));
    }

    return lines.join("\n");
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    SEP,

    escapeHtml,
    separator,
    safe,

    formatScopeLabel,

    operatorCard,
    section,
    formatFooter,

    formatCustomerIdentity,
    formatCustomerIdentityCompact,

    formatClientListItem,

    successMessage,
    errorMessage,
    warningMessage,
    accessDeniedMessage,
    infoMessage,
    confirmationMessage,

    renderStatusSummary,
    renderCustomerStatus,
    renderClientDetail,

    renderMappingSummary,
    renderMappingDetail,
    renderHealthSummary
};
