const customers = require("../database/customers");
const config = require("../config/env");
const { buildMonitoringSummary } = require("../monitoring/classifier");
const { classifyCustomer, CLASSIFICATIONS, classificationIcon, formatDateTime, formatStateDisplay, formatLatency, formatPacketLoss, isAlertEligible } = require("../monitoring/classifier");
const { loadState, loadAllStates } = require("../monitoring/state-store");
const { getHeartbeatData } = require("../monitoring/engine");
const { notifyTestAlert } = require("../monitoring/notifier");
const { normalizeSensorStatus } = require("../monitoring/evaluator");

const {
    SCOPES,
    normalizeScopeInput,
    scopeDisplay
} = require("../constants/scopes");

const {
    backendLabel,
    backendShort,
    getExpectedBackend,
    getAlertingStatus,
    getMonitoringBackendFromState
} = require("./backend-helpers");

const ui = require("./ui");
const {
    separator,
    safe,
    formatScopeLabel,
    operatorCard,
    section,
    formatCustomerIdentity,
    renderStatusSummary,
    renderCustomerStatus,
    renderClientDetail,
    renderMappingSummary,
    renderMappingDetail,
    renderHealthSummary,
    formatClientListItem,
    successMessage,
    errorMessage,
    warningMessage,
    accessDeniedMessage,
    infoMessage,
    confirmationMessage,
    escapeHtml
} = ui;

const {
    requireAdmin,
    isAdmin
} = require("./auth");

const {
    hasActiveSession,
    clearSession
} = require("./add-client");

const {
    hasActiveSession: hasActiveMappingSession,
    clearSession: clearMappingSession,
    startMapClient,
    processConfirmMap,
    startUnmapClient,
    processConfirmUnmap,
    startMapSensor,
    processConfirmMapSensor
} = require("./manual-mapping");

const { getInventorySummary } = require("../prtg/inventory");

const { formatDateTimeRelative } = require("../monitoring/classifier");

// ============================================================
// SESSION MAPS
// ============================================================

const scopeSessions = new Map();

const removeSessions = new Map();

// ============================================================
// HELPERS
// ============================================================

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

function getCommandArgument(ctx) {

    const text = ctx.message?.text || "";

    const parts = text.trim().split(/\s+/);

    if (parts.length < 2) {
        return null;
    }

    return parts[1];
}

function getCustomerAndInventory(id) {

    const customer = customers.getCustomerByClientId(id);

    if (!customer) {
        return { customer: null, inventoryItem: null };
    }

    const item = getInventoryItem(id);

    return { customer, inventoryItem: item };
}

function getInventoryItem(clientId) {

    const { inventory } = getInventorySummary();

    return inventory.find(
        i => i.clientId === Number(clientId)
    );
}

function loadMonitoringState(customer) {

    if (!customer) {
        return null;
    }

    return loadState(customer.id);
}

// ============================================================
// REGISTER
// ============================================================

function registerCustomerCommands(bot) {

    // ========================================================
    // /clients
    // ========================================================

    bot.command("clients", async (ctx) => {

        console.log("[CMD] /clients");

        try {

            const list = customers.getCustomers();

            if (list.length === 0) {
                await ctx.reply(
                    "📋 Belum ada customer terdaftar."
                );
                return;
            }

            const { inventory } = getInventorySummary();
            const stateByCustomer = {};
            for (const s of loadAllStates()) {
                stateByCustomer[s.customer_id] = s;
            }

            const now = new Date().toISOString();
            const timestamp = formatDateTimeRelative(now);

            const lines = [
                "👥 CUSTOMER LIST",
                "",
                `Total: ${list.length}`,
                ""
            ];

            list.forEach((customer, index) => {

                const listNumber = index + 1;

                const item = inventory.find(
                    i => i.clientId === customer.client_id
                );

                const state = stateByCustomer[customer.id] || null;

                const classification = classifyCustomer(
                    customer,
                    item,
                    state,
                    config
                );

                const icon = classificationIcon(classification.category);

                let statePart = "";
                if (classification.active) {

                    const stateText = formatStateDisplay(
                        state ? state.current_state : null
                    );
                    statePart = ` • ${stateText}`;
                }

                const header = `#${listNumber} ${customer.name}`;

                lines.push(`${icon} ${header}${statePart}`);

                let secondLine = "";
                if (classification.category === CLASSIFICATIONS.PAUSED_PRTG) {
                    secondLine = `Sensors: ${safe(item?.sensorCount, 0)} (${safe(item?.pausedSensorCount, 0)} paused)`;
                } else if (classification.category === CLASSIFICATIONS.UNRESOLVED_PRTG) {
                    secondLine = "No mapping";
                } else if (classification.category === CLASSIFICATIONS.PIC_MANAGED) {
                    secondLine = customer.description || customer.name;
                } else if (classification.category === CLASSIFICATIONS.DISABLED) {
                    secondLine = "Disabled";
                }

                if (secondLine) {
                    lines.push(`    ${secondLine} • ${customer.ip}`);
                } else {
                    lines.push(`    ${customer.ip}`);
                }

                lines.push("");
            });

            lines.push(separator());
            lines.push("");
            lines.push(`🕒 ${timestamp}`);

            const message = lines.join("\n");
            const chunks = splitMessage(message, 4000);

            for (const chunk of chunks) {
                await ctx.reply(chunk);
            }

        } catch (error) {

            console.error("[CMD /clients]", error);

            await ctx.reply(
                errorMessage("Gagal mengambil daftar customer.")
            );
        }
    });

    // ========================================================
    // /client <id>
    // ========================================================

    bot.command("client", async (ctx) => {

        console.log("[CMD] /client");

        const id = getCommandArgument(ctx);

        if (!id) {
            await ctx.reply(
                warningMessage(
                    "Gunakan /client <id>.",
                    "Contoh: /client 11"
                )
            );
            return;
        }

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("ID harus berupa angka.")
            );
            return;
        }

        const { customer, inventoryItem } = getCustomerAndInventory(id);

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    `Client ID #${id} tidak ditemukan.`
                )
            );
            return;
        }

        const monitoringState = loadMonitoringState(customer);

        const classification = classifyCustomer(
            customer,
            inventoryItem,
            monitoringState,
            config
        );

        try {

            const message = renderClientDetail(
                customer,
                inventoryItem,
                classification,
                monitoringState
            );

            await ctx.reply(message);

        } catch (error) {

            console.error("[CMD /client]", error);

            await ctx.reply(
                errorMessage("Gagal memuat detail customer.")
            );
        }
    });

    // ========================================================
    // /enable_client <id>
    // ========================================================

    bot.command("enable_client", async (ctx) => {

        console.log("[CMD] /enable_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const id = getCommandArgument(ctx);

        if (!id) {
            await ctx.reply(
                warningMessage(
                    "Gunakan /enable_client <id>.",
                    "Contoh: /enable_client 11"
                )
            );
            return;
        }

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("ID harus berupa angka.")
            );
            return;
        }

        const customer = customers.getCustomerByClientId(id);

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    `Client ID #${id} tidak ditemukan.`
                )
            );
            return;
        }

        if (customer.enabled) {
            await ctx.reply(
                infoMessage(
                    `Customer #${id} ${customer.name}`,
                    "Sudah aktif."
                )
            );
            return;
        }

        customers.enable(customer.id);

        await ctx.reply(
            successMessage(
                "CUSTOMER ENABLED",
                [
                    `#${id} ${customer.name}`,
                    `🌐 ${customer.ip}`,
                    "",
                    "Monitoring eligibility will be evaluated",
                    "on the next monitoring cycle."
                ]
            )
        );
    });

    // ========================================================
    // /disable_client <id>
    // ========================================================

    bot.command("disable_client", async (ctx) => {

        console.log("[CMD] /disable_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const id = getCommandArgument(ctx);

        if (!id) {
            await ctx.reply(
                warningMessage(
                    "Gunakan /disable_client <id>.",
                    "Contoh: /disable_client 11"
                )
            );
            return;
        }

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("ID harus berupa angka.")
            );
            return;
        }

        const customer = customers.getCustomerByClientId(id);

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    `Client ID #${id} tidak ditemukan.`
                )
            );
            return;
        }

        if (!customer.enabled) {
            await ctx.reply(
                infoMessage(
                    `Customer #${id} ${customer.name}`,
                    "Sudah nonaktif."
                )
            );
            return;
        }

        customers.disable(customer.id);

        await ctx.reply(
            "🚫 CUSTOMER DISABLED\n\n" +
            `#${id} ${customer.name}\n` +
            `🌐 ${customer.ip}\n\n` +
            "Bot Monitoring\n" +
            "Stopped\n\n" +
            "Alerting\n" +
            "Disabled"
        );
    });

    // ========================================================
    // /mapping
    // ========================================================

    bot.command("mapping", async (ctx) => {

        console.log("[CMD] /mapping");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const id = getCommandArgument(ctx);

        try {

            if (id) {

                const { customer, inventoryItem } = getCustomerAndInventory(id);

                if (!customer) {
                    await ctx.reply(
                        errorMessage(
                            "CUSTOMER NOT FOUND",
                            `Client ID #${id} tidak ditemukan.`
                        )
                    );
                    return;
                }

                const monitoringState = loadMonitoringState(customer);
                const classification = classifyCustomer(
                    customer,
                    inventoryItem,
                    monitoringState,
                    config
                );

                await ctx.reply(
                    renderMappingDetail(
                        customer,
                        inventoryItem,
                        classification,
                        monitoringState
                    )
                );

            } else {

                const summary = buildMonitoringSummary();

                await ctx.reply(renderMappingSummary(summary));
            }

        } catch (error) {

            console.error("[CMD /mapping]", error);

            await ctx.reply(
                errorMessage("Gagal memuat mapping inventory.")
            );
        }
    });

    // ========================================================
    // /map_client <id> <objid>
    // ========================================================

    bot.command("map_client", async (ctx) => {

        console.log("[CMD] /map_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await startMapClient(ctx);
    });

    // ========================================================
    // /confirm_map
    // ========================================================

    bot.command("confirm_map", async (ctx) => {

        console.log("[CMD] /confirm_map");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await processConfirmMap(ctx);
    });

    // ========================================================
    // /unmap_client <id>
    // ========================================================

    bot.command("unmap_client", async (ctx) => {

        console.log("[CMD] /unmap_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await startUnmapClient(ctx);
    });

    // ========================================================
    // /confirm_unmap
    // ========================================================

    bot.command("confirm_unmap", async (ctx) => {

        console.log("[CMD] /confirm_unmap");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await processConfirmUnmap(ctx);
    });

    // ========================================================
    // /map_sensor <id> <sensor_objid>
    // ========================================================

    bot.command("map_sensor", async (ctx) => {

        console.log("[CMD] /map_sensor");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await startMapSensor(ctx);
    });

    // ========================================================
    // /confirm_map_sensor
    // ========================================================

    bot.command("confirm_map_sensor", async (ctx) => {

        console.log("[CMD] /confirm_map_sensor");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        await processConfirmMapSensor(ctx);
    });

    // ========================================================
    // /set_scope <id> <scope> [note]
    // ========================================================

    bot.command("set_scope", async (ctx) => {

        console.log("[CMD] /set_scope");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from.id);

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 3) {

            await ctx.reply(
                warningMessage(
                    "GUNAKAN: /set_scope <id> <scope> [catatan]",
                    "/set_scope 21 not_in_prtg\n" +
                    "/set_scope 18 pic_managed\n" +
                    "/set_scope 11 prtg"
                )
            );

            return;
        }

        const clientIdInput = parts[1];
        const scopeInput = parts[2];
        const noteInput = parts.slice(3).join(" ") || null;

        if (!/^\d+$/.test(clientIdInput)) {
            await ctx.reply(
                errorMessage("client_id harus berupa angka.")
            );
            return;
        }

        const clientId = Number(clientIdInput);

        const normalizedScope = normalizeScopeInput(scopeInput);

        if (!normalizedScope) {
            await ctx.reply(
                errorMessage(
                    "Scope tidak valid.",
                    "Gunakan: prtg, not_in_prtg, pic_managed"
                )
            );
            return;
        }

        const customer = customers.getCustomerByClientId(clientId);

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    `Client ID #${clientId} tidak ditemukan.`
                )
            );
            return;
        }

        const currentScope = customer.monitoring_scope || SCOPES.PRTG;

        if (currentScope === normalizedScope) {
            await ctx.reply(
                infoMessage(
                    `Scope customer sudah ${scopeDisplay(normalizedScope)}.`,
                    "Tidak ada perubahan yang dilakukan."
                )
            );
            return;
        }

        const displayMap = {
            prtg: "📡 PRTG",
            not_in_prtg: "🚫 NOT IN PRTG",
            pic_managed: "👤 PIC MANAGED"
        };

        scopeSessions.set(userId, {
            customerId: customer.id,
            clientId: customer.client_id,
            customerName: customer.name,
            customerIp: customer.ip,
            customerLocation: customer.location,
            newScope: normalizedScope,
            newScopeLabel: displayMap[normalizedScope],
            currentScope: currentScope,
            currentScopeLabel: displayMap[currentScope] || "📡 PRTG",
            note: noteInput
        });

        const effectLines = [];

        if (normalizedScope === SCOPES.NOT_IN_PRTG) {
            effectLines.push(
                "• mapping tidak diperlukan",
                "• customer dipantau via Direct ICMP Ping",
                "• masih menghasilkan DOWN/RECOVERY alert jika kondisi gagal"
            );
        } else if (normalizedScope === SCOPES.PIC_MANAGED) {
            effectLines.push(
                "• customer tetap terlihat",
                "• tidak dipantau oleh bot ini",
                "• tidak dianggap kegagalan mapping"
            );
        } else {
            effectLines.push(
                "• customer kembali ke monitoring",
                "• mapping diperlukan",
                "• polling pertama sebagai baseline (no alert)"
            );
        }

        const identity = [
            `#${customer.client_id} ${customer.name}`,
            `🌐 ${customer.ip}`
        ];

        const bodyLines = [
            "Action",
            "Change Monitoring Scope",
            "",
            "Current",
            displayMap[currentScope] || "📡 PRTG",
            "",
            "New",
            displayMap[normalizedScope]
        ];

        if (noteInput) {
            bodyLines.push("");
            bodyLines.push("📝 Catatan");
            bodyLines.push(noteInput);
        }

        bodyLines.push("");
        bodyLines.push("Effect");
        bodyLines.push(...effectLines);

        await ctx.reply(
            confirmationMessage(
                "CONFIRM ACTION",
                identity,
                bodyLines,
                "/confirm_scope",
                "/cancel"
            )
        );
    });

    // ========================================================
    // /confirm_scope
    // ========================================================

    bot.command("confirm_scope", async (ctx) => {

        console.log("[CMD] /confirm_scope");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from.id);

        const session = scopeSessions.get(userId);

        if (!session) {
            await ctx.reply(
                infoMessage(
                    "Tidak ada sesi scope change yang menunggu konfirmasi."
                )
            );
            return;
        }

        try {

            customers.updateScope(
                session.customerId,
                session.newScope,
                {
                    note: session.note,
                    updatedBy: userId
                }
            );

            const { resetMonitoringState } = require("../monitoring/state-store");

            resetMonitoringState(session.customerId);

            console.log(
                `[SCOPE] Customer #${session.clientId} ` +
                `${session.customerName} scope changed ` +
                `${session.currentScope} -> ${session.newScope}`
            );

            scopeSessions.delete(userId);

            const displayMap = {
                prtg: "📡 PRTG",
                not_in_prtg: "🚫 NOT IN PRTG",
                pic_managed: "👤 PIC MANAGED"
            };

            let noteLine = "";
            if (session.note) {
                noteLine = `\n📝 ${session.note}`;
            }

            const identity = [
                `#${session.clientId} ${session.customerName}`,
                `🌐 ${session.customerIp}`
            ];

            await ctx.reply(
                successMessage(
                    "SCOPE CHANGED",
                    [
                        ...identity,
                        "",
                        `Before: ${displayMap[session.currentScope] || "📡 PRTG"}`,
                        `After:  ${displayMap[session.newScope]}${noteLine}`,
                        "",
                        "Monitoring state telah direset.",
                        "Polling pertama akan menjadi baseline (tanpa alert)."
                    ]
                )
            );

        } catch (error) {

            console.error(
                "[SCOPE] Failed to update scope:",
                error
            );

            await ctx.reply(
                errorMessage(
                    "Gagal mengubah scope customer.",
                    escapeHtml(error.message)
                )
            );
        }
    });

    // ========================================================
    // /status
    // ========================================================

    bot.command("status", async (ctx) => {

        console.log("[CMD] /status");

        const id = getCommandArgument(ctx);

        try {

            if (id) {

                const { customer, inventoryItem } = getCustomerAndInventory(id);

                if (!customer) {
                    await ctx.reply(
                        errorMessage(
                            "CUSTOMER NOT FOUND",
                            `Client ID #${id} tidak ditemukan.`
                        )
                    );
                    return;
                }

                const monitoringState = loadMonitoringState(customer);
                const classification = classifyCustomer(
                    customer,
                    inventoryItem,
                    monitoringState,
                    config
                );

                await ctx.reply(
                    renderCustomerStatus(
                        customer,
                        inventoryItem,
                        classification,
                        monitoringState
                    )
                );

            } else {

                const summary = buildMonitoringSummary();

                await ctx.reply(renderStatusSummary(summary));
            }

        } catch (error) {

            console.error("[CMD /status]", error);

            await ctx.reply(
                errorMessage("Gagal memuat status monitoring.")
            );
        }
    });

    // ========================================================
    // /health
    // ========================================================

    bot.command("health", async (ctx) => {

        console.log("[CMD] /health");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        try {

            const summary = buildMonitoringSummary();
            const heartbeat = getHeartbeatData();

            await ctx.reply(renderHealthSummary(summary, heartbeat));

        } catch (error) {

            console.error("[CMD /health]", error);

            await ctx.reply(
                errorMessage("Gagal memuat health check.")
            );
        }
    });

    // ========================================================
    // /test_alert
    // ========================================================

    bot.command("test_alert", async (ctx) => {

        console.log("[CMD] /test_alert");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        if (!config.telegram.chatId) {
            await ctx.reply(
                errorMessage(
                    "TELEGRAM_CHAT_ID belum dikonfigurasi."
                )
            );
            return;
        }

        if (!config.monitoring.alertsEnabled) {
            await ctx.reply(
                warningMessage(
                    "Alerts disabled",
                    "ALERTS_ENABLED=false. Test alert will still be sent."
                )
            );
        }

        try {

            await notifyTestAlert(bot);

            await ctx.reply(
                successMessage(
                    "Test alert sent",
                    ["Delivery successful"]
                )
            );

        } catch (error) {

            console.error("[CMD /test_alert]", error);

            await ctx.reply(
                errorMessage("Test alert gagal dikirim.")
            );
        }
    });

    // ========================================================
    // /remove_client <id>
    // ========================================================

    bot.command("remove_client", async (ctx) => {

        console.log("[CMD] /remove_client");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const id = getCommandArgument(ctx);

        if (!id) {
            await ctx.reply(
                warningMessage(
                    "Gunakan /remove_client <id>.",
                    "Contoh: /remove_client 21"
                )
            );
            return;
        }

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("ID harus berupa angka.")
            );
            return;
        }

        const customer = customers.getCustomerByClientId(id);

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    `Client ID #${id} tidak ditemukan.`
                )
            );
            return;
        }

        const identity = [
            `#${customer.client_id} ${customer.name}`,
            `🌐 ${customer.ip}`
        ];

        await ctx.reply(
            confirmationMessage(
                "CONFIRM REMOVE CUSTOMER",
                identity,
                [
                    "This action will remove the customer",
                    "from the bot registry.",
                    "",
                    "Related mappings/state may also be removed",
                    "according to current database behavior."
                ],
                "/confirm_remove",
                "/cancel"
            )
        );

        removeSessions.set(
            String(ctx.from.id),
            customer.id
        );
    });

    // ========================================================
    // /confirm_remove
    // ========================================================

    bot.command("confirm_remove", async (ctx) => {

        console.log("[CMD] /confirm_remove");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from.id);

        const id = removeSessions.get(userId);

        if (!id) {
            await ctx.reply(
                infoMessage(
                    "Tidak ada penghapusan yang menunggu konfirmasi."
                )
            );
            return;
        }

        const customer = customers.getCustomerById(id);

        if (!customer) {
            removeSessions.delete(userId);
            await ctx.reply(
                errorMessage("Customer sudah tidak ditemukan.")
            );
            return;
        }

        customers.remove(id);
        customers.reindexClientIds();

        removeSessions.delete(userId);

        await ctx.reply(
            successMessage(
                "CUSTOMER REMOVED",
                [
                    `#${customer.client_id} ${customer.name}`,
                    `🌐 ${customer.ip}`,
                    "",
                    `Database ID: ${id}`
                ]
            )
        );
    });

    // ========================================================
    // /cancel
    // ========================================================

    bot.command("cancel", async (ctx) => {

        const userId = String(ctx.from.id);
        let cancelled = false;

        if (removeSessions.has(userId)) {
            removeSessions.delete(userId);
            cancelled = true;
        }

        if (hasActiveSession(userId)) {
            clearSession(userId);
            cancelled = true;
        }

        if (hasActiveMappingSession(userId)) {
            clearMappingSession(userId);
            cancelled = true;
        }

        if (scopeSessions.has(userId)) {
            scopeSessions.delete(userId);
            cancelled = true;
        }

        if (cancelled) {
            await ctx.reply(
                successMessage(
                    "ACTION CANCELLED",
                    ["Pending operation has been cleared."]
                )
            );
        } else {
            await ctx.reply(
                infoMessage("No pending operation.")
            );
        }
    });
}

module.exports = {
    registerCustomerCommands
};
