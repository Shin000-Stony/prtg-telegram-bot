require("dotenv").config();

function required(name) {
    const value = process.env[name];

    if (!value) {
        throw new Error(
            `[CONFIG] Missing required environment variable: ${name}`
        );
    }

    return value;
}

function optional(name, fallback) {

    const value = process.env[name];

    if (!value) {
        return fallback;
    }

    return value;
}

function parseIdList(value) {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}

const config = {
    nodeEnv: process.env.NODE_ENV || "development",

    database: {
        path: process.env.DATABASE_PATH || ""
    },

    prtg: {
        url: required("PRTG_URL"),
        username: required("PRTG_USERNAME"),
        passhash: required("PRTG_PASSHASH"),
        discoveryInterval:
            Number(process.env.PRTG_DISCOVERY_INTERVAL || 900)
    },

    telegram: {
        token: required("TELEGRAM_BOT_TOKEN"),
        chatId: process.env.TELEGRAM_CHAT_ID || "",

        adminIds: parseIdList(
            process.env.TELEGRAM_ADMIN_IDS
        )
    },

    monitoring: {
        pollInterval:
            Number(process.env.MONITOR_INTERVAL_SECONDS || process.env.POLL_INTERVAL || 30),
        downConfirmCount:
            Math.max(1, Number(process.env.DOWN_CONFIRM_COUNT || 2)),
        recoveryConfirmCount:
            Math.max(1, Number(process.env.RECOVERY_CONFIRM_COUNT || 2)),
        alertsEnabled:
            String(process.env.ALERTS_ENABLED || "false").toLowerCase() === "true"
    },

    directPing: {
        enabled:
            String(process.env.DIRECT_PING_ENABLED || "true").toLowerCase() === "true",
        timeoutSeconds:
            Number(process.env.DIRECT_PING_TIMEOUT || 2),
        count:
            Number(process.env.DIRECT_PING_COUNT || 1),
        concurrency:
            Number(process.env.DIRECT_PING_CONCURRENCY || 5)
    }
};

module.exports = config;