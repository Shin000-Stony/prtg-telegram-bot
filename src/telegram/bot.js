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
    registerGroupCommands,
    hasActiveGroupSession,
    clearGroupSession
} = require("./group-commands");

const {
    processAddClient,
    hasActiveSession
} = require("./add-client");

const {
    hasActiveSession: hasActiveMappingSession,
    clearSession: clearMappingSession
} = require("./manual-mapping");

const {
    isGroupChat,
    getRegisteredGroup
} = require("./group-context");


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

    const isGroup = isGroupChat(ctx);
    const group = isGroup ? getRegisteredGroup(ctx) : null;
    const groupName = ctx.chat?.title || ctx.message?.chat?.title;

    if (isGroup) {
        if (group && group.enabled) {
            await ctx.reply(
                "🤖 PRTG TELEGRAM MONITOR\n\n" +
                "Group\n" +
                groupName + "\n\n" +
                "Monitoring Access\n" +
                "✅ REGISTERED\n\n" +
                "Gunakan:\n" +
                "/status\n" +
                "/clients\n" +
                "/group_clients\n" +
                "/help"
            );
        } else {
            await ctx.reply(
                "🤖 PRTG TELEGRAM MONITOR\n\n" +
                "Group ini belum terdaftar.\n\n" +
                "Hubungi administrator."
            );
        }
    } else {
        await ctx.reply(
            "🤖 PRTG TELEGRAM MONITOR\n\n" +
            "Ready. Use /help to get started."
        );
    }
});


// ============================================================
// REGISTER COMMANDS
// ============================================================

// General commands
registerCommands(bot);

// Customer management commands
registerCustomerCommands(bot);

// Telegram group segmentation commands
registerGroupCommands(bot);


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

        const allowedConfirmations = [
            "/confirm_map",
            "/confirm_map_sensor",
            "/confirm_unmap",
            "/confirm_scope",
            "/confirm_group_assign",
            "/confirm_group_unassign",
            "/confirm_group_remove"
        ];

        if (allowedConfirmations.includes(input)) {
            return next();
        }

        if (input === "/cancel") {
            return next();
        }

        await ctx.reply(
            "❓ Gunakan perintah konfirmasi yang sesuai, atau /cancel untuk membatalkan."
        );

        return;
    }

    if (
        userId &&
        hasActiveGroupSession(userId)
    ) {

        const input =
            (ctx.message.text || "").trim().toLowerCase();

        const groupConfirmations = [
            "/confirm_group_assign",
            "/confirm_group_unassign",
            "/confirm_group_remove"
        ];

        if (groupConfirmations.includes(input) || input === "/cancel") {
            return next();
        }

        await ctx.reply(
            "❓ Gunakan perintah konfirmasi grup yang sesuai, atau /cancel untuk membatalkan."
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

bot.catch(async (error, ctx) => {

    console.error("");
    console.error("========== TELEGRAM ERROR ==========");
    console.error(error);

    if (ctx) {
        console.error("Update:", ctx.update);
    }

    console.error("====================================");

    try {
        await ctx.reply(
            "❌ INTERNAL ERROR\n\n" +
            "Command gagal diproses.\n" +
            "Silakan coba lagi atau hubungi administrator."
        );
    } catch (replyError) {
        console.error("[ERROR HANDLER] Failed to send error reply:", replyError.message);
    }
});


// ============================================================
// EXPORT
// ============================================================

module.exports = bot;