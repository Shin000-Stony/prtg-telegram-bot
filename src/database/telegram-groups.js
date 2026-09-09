const db = require("./database");

// ============================================================
// PREPARED STATEMENTS
// ============================================================

const insertGroup = db.prepare(`
    INSERT INTO telegram_groups (chat_id, name)
    VALUES (@chat_id, @name)
`);

const getGroupByChatIdQuery = db.prepare(`
    SELECT *
    FROM telegram_groups
    WHERE chat_id = ?
`);

const getGroupByIdQuery = db.prepare(`
    SELECT *
    FROM telegram_groups
    WHERE id = ?
`);

const listGroupsQuery = db.prepare(`
    SELECT *,
        (SELECT COUNT(*) FROM customer_telegram_groups WHERE telegram_group_id = telegram_groups.id)
        AS customer_count
    FROM telegram_groups
    ORDER BY id ASC
`);

const enableGroupQuery = db.prepare(`
    UPDATE telegram_groups
    SET enabled = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const disableGroupQuery = db.prepare(`
    UPDATE telegram_groups
    SET enabled = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const deleteGroupQuery = db.prepare(`
    DELETE FROM telegram_groups
    WHERE id = ?
`);

const updateGroupNameQuery = db.prepare(`
    UPDATE telegram_groups
    SET name = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE chat_id = ?
`);

const insertAssignmentQuery = db.prepare(`
    INSERT OR IGNORE INTO customer_telegram_groups
        (customer_id, telegram_group_id, can_view, receive_alerts)
    VALUES
        (@customer_id, @telegram_group_id, @can_view, @receive_alerts)
`);

const deleteAssignmentQuery = db.prepare(`
    DELETE FROM customer_telegram_groups
    WHERE customer_id = ? AND telegram_group_id = ?
`);

const getGroupCustomersQuery = db.prepare(`
    SELECT
        ctg.id AS assignment_id,
        ctg.can_view,
        ctg.receive_alerts,
        c.id AS customer_id,
        c.client_id,
        c.name,
        c.ip,
        c.location,
        c.service_id,
        c.description,
        c.enabled,
        c.monitoring_scope,
        c.created_at,
        c.updated_at
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    JOIN customers c ON c.id = ctg.customer_id
    WHERE tg.id = ?
    ORDER BY c.client_id ASC
`);

const getGroupVisibleCustomersQuery = db.prepare(`
    SELECT
        ctg.id AS assignment_id,
        ctg.can_view,
        ctg.receive_alerts,
        c.id AS customer_id,
        c.client_id,
        c.name,
        c.ip,
        c.location,
        c.service_id,
        c.description,
        c.enabled,
        c.monitoring_scope,
        c.created_at,
        c.updated_at
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    JOIN customers c ON c.id = ctg.customer_id
    WHERE tg.id = ?
      AND ctg.can_view = 1
    ORDER BY c.client_id ASC
`);

const getCustomerGroupsQuery = db.prepare(`
    SELECT
        tg.id,
        tg.chat_id,
        tg.name,
        tg.enabled,
        ctg.can_view,
        ctg.receive_alerts
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    WHERE ctg.customer_id = ?
    ORDER BY tg.id ASC
`);

const updateAlertPreferenceQuery = db.prepare(`
    UPDATE customer_telegram_groups
    SET receive_alerts = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE customer_id = ? AND telegram_group_id = ?
`);

const canViewCustomerQuery = db.prepare(`
    SELECT 1
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    WHERE ctg.customer_id = ?
      AND tg.chat_id = ?
      AND ctg.can_view = 1
      AND tg.enabled = 1
    LIMIT 1
`);

const isCustomerAssignedToGroupQuery = db.prepare(`
    SELECT 1
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    WHERE ctg.customer_id = ?
      AND tg.chat_id = ?
    LIMIT 1
`);

const getAssignmentFlagsQuery = db.prepare(`
    SELECT ctg.can_view, ctg.receive_alerts
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    WHERE ctg.customer_id = ?
      AND tg.chat_id = ?
    LIMIT 1
`);

const getAlertRecipientsQuery = db.prepare(`
    SELECT DISTINCT
        tg.chat_id,
        tg.name
    FROM customer_telegram_groups ctg
    JOIN telegram_groups tg ON tg.id = ctg.telegram_group_id
    WHERE ctg.customer_id = ?
      AND ctg.receive_alerts = 1
      AND tg.enabled = 1
`);

// ============================================================
// GROUP CRUD
// ============================================================

function registerGroup({ chatId, name, enabled = 1 }) {
    const existing = getGroupByChatIdQuery.get(chatId);

    if (existing) {
        let updated = false;
        if (existing.name !== name) {
            updateGroupNameQuery.run(name, chatId);
            updated = true;
        }

        return {
            groupId: existing.id,
            chatId: existing.chat_id,
            name: updated ? name : existing.name,
            enabled: existing.enabled,
            isNew: false
        };
    }

    const result = insertGroup.run({
        chat_id: chatId,
        name: name
    });

    return {
        groupId: result.lastInsertRowid,
        chatId: chatId,
        name: name,
        enabled: 1,
        isNew: true
    };
}

function getGroupByChatId(chatId) {
    return getGroupByChatIdQuery.get(chatId);
}

function getGroupById(id) {
    return getGroupByIdQuery.get(id);
}

function listGroups() {
    return listGroupsQuery.all();
}

function enableGroup(id) {
    return enableGroupQuery.run(id);
}

function disableGroup(id) {
    return disableGroupQuery.run(id);
}

function deleteGroup(id) {
    return deleteGroupQuery.run(id);
}

// ============================================================
// CUSTOMER ASSIGNMENT
// ============================================================

function assignCustomerToGroup(customerId, groupId, options = {}) {
    const {
        canView = 1,
        receiveAlerts = 1
    } = options;

    return insertAssignmentQuery.run({
        customer_id: customerId,
        telegram_group_id: groupId,
        can_view: canView,
        receive_alerts: receiveAlerts
    });
}

function unassignCustomerFromGroup(customerId, groupId) {
    return deleteAssignmentQuery.run(customerId, groupId);
}

function getGroupCustomers(groupId) {
    return getGroupCustomersQuery.all(groupId);
}

function getGroupVisibleCustomers(groupId) {
    return getGroupVisibleCustomersQuery.all(groupId);
}

function getCustomerGroups(customerId) {
    return getCustomerGroupsQuery.all(customerId);
}

function setGroupAlertPreference(customerId, groupId, receiveAlerts) {
    return updateAlertPreferenceQuery.run(
        receiveAlerts ? 1 : 0,
        customerId,
        groupId
    );
}

function canGroupViewCustomer(groupChatId, customerId) {
    return Boolean(canViewCustomerQuery.get(customerId, groupChatId));
}

function isCustomerAssignedToGroup(groupChatId, customerId) {
    return Boolean(isCustomerAssignedToGroupQuery.get(customerId, groupChatId));
}

function getAssignmentFlags(groupChatId, customerId) {
    return getAssignmentFlagsQuery.get(customerId, groupChatId);
}

function getAlertRecipientsForCustomer(customerId) {
    return getAlertRecipientsQuery.all(customerId);
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    registerGroup,
    getGroupByChatId,
    getGroupById,
    listGroups,
    enableGroup,
    disableGroup,
    deleteGroup,
    assignCustomerToGroup,
    unassignCustomerFromGroup,
    getGroupCustomers,
    getGroupVisibleCustomers,
    getCustomerGroups,
    setGroupAlertPreference,
    canGroupViewCustomer,
    isCustomerAssignedToGroup,
    getAssignmentFlags,
    getAlertRecipientsForCustomer
};
