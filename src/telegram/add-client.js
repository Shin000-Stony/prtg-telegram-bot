const customers = require("../database/customers");
const {
    isValidIPv4,
    normalizeServiceId
} = require("./validators");

const {
    formatDateTime
} = require("../monitoring/classifier");

const {
    confirmationMessage,
    successMessage,
    errorMessage,
    infoMessage,
    escapeHtml
} = require("./ui");

const sessions = new Map();

// ============================================================
// SESSION
// ============================================================

function getSession(userId) {

    if (!sessions.has(userId)) {

        sessions.set(userId, {
            step: "name",
            data: {}
        });
    }

    return sessions.get(userId);
}

function clearSession(userId) {
    sessions.delete(userId);
}

// ============================================================
// START
// ============================================================

async function startAddClient(ctx) {

    const userId = String(ctx.from.id);

    sessions.set(userId, {
        step: "name",
        data: {}
    });

    const now = formatDateTime(new Date().toISOString());

    await ctx.reply(
        "➕ ADD CUSTOMER\n\n" +
        "Step 1/6\n\n" +
        "Customer Name\n\n" +
        "Kirim nama customer.\n\n" +
        "❌ /cancel"
    );
}

// ============================================================
// PROCESS MESSAGE
// ============================================================

async function processAddClient(ctx) {

    const userId = String(ctx.from.id);
    const session = sessions.get(userId);

    if (!session) {
        return false;
    }

    const input = (ctx.message.text || "").trim();

    // --------------------------------------------------------
    // CANCEL
    // --------------------------------------------------------

    if (input.toLowerCase() === "/cancel") {

        clearSession(userId);

        await ctx.reply(
            "✅ ACTION CANCELLED\n\n" +
            "Pending operation has been cleared."
        );

        return true;
    }

    // ========================================================
    // NAME
    // ========================================================

    if (session.step === "name") {

        if (input.length < 2) {

            await ctx.reply(
                "❌ Nama terlalu pendek.\n\n" +
                "Masukkan nama customer yang valid."
            );

            return true;
        }

        session.data.name = input;
        session.step = "ip";

        await ctx.reply(
            "➕ ADD CUSTOMER\n\n" +
            "Step 2/6\n\n" +
            "IP Address\n\n" +
            "Kirim alamat IPv4 customer."
        );

        return true;
    }

    // ========================================================
    // IP
    // ========================================================

    if (session.step === "ip") {

        if (!isValidIPv4(input)) {

            await ctx.reply(
                "❌ Format IPv4 tidak valid.\n\n" +
                "Contoh:\n" +
                "123.231.218.198"
            );

            return true;
        }

        if (customers.existsByIP(input)) {

            const existing = customers.getCustomerByIP(input);

            await ctx.reply(
                "⚠️ IP tersebut sudah terdaftar.\n\n" +
                `#${existing.client_id} ${existing.name}\n` +
                `🌐 ${existing.ip}\n\n` +
                "Masukkan IP lain atau /cancel."
            );

            return true;
        }

        session.data.ip = input;
        session.step = "location";

        await ctx.reply(
            "➕ ADD CUSTOMER\n\n" +
            "Step 3/6\n\n" +
            "Location\n\n" +
            "Masukkan lokasi customer."
        );

        return true;
    }

    // ========================================================
    // LOCATION
    // ========================================================

    if (session.step === "location") {

        if (input.length < 2) {

            await ctx.reply(
                "❌ Lokasi tidak valid.\n\n" +
                "Masukkan lokasi customer."
            );

            return true;
        }

        session.data.location = input;
        session.step = "service_id";

        await ctx.reply(
            "➕ ADD CUSTOMER\n\n" +
            "Step 4/6\n\n" +
            "Service ID\n\n" +
            "Gunakan angka 7–12 digit, atau `-`."
        );

        return true;
    }

    // ========================================================
    // SERVICE ID
    // ========================================================

    if (session.step === "service_id") {

        const serviceId = normalizeServiceId(input);

        if (serviceId === undefined) {

            await ctx.reply(
                "❌ Service ID tidak valid.\n\n" +
                "Gunakan angka 7–12 digit, atau `-`."
            );

            return true;
        }

        if (serviceId && customers.existsByServiceId(serviceId)) {

            const existing = customers.getCustomerByServiceId(serviceId);

            await ctx.reply(
                "⚠️ Service ID tersebut sudah terdaftar.\n\n" +
                `#${existing.client_id} ${existing.name}\n` +
                `🆔 ${existing.service_id}\n\n` +
                "Masukkan Service ID lain atau `-`."
            );

            return true;
        }

        session.data.service_id = serviceId;
        session.step = "description";

        await ctx.reply(
            "➕ ADD CUSTOMER\n\n" +
            "Step 5/6\n\n" +
            "Description\n\n" +
            "Contoh:\n" +
            "MAIN LINK\n" +
            "BACKUP LINK\n" +
            "LINK IOH"
        );

        return true;
    }

    // ========================================================
    // DESCRIPTION
    // ========================================================

    if (session.step === "description") {

        if (input.length < 2) {

            await ctx.reply(
                "❌ Keterangan terlalu pendek."
            );

            return true;
        }

        session.data.description = input;
        session.step = "confirm";

        const d = session.data;
        const serviceId = d.service_id || "-";

        const identity = [
            d.name,
            `🌐 ${d.ip}`,
            `📍 ${d.location}`,
            `🆔 ${serviceId}`,
            `🔗 ${d.description}`
        ];

        await ctx.reply(
            confirmationMessage(
                "CONFIRM NEW CUSTOMER",
                identity,
                [
                    "Simpan customer ini?"
                ],
                "/yes",
                "/cancel"
            )
        );

        return true;
    }

    // ========================================================
    // CONFIRM
    // ========================================================

    if (session.step === "confirm") {

        const command = input.toLowerCase();

        // ----------------------------------------------------
        // YES
        // ----------------------------------------------------

        if (command === "/yes" || command === "yes") {

            try {

                const customer = customers.addCustomer(session.data);

                clearSession(userId);

                await ctx.reply(
                    successMessage(
                        "CUSTOMER ADDED",
                        [
                            `#${customer.client_id} ${customer.name}`,
                            `🌐 ${customer.ip}`,
                            `📍 ${customer.location}`,
                            `🆔 ${customer.service_id || "-"}`,
                            `🔗 ${customer.description}`,
                            "",
                            `Database ID: ${customer.id}`
                        ]
                    )
                );

            } catch (error) {

                console.error("[ADD_CLIENT]", error);

                await ctx.reply(
                    errorMessage(
                        "Gagal menyimpan customer ke database."
                    )
                );
            }

            return true;
        }

        // ----------------------------------------------------
        // NO
        // ----------------------------------------------------

        if (command === "/no" || command === "no") {

            clearSession(userId);

            await ctx.reply(
                "❌ Customer tidak disimpan."
            );

            return true;
        }

        await ctx.reply(
            "❓ Jawab dengan:\n\n" +
            "/yes untuk menyimpan\n" +
            "/no untuk membatalkan\n" +
            "/cancel untuk keluar"
        );

        return true;
    }

    return true;
}

// ============================================================
// CHECK ACTIVE SESSION
// ============================================================

function hasActiveSession(userId) {
    return sessions.has(String(userId));
}

module.exports = {
    startAddClient,
    processAddClient,
    hasActiveSession,
    clearSession
};
