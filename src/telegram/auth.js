const config = require("../config/env");

function isAdmin(userId) {
    if (userId === undefined || userId === null) {
        return false;
    }

    return config.telegram.adminIds.includes(
        String(userId)
    );
}

async function requireAdmin(ctx) {
    const userId = ctx.from?.id;

    if (!isAdmin(userId)) {
        await ctx.reply(
            "⛔ Akses ditolak.\n\n" +
            "Command ini hanya dapat digunakan oleh admin."
        );

        return false;
    }

    return true;
}

module.exports = {
    isAdmin,
    requireAdmin
};