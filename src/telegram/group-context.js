const {
    getGroupByChatId,
    getGroupVisibleCustomers,
    canGroupViewCustomer
} = require("../database/telegram-groups");

const {
    requireAdmin
} = require("./auth");

// ============================================================
// CONTEXT DETECTION
// ============================================================

function isPrivateChat(ctx) {
    const chatType = ctx.chat?.type || ctx.message?.chat?.type;
    return chatType === "private";
}

function isGroupChat(ctx) {
    const chatType = ctx.chat?.type || ctx.message?.chat?.type;
    return chatType === "group" || chatType === "supergroup";
}

function getChatId(ctx) {
    return ctx.chat?.id || ctx.message?.chat?.id;
}

// ============================================================
// GROUP REGISTRATION LOOKUP
// ============================================================

function getRegisteredGroup(ctx) {
    if (!isGroupChat(ctx)) {
        return null;
    }

    const chatId = getChatId(ctx);
    return getGroupByChatId(chatId);
}

// ============================================================
// GROUP ACCESS GUARD
// ============================================================

async function requireRegisteredGroup(ctx) {
    if (!isGroupChat(ctx)) {
        return null;
    }

    const group = getRegisteredGroup(ctx);

    if (!group) {
        await ctx.reply(
            "⛔ GROUP NOT REGISTERED\n\n" +
            "This group does not have access to monitoring data.\n\n" +
            "Contact an administrator or run /register_group."
        );
        return null;
    }

    if (!group.enabled) {
        await ctx.reply(
            "⛔ GROUP DISABLED\n\n" +
            "Monitoring access for this group is temporarily disabled."
        );
        return null;
    }

    return group;
}

// ============================================================
// CUSTOMER VISIBILITY SCOPE
// ============================================================

function getVisibleCustomersForContext(ctx, allCustomers) {
    if (isPrivateChat(ctx)) {
        return {
            customers: allCustomers,
            group: null,
            visibility: "global"
        };
    }

    if (!isGroupChat(ctx)) {
        return {
            customers: [],
            group: null,
            visibility: "none"
        };
    }

    const group = getRegisteredGroup(ctx);

    if (!group || !group.enabled) {
        return {
            customers: [],
            group: null,
            visibility: "none"
        };
    }

    const groupCustomers = getGroupVisibleCustomers(group.id);
    const clientIds = new Set(
        groupCustomers.map(c => c.client_id)
    );

    const filtered = allCustomers.filter(c =>
        clientIds.has(c.client_id)
    );

    return {
        customers: filtered,
        group,
        visibility: "group"
    };
}

// ============================================================
// DETAIL ACCESS CHECK
// ============================================================

async function canViewCustomerInContext(ctx, customer) {
    if (isPrivateChat(ctx)) {
        return true;
    }

    if (!isGroupChat(ctx)) {
        return false;
    }

    const group = getRegisteredGroup(ctx);

    if (!group || !group.enabled) {
        return false;
    }

    return canGroupViewCustomer(group.chat_id, customer.id);
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    isPrivateChat,
    isGroupChat,
    getChatId,
    getRegisteredGroup,
    requireRegisteredGroup,
    getVisibleCustomersForContext,
    canViewCustomerInContext
};
