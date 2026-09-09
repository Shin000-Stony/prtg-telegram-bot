const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const config = require("./config/env");
require("./database/init");
const bot = require("./telegram/bot");
const customers = require("./database/customers");
const { buildMonitoringSummary } = require("./monitoring/classifier");
const { startMonitoring, stopMonitoring } = require("./monitoring/engine");

// ============================================================
// STARTUP
// ============================================================

console.log("");
console.log("========================================");
console.log("     PRTG TELEGRAM MONITOR");
console.log("========================================");
console.log("");

console.log(`Environment       : ${config.nodeEnv}`);

const dataDir = config.database.path || "./data/prtg_bot.db";
console.log(`Database          : ${dataDir}`);

const customerList =
    customers.getCustomers();

const summary = buildMonitoringSummary();

console.log(`[STARTUP] Customers: ${summary.totalCustomers}`);
console.log(`[STARTUP] Active PRTG: ${summary.classifications.active_prtg}`);
console.log(`[STARTUP] Direct Ping: ${summary.classifications.active_icmp}`);
console.log(`[STARTUP] Paused: ${summary.pausedOnly}`);
console.log(`[STARTUP] Unresolved: ${summary.unresolvedPrtg}`);
console.log(`[STARTUP] PIC Managed: ${summary.picManaged}`);

console.log("");
console.log(`Poll interval     : ${config.monitoring.pollInterval}s`);
console.log(`DOWN confirm      : ${config.monitoring.downConfirmCount} polls`);
console.log(`Recovery confirm  : ${config.monitoring.recoveryConfirmCount} polls`);

if (config.monitoring.alertsEnabled) {
    if (config.telegram.chatId) {
        console.log(`Alerts            : ENABLED`);
        console.log(`Telegram target   : configured`);
    } else {
        console.log(`Alerts            : DISABLED`);
        console.log(`[ALERT] ALERTS_ENABLED=true but TELEGRAM_CHAT_ID is missing.`);
        console.log(`[ALERT] Automatic notifications disabled for safety.`);
    }
} else {
    console.log(`Alerts            : DISABLED`);
    if (!config.telegram.chatId) {
        console.log(`Telegram target   : not configured`);
    } else {
        console.log(`Telegram target   : configured`);
    }
}

console.log("");
console.log("========================================");
console.log("");


// ============================================================
// START BOT
// ============================================================

(async () => {

    try {

        console.log(
            "[TELEGRAM] Starting bot..."
        );

        const me =
            await bot.telegram.getMe();

        console.log(
            `[TELEGRAM] Connected as @${me.username}`
        );

        console.log(
            `[TELEGRAM] Bot ID: ${me.id}`
        );

        bot.launch({
            dropPendingUpdates: true
        });

        console.log(
            "[TELEGRAM] Polling started."
        );

        console.log("");

        startMonitoring(bot);

    } catch (error) {

        console.error(
            "[TELEGRAM] Failed to start bot:"
        );

        console.error(error);
        process.exit(1);
    }
})();


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.once(
    "SIGINT",
    () => {

        stopMonitoring();
        bot.stop("SIGINT");
    }
);

process.once(
    "SIGTERM",
    () => {

        stopMonitoring();
        bot.stop("SIGTERM");
    }
);
