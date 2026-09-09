const customers = require("../database/customers");
const config = require("../config/env");
const { buildMonitoringSummary } = require("../monitoring/classifier");
const { classifyCustomer, CLASSIFICATIONS, classificationIcon } = require("../monitoring/classifier");
const { loadState } = require("../monitoring/state-store");
const { getInventorySummary } = require("../prtg/inventory");

const {
    registerGroup,
    getGroupByChatId,
    getGroupById,
    listGroups,
    deleteGroup,
    assignCustomerToGroup,
    unassignCustomerFromGroup,
    getGroupCustomers,
    getGroupVisibleCustomers,
    isCustomerAssignedToGroup,
    setGroupAlertPreference,
    getAssignmentFlags
} = require("../database/telegram-groups");

const {
    isPrivateChat,
    isGroupChat,
    getChatId,
    getRegisteredGroup,
    requireRegisteredGroup,
    getVisibleCustomersForContext,
    canViewCustomerInContext
} = require("./group-context");

const ui = require("./ui");
const {
    separator,
    safe,
    successMessage,
    errorMessage,
    warningMessage,
    infoMessage,
    confirmationMessage,
    renderGroupRegistered,
    renderGroupAlreadyRegistered,
    renderGroupList,
    renderGroupInfo,
    renderGroupClients,
    renderGroupAssignmentConfirmation,
    renderGroupUnassignConfirmation,
    renderGroupRemoveConfirmation,
    renderGroupAlertToggle
} = ui;

const {
    requireAdmin
} = require("./auth");

// ============================================================
// PENDING SESSIONS
// ============================================================

const groupAssignSessions = new Map();
const groupUnassignSessions = new Map();
const groupRemoveSessions = new Map();

function hasActiveGroupSession(userId) {
    return (
        groupAssignSessions.has(String(userId)) ||
        groupUnassignSessions.has(String(userId)) ||
        groupRemoveSessions.has(String(userId))
    );
}

function clearGroupSession(userId) {
    const key = String(userId);
    groupAssignSessions.delete(key);
    groupUnassignSessions.delete(key);
    groupRemoveSessions.delete(key);
}

// ============================================================
// /register_group
// ============================================================

function registerGroupCommands(bot) {

    bot.command("register_group", async (ctx) => {

        console.log("[CMD] /register_group");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP REQUIRED",
                    "Command ini harus dijalankan di Telegram group."
                )
            );
            return;
        }

        const chatId = getChatId(ctx);
        const groupName = ctx.chat?.title || ctx.message?.chat?.title || "Unknown Group";

        const result = registerGroup({
            chatId: chatId,
            name: groupName
        });

        if (result.isNew) {
            await ctx.reply(renderGroupRegistered(result));
        } else {
            await ctx.reply(renderGroupAlreadyRegistered(result));
        }
    });

    // ========================================================
    // /groups
    // ========================================================

    bot.command("groups", async (ctx) => {

        console.log("[CMD] /groups");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const groups = listGroups();

        if (groups.length === 0) {
            await ctx.reply(
                infoMessage(
                    "No registered groups.",
                    "Run /register_group inside a Telegram group to start."
                )
            );
            return;
        }

        await ctx.reply(renderGroupList(groups));
    });

    // ========================================================
    // /group_id
    // ========================================================

    bot.command("group_id", async (ctx) => {

        console.log("[CMD] /group_id");

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP ONLY",
                    "Command ini hanya berlaku di Telegram group."
                )
            );
            return;
        }

        const chatId = getChatId(ctx);
        const groupName = ctx.chat?.title || ctx.message?.chat?.title || "Unknown Group";

        const group = getGroupByChatId(chatId);

        if (group) {
            await ctx.reply(renderGroupInfo(group));
        } else {
            await ctx.reply(
                renderGroupInfo({
                    name: groupName,
                    chat_id: chatId,
                    enabled: false
                })
            );
        }
    });

    // ========================================================
    // /group_clients
    // ========================================================

    bot.command("group_clients", async (ctx) => {

        console.log("[CMD] /group_clients");

        const group = await requireRegisteredGroup(ctx);

        if (!group) {
            return;
        }

        const { inventory, customerStates } = getVisibleGroupCustomers(group.id);

        if (inventory.length === 0) {
            await ctx.reply(
                infoMessage(
                    "No customers assigned to this group.",
                    "Use /assign_group <client_id> to assign customers."
                )
            );
            return;
        }

        const classificationMap = new Map();
        const allStates = customerStates;

        for (const item of inventory) {
            const state = allStates[item.customerId] || null;
            const c = item;
            const classification = classifyCustomer(c, item, state, config);
            classificationMap.set(item.customerId, classification);
        }

        await ctx.reply(renderGroupClients(group, inventory, classificationMap));
    });

    // ========================================================
    // /group_alerts <client_id> on|off
    // ========================================================

    bot.command("group_alerts", async (ctx) => {

        console.log("[CMD] /group_alerts");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP REQUIRED",
                    "Command ini harus dijalankan di Telegram group."
                )
            );
            return;
        }

        const group = await requireRegisteredGroup(ctx);

        if (!group) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 3) {
            await ctx.reply(
                errorMessage(
                    "Gunakan /group_alerts <client_id> on|off.",
                    "Contoh: /group_alerts 11 on"
                )
            );
            return;
        }

        const id = parts[1];
        const toggle = parts[2].toLowerCase();

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("client_id harus berupa angka.")
            );
            return;
        }

        if (toggle !== "on" && toggle !== "off") {
            await ctx.reply(
                errorMessage(
                    "Argumen harus 'on' atau 'off'.",
                    "Contoh: /group_alerts 11 on"
                )
            );
            return;
        }

        const customer = customers.getCustomerByClientId(Number(id));

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    "Client ID #" + id + " tidak ditemukan."
                )
            );
            return;
        }

        if (!isCustomerAssignedToGroup(group.chat_id, customer.id)) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT ASSIGNED",
                    "#" + id + " " + customer.name +
                    " belum di-assign ke grup ini.\n\n" +
                    "Gunakan /assign_group " + id + " untuk meng-assign."
                )
            );
            return;
        }

        const flags = getAssignmentFlags(group.chat_id, customer.id);
        const canView = flags ? flags.can_view === 1 : true;

        const receiveAlerts = toggle === "on";

        setGroupAlertPreference(customer.id, group.id, receiveAlerts);

        await ctx.reply(
            renderGroupAlertToggle({
                group,
                customer,
                canView,
                receiveAlerts
            })
        );
    });

    // ========================================================
    // /assign_group <client_id>
    // ========================================================

    bot.command("assign_group", async (ctx) => {

        console.log("[CMD] /assign_group");

        const userId = String(ctx.from?.id);

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP REQUIRED",
                    "Command ini harus dijalankan di Telegram group."
                )
            );
            return;
        }

        const group = await requireRegisteredGroup(ctx);

        if (!group) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {
            await ctx.reply(
                errorMessage(
                    "Gunakan /assign_group <client_id>.",
                    "Contoh: /assign_group 11"
                )
            );
            return;
        }

        const id = parts[1];

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("client_id harus berupa angka.")
            );
            return;
        }

        const customer = customers.getCustomerByClientId(Number(id));

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    "Client ID #" + id + " tidak ditemukan."
                )
            );
            return;
        }

        if (!customer.enabled) {
            await ctx.reply(
                warningMessage(
                    "CUSTOMER DISABLED",
                    "Customer #" + id + " " + customer.name + " dinonaktifkan."
                )
            );
            return;
        }

        await ctx.reply(
            renderGroupAssignmentConfirmation(group, customer)
        );

        groupAssignSessions.set(userId, {
            type: "group_assign",
            groupId: group.id,
            chatId: group.chat_id,
            groupName: group.name,
            customerId: customer.id,
            clientId: customer.client_id,
            customerName: customer.name,
            customerIp: customer.ip
        });
    });

    // ========================================================
    // /confirm_group_assign
    // ========================================================

    bot.command("confirm_group_assign", async (ctx) => {

        console.log("[CMD] /confirm_group_assign");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from?.id);
        const session = groupAssignSessions.get(userId);

        if (!session || session.type !== "group_assign") {
            await ctx.reply(
                infoMessage("Tidak ada sesi assignment yang menunggu konfirmasi.")
            );
            return;
        }

        try {
            const result = assignCustomerToGroup(
                session.customerId,
                session.groupId
            );

            groupAssignSessions.delete(userId);

            if (result.changes === 0) {
                await ctx.reply(
                    infoMessage(
                        "ASSIGNMENT EXISTS",
                        "#" + session.clientId + " " + session.customerName +
                        " sudah terpasang pada grup ini."
                    )
                );
            } else {
                await ctx.reply(
                    successMessage(
                        "CUSTOMER ASSIGNED",
                        [
                            "Customer",
                            "#" + session.clientId + " " + session.customerName,
                            "",
                            "Telegram Group",
                            session.groupName,
                            "",
                            "Visibility",
                            "✅ ENABLED",
                            "",
                            "Alert Delivery",
                            "✅ ENABLED"
                        ]
                    )
                );
            }

        } catch (error) {

            console.error("[CMD /confirm_group_assign]", error);

            groupAssignSessions.delete(userId);

            await ctx.reply(
                errorMessage("Gagal memasang customer ke grup.")
            );
        }
    });

    // ========================================================
    // /unassign_group <client_id>
    // ========================================================

    bot.command("unassign_group", async (ctx) => {

        console.log("[CMD] /unassign_group");

        const userId = String(ctx.from?.id);

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP REQUIRED",
                    "Command ini harus dijalankan di Telegram group."
                )
            );
            return;
        }

        const group = await requireRegisteredGroup(ctx);

        if (!group) {
            return;
        }

        const parts = (ctx.message.text || "").trim().split(/\s+/);

        if (parts.length < 2) {
            await ctx.reply(
                errorMessage(
                    "Gunakan /unassign_group <client_id>.",
                    "Contoh: /unassign_group 11"
                )
            );
            return;
        }

        const id = parts[1];

        if (!/^\d+$/.test(id)) {
            await ctx.reply(
                errorMessage("client_id harus berupa angka.")
            );
            return;
        }

        const customer = customers.getCustomerByClientId(Number(id));

        if (!customer) {
            await ctx.reply(
                errorMessage(
                    "CUSTOMER NOT FOUND",
                    "Client ID #" + id + " tidak ditemukan."
                )
            );
            return;
        }

        if (!isCustomerAssignedToGroup(group.chat_id, customer.id)) {
            await ctx.reply(
                errorMessage(
                    "NOT ASSIGNED",
                    "#" + id + " " + customer.name +
                    " tidak terpasang pada grup ini."
                )
            );
            return;
        }

        await ctx.reply(
            renderGroupUnassignConfirmation(group, customer)
        );

        groupUnassignSessions.set(userId, {
            type: "group_unassign",
            groupId: group.id,
            chatId: group.chat_id,
            groupName: group.name,
            customerId: customer.id,
            clientId: customer.client_id,
            customerName: customer.name,
            customerIp: customer.ip
        });
    });

    // ========================================================
    // /confirm_group_unassign
    // ========================================================

    bot.command("confirm_group_unassign", async (ctx) => {

        console.log("[CMD] /confirm_group_unassign");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from?.id);
        const session = groupUnassignSessions.get(userId);

        if (!session || session.type !== "group_unassign") {
            await ctx.reply(
                infoMessage("Tidak ada sesi unassign yang menunggu konfirmasi.")
            );
            return;
        }

        try {
            const result = unassignCustomerFromGroup(
                session.customerId,
                session.groupId
            );

            groupUnassignSessions.delete(userId);

            await ctx.reply(
                successMessage(
                    "CUSTOMER UNASSIGNED",
                    [
                        "Customer",
                        "#" + session.clientId + " " + session.customerName,
                        "",
                        "Telegram Group",
                        session.groupName,
                        "",
                        "Global monitoring",
                        "continues unaffected"
                    ]
                )
            );

        } catch (error) {

            console.error("[CMD /confirm_group_unassign]", error);

            groupUnassignSessions.delete(userId);

            await ctx.reply(
                errorMessage("Gagal melepaskan customer dari grup.")
            );
        }
    });

    // ========================================================
    // /unregister_group
    // ========================================================

    bot.command("unregister_group", async (ctx) => {

        console.log("[CMD] /unregister_group");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from?.id);

        if (isPrivateChat(ctx)) {
            await ctx.reply(
                warningMessage(
                    "GROUP REQUIRED",
                    "Command ini harus dijalankan di Telegram group yang terdaftar."
                )
            );
            return;
        }

        const group = getRegisteredGroup(ctx);

        if (!group) {
            await ctx.reply(
                infoMessage(
                    "This group is not registered."
                )
            );
            return;
        }

        const groupCustomers = getGroupCustomers(group.id);

        await ctx.reply(
            renderGroupRemoveConfirmation(group, groupCustomers.length)
        );

        groupRemoveSessions.set(userId, {
            type: "group_remove",
            groupId: group.id,
            chatId: group.chat_id,
            groupName: group.name,
            customerCount: groupCustomers.length
        });
    });

    // ========================================================
    // /confirm_group_remove
    // ========================================================

    bot.command("confirm_group_remove", async (ctx) => {

        console.log("[CMD] /confirm_group_remove");

        if (!(await requireAdmin(ctx))) {
            return;
        }

        const userId = String(ctx.from?.id);
        const session = groupRemoveSessions.get(userId);

        if (!session || session.type !== "group_remove") {
            await ctx.reply(
                infoMessage("Tidak ada sesi penghapusan grup yang menunggu konfirmasi.")
            );
            return;
        }

        try {
            deleteGroup(session.groupId);

            groupRemoveSessions.delete(userId);

            await ctx.reply(
                successMessage(
                    "GROUP UNREGISTERED",
                    [
                        "Grup",
                        session.groupName,
                        "",
                        "Customer assignments telah dihapus.",
                        "Monitoring global tidak terpengaruh."
                    ]
                )
            );

        } catch (error) {

            console.error("[CMD /confirm_group_remove]", error);

            groupRemoveSessions.delete(userId);

            await ctx.reply(
                errorMessage("Gagal menghapus grup.")
            );
        }
    });
}

// ============================================================
// HELPERS
// ============================================================

function getVisibleGroupCustomers(groupId) {

    const { loadInventory } = require("../prtg/inventory");
    const { loadAllStates } = require("../monitoring/state-store");

    const inventory = loadInventory();
    const allStates = {};
    for (const s of loadAllStates()) {
        allStates[s.customer_id] = s;
    }

    const groupCustomers = getGroupVisibleCustomers(groupId);
    const clientIds = new Set(groupCustomers.map(c => c.client_id));

    const filtered = inventory.filter(item => clientIds.has(item.clientId));

    return {
        inventory: filtered,
        customerStates: allStates,
        groupCustomers: groupCustomers
    };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    registerGroupCommands,
    hasActiveGroupSession,
    clearGroupSession,
    groupAssignSessions,
    groupUnassignSessions,
    groupRemoveSessions
};
