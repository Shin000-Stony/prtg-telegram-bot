require("dotenv").config();

const { Telegraf } = require("telegraf");

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN tidak ditemukan");
    process.exit(1);
}

const bot = new Telegraf(token);

bot.start(async (ctx) => {
    console.log(
        `[MESSAGE] /start from ${ctx.from.id}`
    );

    await ctx.reply(
        "✅ Telegram bot berhasil menerima message."
    );
});

bot.command("ping", async (ctx) => {
    console.log(
        `[MESSAGE] /ping from ${ctx.from.id}`
    );

    await ctx.reply("🏓 pong");
});

(async () => {

    try {

        const me = await bot.telegram.getMe();

        console.log(
            `[OK] Telegram API: @${me.username}`
        );

        console.log(
            "[OK] Starting long polling..."
        );

        await bot.launch({
            dropPendingUpdates: true
        });

        console.log(
            "[OK] Long polling aktif."
        );

    } catch (error) {

        console.error(
            "[ERROR] Gagal menjalankan bot:"
        );

        console.error(error);

        process.exit(1);
    }
})();

process.once(
    "SIGINT",
    () => bot.stop("SIGINT")
);

process.once(
    "SIGTERM",
    () => bot.stop("SIGTERM")
);