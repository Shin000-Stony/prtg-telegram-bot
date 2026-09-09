const {
    startAddClient
} = require("./add-client");

const {
    requireAdmin,
    isAdmin
} = require("./auth");

const {
    findPrtg,
    findPrtgSensor,
    hasActiveSession: hasActiveMappingSession,
    clearSession: clearMappingSession
} = require("./manual-mapping");

const {
    MAX_RESULTS,
    MAX_DEEP_RESULTS
} = require("../prtg/search");

const {
    searchDevicesDeep,
    fetchDeviceDetail
} = require("../prtg/search");

const {
    formatStateDisplay,
    formatLatency,
    formatDateTime,
    formatDuration
} = require("../monitoring/classifier");

const {
    separator,
    safe,
    escapeHtml
} = require("./ui");

const {
    classifyCustomer,
    CLASSIFICATIONS,
    classificationIcon,
    buildMonitoringSummary
} = require("../monitoring/classifier");

const customers = require("../database/customers");
const { getInventorySummary } = require("../prtg/inventory");
const { loadAllStates } = require("../monitoring/state-store");

const {
    isPrivateChat,
    isGroupChat,
    getRegisteredGroup
} = require("./group-context");

const LEGACY_WARNING_MARKERS = [
    "OLD",
    "LEGACY",
    "DISABLED",
    "DECOMMISSION",
    "BACKUP OLD"
];

const deepSearchCooldowns = new Map();

function formatSensorStatusShort(status) {

    if (!status) return "⚪ Unknown";

    const normalized = String(status).trim().toLowerCase();

    if (normalized.includes("down")) return "🔴 Down";
    if (normalized.includes("up")) return "🟢 Up";
    if (normalized.includes("warning")) return "🟡 Warning";
    if (normalized.includes("unusual")) return "🟠 Unusual";
    if (normalized.includes("paused")) return "⏸ Paused";

    return String(status);
}

function splitMessage(text, maxLength) {

    const chunks = [];
    let current = "";

    const lines = text.split("\n");

    for (const line of lines) {

        if (current.length + line.length + 1 > maxLength) {
            chunks.push(current.trim());
            current = "";
        }

        current += line + "\n";
    }

    if (current.trim()) {
        chunks.push(current.trim());
    }

    return chunks;
}


// ============================================================
// REGISTER GENERAL COMMANDS
// ============================================================

function registerCommands(bot) {

    // ========================================================
    // /id
    // ========================================================

    bot.command("id", async (ctx) => {

        console.log("[CMD] /id");

        const user = ctx.from;

        const role =
            isAdmin(user.id)
                ? "✅ ADMIN"
                : "👤 USER";

        const timestamp = formatDateTime(new Date().toISOString());

        await ctx.reply(
            "👤 TELEGRAM INFORMATION\n\n" +
            `#${user.id} ${user.first_name || "-"}\n\n` +
            `Role     : ${role}\n\n` +
            "────\n\n" +
            "🕒 " + timestamp
        );
    });


    // ========================================================
    // /chatid
    // ========================================================

    bot.command("chatid", async (ctx) => {

        console.log("[CMD] /chatid");

        const timestamp = formatDateTime(new Date().toISOString());

        await ctx.reply(
            "💬 CHAT INFORMATION\n\n" +
            `Chat ID  : ${ctx.chat.id}\n\n` +
            "────\n\n" +
            "🕒 " + timestamp
        );
    });


    // ========================================================
    // /admin_test
    // ========================================================

    bot.command("admin_test", async (ctx) => {

        console.log("[CMD] /admin_test");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await ctx.reply(
            "✅ AUTHORIZATION OK\n\n" +
            "Kamu terdaftar sebagai admin."
        );
    });


    // ========================================================
    // /add_client
    // ========================================================

    bot.command("add_client", async (ctx) => {

        console.log("[CMD] /add_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await startAddClient(ctx);
    });


    // ========================================================
    // /find_prtg <query>
    // ========================================================

    bot.command("find_prtg", async (ctx) => {

        console.log("[CMD] /find_prtg");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {

            await ctx.reply(
                "🔍 PRTG SEARCH\n\n" +
                "Format:\n" +
                "/find_prtg <query>\n\n" +
                "Contoh:\n" +
                "/find_prtg CITRA\n" +
                "/find_prtg 2025499622\n" +
                "/find_prtg 103.186.10.118\n\n" +
                `Query minimal 3 karakter. Maksimal ${MAX_RESULTS} hasil.`
            );

            return;
        }

        const query = parts.slice(1).join(" ");

        try {

            const result = await findPrtg(query);

            if (result.error) {
                await ctx.reply(
                    `❌ Pencarian gagal: ${result.error}`
                );
                return;
            }

            const now = formatDateTime(new Date().toISOString());

            if (result.total === 0) {

                await ctx.reply(
                    "🔍 PRTG DEVICE SEARCH\n\n" +
                    "Query\n" +
                    query + "\n\n" +
                    "Found\n" +
                    "0 candidates\n\n" +
                    "Gunakan query yang lebih spesifik.\n\n" +
                    "────\n\n" +
                    "🕒 " + now
                );

                return;
            }

            let lines = [
                "🔎 PRTG SEARCH",
                "",
                "Query",
                query,
                "",
                "Found",
                String(result.total),
                "candidates",
                "",
                "━━━━━━━━━━━━━━━━━━━━",
                ""
            ];

            let index = 1;

            for (const device of result.devices) {

                lines.push(`${index}️⃣ ${device.device || "-"}`);
                lines.push("");
                lines.push("ObjID");
                lines.push(String(device.objid));
                lines.push("");
                lines.push("Host");
                lines.push(device.host || "-");
                lines.push("");
                lines.push("Group");
                lines.push(device.group || "-");
                lines.push("");
                lines.push("Status");
                lines.push(device.isPaused ? "⏸ Paused" : "🟢 Up");
                lines.push("");
                lines.push("━━━━━━━━━━━━━━━━━━━━");
                lines.push("");
                index++;
            }

            if (result.truncated) {
                lines.push("⚠️ Banyak hasil ditemukan. Gunakan query yang lebih spesifik.");
                lines.push("");
            }

            lines.push("🕒 " + now);

            const message = lines.join("\n");
            const chunks = splitMessage(message, 4000);

            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }

        } catch (error) {

            console.error("[CMD /find_prtg]", error);

            await ctx.reply(
                "❌ Gagal mencari device PRTG."
            );
        }
    });

    // ========================================================
    // /find_prtg_deep <query>
    // ========================================================

    bot.command("find_prtg_deep", async (ctx) => {

        console.log("[CMD] /find_prtg_deep");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from?.id);

        const nowMs = Date.now();

        const lastRun = deepSearchCooldowns.get(userId) || 0;

        if (nowMs - lastRun < 5000) {

            await ctx.reply(
                "⏱ Tunggu beberapa detik sebelum pencarian berikutnya."
            );

            return;
        }

        deepSearchCooldowns.set(userId, nowMs);

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {

            await ctx.reply(
                "🔍 PRTG DEEP SEARCH\n\n" +
                "Format:\n" +
                "/find_prtg_deep <query>\n\n" +
                "Contoh:\n" +
                "/find_prtg_deep CITRA\n" +
                "/find_prtg_deep CELEBES\n" +
                "/find_prtg_deep 2025499622\n\n" +
                `Query minimal 3 karakter. Maksimal ${MAX_DEEP_RESULTS} hasil.`
            );

            return;
        }

        const query = parts.slice(1).join(" ");

        try {

            const result = await searchDevicesDeep(query);

            const now = formatDateTime(new Date().toISOString());

            let lines = [
                "🔎 PRTG DEEP SEARCH",
                "",
                "Query",
                query,
                "",
                "Found",
                String(result.total),
                "candidates",
                "",
                "Search mode",
                result.cacheHit ? "cached" : "live",
                "",
                "━━━━━━━━━━━━━━━━━━━━",
                ""
            ];

            if (result.total === 0) {
                lines.push("Tidak ditemukan device yang cocok.");
                lines.push("");
            }

            let index = 1;

            for (const device of result.devices) {

                const scoreLabel =
                    device.score >= 100 ? "⭐" :
                    device.score >= 60 ? "✓" :
                    "•";

                lines.push(`${index}️⃣ ${device.device || "-"}`);
                lines.push("");
                lines.push("Score");
                lines.push(`${device.score} ${scoreLabel}`);
                lines.push("");
                lines.push("ObjID");
                lines.push(String(device.objid));
                lines.push("");
                lines.push("Host");
                lines.push(device.host || "-");
                lines.push("");
                lines.push("Group");
                lines.push(device.group || "-");
                lines.push("");
                lines.push("Probe");
                lines.push(device.probe || "-");
                lines.push("");
                lines.push("Status");
                lines.push(device.isPaused ? "⏸ Paused" : "🟢 Up");
                lines.push("");

                const deviceUpper =
                    String(device.device || "").toUpperCase();

                const isLegacy = LEGACY_WARNING_MARKERS.some(marker =>
                    deviceUpper.includes(marker)
                );

                if (isLegacy) {
                    lines.push("⚠️ Possible legacy/old device");
                    lines.push("");
                }

                lines.push("━━━━━━━━━━━━━━━━━━━━");
                lines.push("");
                index++;
            }

            if (result.total > 0 && result.total >= MAX_DEEP_RESULTS) {
                lines.push("⚠️ Mungkin ada hasil lain. Gunakan query yang lebih spesifik.");
                lines.push("");
            }

            lines.push("🕒 " + now);

            const message = lines.join("\n");
            const chunks = splitMessage(message, 4000);

            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }

        } catch (error) {

            console.error("[CMD /find_prtg_deep]", error);

            await ctx.reply(
                "❌ Deep search gagal.\n\n" +
                "PRTG API tidak dapat diakses saat ini."
            );
        }
    });

    // ========================================================
    // /prtg_device <objid>
    // ========================================================

    bot.command("prtg_device", async (ctx) => {

        console.log("[CMD] /prtg_device");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {

            await ctx.reply(
                "📡 PRTG DEVICE INSPECTOR\n\n" +
                "Format:\n" +
                "/prtg_device <objid>\n\n" +
                "Contoh:\n" +
                "/prtg_device 14520"
            );

            return;
        }

        const objid = Number(parts[1]);

        if (!Number.isInteger(objid) || objid < 1) {
            await ctx.reply(
                "❌ ObjID harus berupa angka."
            );
            return;
        }

        try {

            const device = await fetchDeviceDetail(objid);

            if (!device) {
                await ctx.reply(
                    "❌ Device tidak ditemukan."
                );
                return;
            }

            if (device.isSensor) {
                await ctx.reply(
                    "❌ ObjID bukan device."
                );
                return;
            }

            const now = formatDateTime(new Date().toISOString());

            const lines = [
                "📡 PRTG DEVICE",
                "",
                device.device || "-",
                "",
                "ObjID",
                String(device.objid),
                "",
                "Host",
                device.host || "-",
                "",
                "Group",
                device.group || "-",
                "",
                "Probe",
                device.probe || "-",
                "",
                "Status",
                device.isPaused ? "⏸ Paused" : "🟢 Up",
                ""
            ];

            const deviceUpper =
                String(device.device || "").toUpperCase();

            const isLegacy = LEGACY_WARNING_MARKERS.some(marker =>
                deviceUpper.includes(marker)
            );

            if (isLegacy) {
                lines.push("⚠️ Possible legacy/old device");
                lines.push("");
            }

            lines.push("━━━━━━━━━━━━━━━━━━━━");
            lines.push("");

            if (device.sensors.length > 0) {

                const displaySensors = device.sensors.slice(0, 20);

                lines.push("Sensors");
                lines.push(`${displaySensors.length} of ${device.sensorCount}`);
                lines.push("");

                for (const sensor of displaySensors) {

                    const icon = sensor.isPaused ? "⏸" : "🟢";

                    const isPrimary =
                        device.primarySensorName &&
                        sensor.name === device.primarySensorName;

                    const marker = isPrimary ? "⭐" : "  ";

                    lines.push(`${marker} ${icon} ${sensor.name || "-"}`);
                    lines.push("");
                    lines.push("ObjID");
                    lines.push(String(sensor.objid));
                    lines.push("");
                    lines.push("Status");
                    lines.push(sensor.isPaused ? "Paused" : formatSensorStatusShort(sensor.status));
                    lines.push("");

                    if (sensor.lastvalue) {
                        lines.push("Last Value");
                        lines.push(sensor.lastvalue);
                        lines.push("");
                    }
                }

            } else {
                lines.push("Tidak ada sensor ditemukan untuk device ini.");
                lines.push("");
            }

            lines.push("────");
            lines.push("");
            lines.push("🕒 " + now);

            const message = lines.join("\n");
            const chunks = splitMessage(message, 4000);

            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }

        } catch (error) {

            console.error("[CMD /prtg_device]", error);

            await ctx.reply(
                "❌ Gagal mengambil detail device."
            );
        }
    });


    // ========================================================
    // /find_prtg_sensor <query>
    // ========================================================

    bot.command("find_prtg_sensor", async (ctx) => {

        console.log("[CMD] /find_prtg_sensor");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {

            await ctx.reply(
                "🔍 PRTG SENSOR SEARCH\n\n" +
                "Format:\n" +
                "/find_prtg_sensor <query>\n\n" +
                "Contoh:\n" +
                "/find_prtg_sensor CITRA\n" +
                "/find_prtg_sensor 2025499622\n\n" +
                `Query minimal 3 karakter. Maksimal ${MAX_DEEP_RESULTS} hasil.`
            );

            return;
        }

        const query = parts.slice(1).join(" ");

        try {

            const result = await findPrtgSensor(query);

            const now = formatDateTime(new Date().toISOString());

            let lines = [
                "🔎 PRTG SENSOR SEARCH",
                "",
                "Query",
                query,
                "",
                "Found",
                String(result.total),
                "sensors",
                "",
                "━━━━━━━━━━━━━━━━━━━━",
                ""
            ];

            if (result.total === 0) {
                lines.push("Tidak ditemukan sensor yang cocok.");
                lines.push("");
            }

            let index = 1;

            for (const sensor of result.sensors) {

                const scoreLabel =
                    sensor.score >= 100 ? "⭐" :
                    sensor.score >= 70 ? "✓" :
                    "•";

                lines.push(`${index}️⃣ ${sensor.sensor || "-"}`);
                lines.push("");
                lines.push("Type");
                lines.push(sensor.sensor_type || "-");
                lines.push("");
                lines.push("ObjID");
                lines.push(String(sensor.objid));
                lines.push("");
                lines.push("Status");
                lines.push(formatSensorStatusShort(sensor.status));
                lines.push("");
                lines.push("Last Value");
                lines.push(sensor.lastvalue || "-");
                lines.push("");

                if (sensor.device) {
                    lines.push("Parent Device");
                    lines.push(sensor.device);
                    lines.push("");
                    lines.push("Device ObjID");
                    lines.push(String(sensor.device_objid));
                    lines.push("");
                    lines.push("Group");
                    lines.push(sensor.group || "-");
                    lines.push("");
                }

                lines.push("━━━━━━━━━━━━━━━━━━━━");
                lines.push("");
                index++;
            }

            if (result.total >= MAX_DEEP_RESULTS) {
                lines.push("⚠️ Mungkin ada hasil lain. Gunakan query yang lebih spesifik.");
                lines.push("");
            }

            lines.push("🕒 " + now);

            const message = lines.join("\n");
            const chunks = splitMessage(message, 4000);

            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }

        } catch (error) {

            console.error("[CMD /find_prtg_sensor]", error);

            await ctx.reply(
                "❌ Sensor search gagal.\n\n" +
                "PRTG API tidak dapat diakses saat ini."
            );
        }
    });

    // ========================================================
    // /prtg_sensor <objid>
    // ========================================================

    bot.command("prtg_sensor", async (ctx) => {

        console.log("[CMD] /prtg_sensor");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {

            await ctx.reply(
                "📡 PRTG SENSOR INSPECTOR\n\n" +
                "Format:\n" +
                "/prtg_sensor <sensor_objid>\n\n" +
                "Contoh:\n" +
                "/prtg_sensor 18432"
            );

            return;
        }

        const objid = Number(parts[1]);

        if (!Number.isInteger(objid) || objid < 1) {
            await ctx.reply(
                "❌ ObjID harus berupa angka."
            );
            return;
        }

        const { fetchSensorByObjid } = require("../prtg/search");

        try {

            const sensor = await fetchSensorByObjid(objid);

            if (!sensor) {
                await ctx.reply(
                    "❌ Sensor tidak ditemukan."
                );
                return;
            }

            if (sensor.isDevice) {
                await ctx.reply(
                    "❌ ObjID tersebut adalah device, bukan sensor."
                );
                return;
            }

            if (sensor.notFound) {
                await ctx.reply(
                    "❌ Sensor tidak ditemukan."
                );
                return;
            }

            const now = formatDateTime(new Date().toISOString());

            const lines = [
                "📡 PRTG SENSOR",
                "",
                sensor.sensor || "-",
                "",
                "ObjID",
                String(sensor.objid),
                "",
                "Status",
                formatSensorStatusShort(sensor.status),
                "",
                "Last Value",
                sensor.lastvalue || "-"
            ];

            if (sensor.message) {
                lines.push("");
                lines.push("Message");
                lines.push(sensor.message);
            }

            if (sensor.parentDevice) {

                lines.push("");
                lines.push("━━━━━━━━━━━━━━━━━━━━");
                lines.push("");
                lines.push("Parent Device");
                lines.push("");
                lines.push(sensor.parentDevice.device || "-");
                lines.push("");
                lines.push("Device ObjID");
                lines.push(String(sensor.parentDevice.objid));
                lines.push("");
                lines.push("Host");
                lines.push(sensor.parentDevice.host || "-");
                lines.push("");
                lines.push("Group");
                lines.push(sensor.parentDevice.group || "-");
                lines.push("");
                lines.push("Status");
                lines.push(sensor.parentDevice.isPaused ? "⏸ Paused" : "🟢 Up");
            }

            lines.push("");
            lines.push("────");
            lines.push("");
            lines.push("🕒 " + now);

            await ctx.reply(lines.join("\n"));

        } catch (error) {

            console.error("[CMD /prtg_sensor]", error);

            await ctx.reply(
                "❌ Gagal mengambil detail sensor."
            );
        }
    });


    // ========================================================
    // /help
    // ========================================================

    bot.command("help", async (ctx) => {

        console.log("[CMD] /help");

        const admin = isAdmin(ctx.from?.id);
        const isGroup = isGroupChat(ctx);
        const group = isGroup ? getRegisteredGroup(ctx) : null;
        const isRegisteredGroup = Boolean(group && group.enabled);

        const SEP = "━━━━━━━━━━━━━━━━━━━━";

        let message =
            "🤖 MONITORING BOT\n\n" +

            SEP + "\n\n" +

            "📊 MONITORING\n\n" +
            "/status\n" +
            "/status <id>\n" +
            "/health\n\n" +

            "👥 CUSTOMER\n\n" +
            "/clients\n" +
            "/client <id>\n\n";

        if (isRegisteredGroup) {
            message += "/group_clients\n";
            message += "/group_id\n\n";
        } else if (isGroup && !group) {
            message += "/group_id\n\n";
        }

        if (admin) {
            message +=
                "🗺 PRTG MAPPING\n\n" +
                "/mapping\n" +
                "/mapping <id>\n" +
                "/find_prtg <query>\n" +
                "/find_prtg_deep <query>\n" +
                "/find_prtg_sensor <query>\n" +
                "/prtg_device <objid>\n" +
                "/prtg_sensor <objid>\n\n" +
                "/map_client <id> <objid>\n" +
                "/map_sensor <id> <objid>\n" +
                "/unmap_client <id>\n\n" +
                "🧭 SCOPE\n\n" +
                "/set_scope <id> <scope>\n\n" +
                "👤 CUSTOMER\n\n" +
                "/add_client\n" +
                "/remove_client <id>\n" +
                "/enable_client <id>\n" +
                "/disable_client <id>\n\n" +
                "👥 GROUPS\n\n" +
                "/register_group\n" +
                "/groups\n" +
                "/assign_group <client_id>\n" +
                "/group_alerts <client_id> on|off\n" +
                "/unassign_group <client_id>\n" +
                "/unregister_group\n\n";
        }

        message +=
            "ℹ️ UTILITY\n\n" +
            "/id\n" +
            "/chatid\n" +
            "/cancel";

        await ctx.reply(message);
    });
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {
    registerCommands
};
