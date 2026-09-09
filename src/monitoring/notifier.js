const config = require("../config/env");
const {
    formatDateTime,
    isAlertEligible,
    CLASSIFICATIONS
} = require("../monitoring/classifier");

// ============================================================
// NOTIFIER
// ============================================================

// ============================================================
// FORMAT DOWN ALERT
// ============================================================

function formatDownAlert(data) {

    const {
        name,
        location,
        ip,
        description,
        sensor,
        lastValue,
        packetLoss,
        detectedAt,
        backend,
        confirmedCount,
        confirmThreshold
    } = data;

    const backendLabel = backend === "icmp_ping"
        ? "🌐 DIRECT ICMP PING"
        : "📡 PRTG";

    const lines = [
        "🔴 CUSTOMER DOWN",
        ""
    ];

    lines.push(`#${ip}`);

    if (description && description !== name) {
        lines.push(description);
    }

    if (location) {
        lines.push(`📍 ${location}`);
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    lines.push(backendLabel);
    lines.push("");

    if (sensor && sensor.name) {
        lines.push("Sensor");
        lines.push(`⭐ ${sensor.name}`);
        lines.push("");
    }

    lines.push("Status");
    lines.push("🔴 DOWN");
    lines.push("");

    if (lastValue) {
        lines.push("Last Value");
        lines.push(lastValue);
        lines.push("");
    }

    if (packetLoss !== undefined && packetLoss !== null) {
        lines.push("Packet Loss");
        lines.push(`${packetLoss}%`);
        lines.push("");
    }

    lines.push("Confirmed");
    lines.push(`${confirmedCount} consecutive checks`);
    lines.push("");

    lines.push("🕒 Detected");
    lines.push(formatDateTime(detectedAt));

    return lines.join("\n");
}

// ============================================================
// FORMAT RECOVERY ALERT
// ============================================================

function formatRecoveryAlert(data) {

    const {
        name,
        location,
        ip,
        description,
        sensor,
        lastValue,
        latency,
        packetLoss,
        recoveredAt,
        backend
    } = data;

    const backendLabel = backend === "icmp_ping"
        ? "🌐 DIRECT ICMP PING"
        : "📡 PRTG";

    const lines = [
        "🟢 CUSTOMER RECOVERED",
        ""
    ];

    lines.push(`#${ip}`);

    if (description && description !== name) {
        lines.push(description);
    }

    if (location) {
        lines.push(`📍 ${location}`);
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    lines.push(backendLabel);
    lines.push("");

    if (sensor && sensor.name) {
        lines.push("Sensor");
        lines.push(`⭐ ${sensor.name}`);
        lines.push("");
    }

    lines.push("Status");
    lines.push("🟢 UP");
    lines.push("");

    if (latency !== undefined && latency !== null) {
        lines.push("Latency");
        lines.push(formatLatencyValue(latency));
        lines.push("");
    }

    if (packetLoss !== undefined && packetLoss !== null) {
        lines.push("Packet Loss");
        lines.push(`${packetLoss}%`);
        lines.push("");
    }

    lines.push("🕒 Recovered");
    lines.push(formatDateTime(recoveredAt));

    return lines.join("\n");
}

function formatLatencyValue(ms) {

    if (ms === null || ms === undefined || ms === "") {
        return "-";
    }

    const num = Number(ms);

    if (isNaN(num)) {
        return "-";
    }

    return `${num.toFixed(1)} ms`;
}

// ============================================================
// FORMAT WARNING ALERT
// ============================================================

function formatWarningAlert(data) {

    const {
        name,
        ip,
        description,
        sensor,
        lastValue,
        detectedAt,
        backend
    } = data;

    const backendLabel = backend === "icmp_ping"
        ? "🌐 DIRECT ICMP PING"
        : "📡 PRTG";

    const lines = [
        "🟡 CUSTOMER WARNING",
        "",
        ip
    ];

    if (description && description !== name) {
        lines.push(description);
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    lines.push(backendLabel);
    lines.push("");

    if (sensor && sensor.name) {
        lines.push("Sensor");
        lines.push(`⭐ ${sensor.name}`);
        lines.push("");
    }

    lines.push("Status");
    lines.push("🟡 WARNING");
    lines.push("");

    if (lastValue) {
        lines.push("Last Value");
        lines.push(lastValue);
        lines.push("");
    }

    lines.push("🕒 Detected");
    lines.push(formatDateTime(detectedAt));

    return lines.join("\n");
}

// ============================================================
// FORMAT UNUSUAL ALERT
// ============================================================

function formatUnusualAlert(data) {

    const {
        name,
        ip,
        description,
        sensor,
        lastValue,
        detectedAt,
        backend
    } = data;

    const backendLabel = backend === "icmp_ping"
        ? "🌐 DIRECT ICMP PING"
        : "📡 PRTG";

    const lines = [
        "🟠 CUSTOMER UNUSUAL",
        "",
        ip
    ];

    if (description && description !== name) {
        lines.push(description);
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    lines.push(backendLabel);
    lines.push("");

    if (sensor && sensor.name) {
        lines.push("Sensor");
        lines.push(`⭐ ${sensor.name}`);
        lines.push("");
    }

    lines.push("Status");
    lines.push("🟠 UNUSUAL");
    lines.push("");

    if (lastValue) {
        lines.push("Last Value");
        lines.push(lastValue);
        lines.push("");
    }

    lines.push("🕒 Detected");
    lines.push(formatDateTime(detectedAt));

    return lines.join("\n");
}

// ============================================================
// FORMAT UNKNOWN ALERT
// ============================================================

function formatUnknownAlert(data) {

    const {
        name,
        ip,
        customerClassification,
        monitoringBackend,
        detectedAt
    } = data;

    const backendLabel = monitoringBackend === "icmp_ping"
        ? "🌐 DIRECT ICMP PING"
        : "📡 PRTG";

    const lines = [
        "⚪ MONITORING UNKNOWN",
        "",
        ip
    ];

    if (classificationDisplay(customerClassification).includes("PAUSED")) {
        return "";
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    lines.push("Backend");
    lines.push(backendLabel);
    lines.push("");

    lines.push("Status");
    lines.push("⚪ UNKNOWN");
    lines.push("");

    lines.push("Reason");
    lines.push("Unable to determine current monitoring state.");
    lines.push("");

    lines.push("🕒 Checked");
    lines.push(formatDateTime(detectedAt));

    return lines.join("\n");
}

function classificationDisplay(category) {

    const icons = {
        [CLASSIFICATIONS.ACTIVE_PRTG]: "📡 ACTIVE PRTG",
        [CLASSIFICATIONS.ACTIVE_ICMP]: "🌐 DIRECT PING",
        [CLASSIFICATIONS.PAUSED_PRTG]: "⏸ PAUSED-ONLY",
        [CLASSIFICATIONS.UNRESOLVED_PRTG]: "🧩 UNRESOLVED",
        [CLASSIFICATIONS.PIC_MANAGED]: "👤 PIC MANAGED",
        [CLASSIFICATIONS.DISABLED]: "🚫 DISABLED"
    };

    return icons[category] || "UNKNOWN";
}

// ============================================================
// SEND ALERT
// ============================================================

async function sendAlert(bot, message) {

    if (!config.telegram.chatId) {
        console.log("[NOTIFIER] TELEGRAM_CHAT_ID not configured; alert skipped.");
        return false;
    }

    if (!message || message === "") {
        return false;
    }

    try {

        await bot.telegram.sendMessage(
            config.telegram.chatId,
            message
        );

        return true;

    } catch (error) {

        console.error("[NOTIFIER] Gagal kirim alert:", error.message);
        return false;
    }
}

// ============================================================
// NOTIFY DOWN
// ============================================================

async function notifyDown(bot, customer, sensor, lastValue, backend = "prtg", extra = {}) {

    const detectedAt = new Date().toISOString();

    const message = formatDownAlert({
        name: customer.name,
        location: customer.location,
        ip: customer.ip,
        description: customer.description,
        sensor,
        lastValue: lastValue || "-",
        packetLoss: extra.packetLoss,
        detectedAt,
        backend,
        confirmedCount: extra.confirmedCount || 1,
        confirmThreshold: extra.confirmThreshold || 2
    });

    return sendAlert(bot, message);
}

// ============================================================
// NOTIFY RECOVERY
// ============================================================

async function notifyRecovery(bot, customer, sensor, lastValue, backend = "prtg", extra = {}) {

    const recoveredAt = new Date().toISOString();

    const message = formatRecoveryAlert({
        name: customer.name,
        location: customer.location,
        ip: customer.ip,
        description: customer.description,
        sensor,
        lastValue: lastValue || "-",
        latency: extra.latency,
        packetLoss: extra.packetLoss,
        recoveredAt,
        backend
    });

    return sendAlert(bot, message);
}

// ============================================================
// NOTIFY TEST ALERT
// ============================================================

async function notifyTestAlert(bot) {

    const now = new Date().toISOString();

    const message =
        "🧪 TEST NOTIFICATION\n\n" +
        "Telegram alert delivery is working.\n\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        "This is NOT a real customer incident.\n" +
        "No monitoring state was changed.\n\n" +
        "✅ Delivery successful\n\n" +
        "🕒 " + formatDateTime(now);

    return sendAlert(bot, message);
}

// ============================================================
// CHECK ALERT ELIGIBILITY
// ============================================================

function isAlertEligibleForCustomer(customer, inventoryItem, monitoringState, cfg) {

    const classification = require("../monitoring/classifier").classifyCustomer(
        customer,
        inventoryItem,
        monitoringState,
        cfg || config
    );

    return isAlertEligible(classification.category);
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    formatDownAlert,
    formatRecoveryAlert,
    formatWarningAlert,
    formatUnusualAlert,
    formatUnknownAlert,
    sendAlert,
    notifyDown,
    notifyRecovery,
    notifyTestAlert,
    isAlertEligibleForCustomer
};
