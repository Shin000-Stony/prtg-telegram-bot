const dns = require("dns");
const https = require("https");

const {
    Telegraf
} = require("telegraf");

const config = require("../config/env");

const {
    registerCommands
} = require("./commands");

const {
    registerCustomerCommands
} = require("./customer-commands");

const {
    processAddClient,
    hasActiveSession
} = require("./add-client");

const {
    hasActiveSession: hasActiveMappingSession,
    clearSession: clearMappingSession
} = require("./manual-mapping");


// ============================================================
// DNS
// ============================================================

dns.setDefaultResultOrder("ipv4first");


// ============================================================
// FORCE IPV4 HTTPS AGENT
// ============================================================

const ipv4Agent = new https.Agent({
    family: 4,
    keepAlive: true,
    rejectUnauthorized: true
});


// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new Telegraf(
    config.telegram.token,
    {
        telegram: {
            agent: ipv4Agent,
            webhookReply: false
        }
    }
);


// ============================================================
// GLOBAL LOGGER
// ============================================================

bot.use(async (ctx, next) => {

    console.log("");
    console.log("========== TELEGRAM UPDATE ==========");

    console.log(
        "Type:",
        ctx.updateType
    );

    console.log(
        "User:",
        ctx.from?.id || "-"
    );

    console.log(
        "Text:",
        ctx.message?.text || "-"
    );

    console.log(
        "====================================="
    );

    return next();
});


// ============================================================
// /START
// ============================================================

bot.start(async (ctx) => {

    console.log("[CMD] /start");

    await ctx.reply(
        "🤖 PRTG TELEGRAM MONITOR\n\n" +
        "Ready. Use /help to get started."
    );
});


// ============================================================
// REGISTER COMMANDS
// ============================================================

// General commands
registerCommands(bot);

// Customer management commands
registerCustomerCommands(bot);


// ============================================================
// ADD CLIENT CONVERSATION
// ============================================================

bot.on("text", async (ctx, next) => {

    const userId =
        ctx.from?.id;

    if (
        userId &&
        hasActiveSession(userId)
    ) {

        const handled =
            await processAddClient(ctx);

        if (handled) {
            return;
        }
    }

    // --------------------------------------------------------
    // Manual mapping session: only allow confirm/cancel commands
    // --------------------------------------------------------

    if (
        userId &&
        hasActiveMappingSession(userId)
    ) {

        const input =
            (ctx.message.text || "").trim().toLowerCase();

        if (
            input === "/confirm_map" ||
            input === "/confirm_map_sensor" ||
            input === "/confirm_unmap" ||
            input === "/confirm_scope"
        ) {
            return next();
        }

        if (input === "/cancel") {
            return next();
        }

        await ctx.reply(
            "❓ Gunakan /confirm_map, /confirm_map_sensor, atau /confirm_unmap " +
            "untuk mengonfirmasi, atau /cancel untuk membatalkan."
        );

        return;
    }

    return next();
});


// ============================================================
// UNKNOWN COMMAND
// ============================================================

bot.on("text", async (ctx) => {

    const text =
        ctx.message?.text || "";

    if (!text.startsWith("/")) {
        return;
    }

    console.log(
        "[UNKNOWN COMMAND]",
        text
    );

    await ctx.reply(
        "❓ Perintah tidak dikenal.\n\n" +
        "Gunakan /help."
    );
});


// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch((error, ctx) => {

    console.error("");
    console.error(
        "========== TELEGRAM ERROR =========="
    );

    console.error(error);

    if (ctx) {
        console.error(
            "Update:",
            ctx.update
        );
    }

    console.error(
        "===================================="
    );
});


// ============================================================
// EXPORT
// ============================================================

module.exports = bot;