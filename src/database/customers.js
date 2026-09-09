const db = require("./database");

// ============================================================
// QUERIES
// ============================================================

const insertCustomer = db.prepare(`
    INSERT INTO customers (
        client_id,
        name,
        ip,
        location,
        service_id,
        description,
        monitoring_scope
    )
    VALUES (
        @client_id,
        @name,
        @ip,
        @location,
        @service_id,
        @description,
        COALESCE(@monitoring_scope, 'prtg')
    )
`);

const getAllCustomers = db.prepare(`
    SELECT
        id,
        client_id,
        name,
        ip,
        location,
        service_id,
        description,
        enabled,
        monitoring_scope,
        monitoring_note,
        scope_updated_by,
        scope_updated_at,
        created_at,
        updated_at
    FROM customers
    ORDER BY client_id ASC
`);

const getEnabledCustomers = db.prepare(`
    SELECT
        id,
        client_id,
        name,
        ip,
        location,
        service_id,
        description,
        enabled,
        monitoring_scope,
        monitoring_note,
        scope_updated_by,
        scope_updated_at,
        created_at,
        updated_at
    FROM customers
    WHERE enabled = 1
    ORDER BY client_id ASC
`);

const getCustomerByIdQuery = db.prepare(`
    SELECT *
    FROM customers
    WHERE id = ?
`);

const getCustomerByClientIdQuery = db.prepare(`
    SELECT *
    FROM customers
    WHERE client_id = ?
`);

const getMaxClientIdQuery = db.prepare(`
    SELECT COALESCE(MAX(client_id), 0) AS max_client_id
    FROM customers
`);

const getCustomerByServiceIdQuery = db.prepare(`
    SELECT *
    FROM customers
    WHERE service_id = ?
    LIMIT 1
`);

const getCustomerByIPQuery = db.prepare(`
    SELECT *
    FROM customers
    WHERE ip = ?
    LIMIT 1
`);

const disableCustomerQuery = db.prepare(`
    UPDATE customers
    SET
        enabled = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const enableCustomerQuery = db.prepare(`
    UPDATE customers
    SET
        enabled = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const deleteCustomerQuery = db.prepare(`
    DELETE FROM customers
    WHERE id = ?
`);

const updateCustomerClientId = db.prepare(`
    UPDATE customers
    SET
        client_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const updateScopeQuery = db.prepare(`
    UPDATE customers
    SET
        monitoring_scope = ?,
        monitoring_note = ?,
        scope_updated_by = ?,
        scope_updated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

const updateScopeNoNoteQuery = db.prepare(`
    UPDATE customers
    SET
        monitoring_scope = ?,
        scope_updated_by = ?,
        scope_updated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
`);

// ============================================================
// CREATE
// ============================================================

function getNextClientId() {
    const result = getMaxClientIdQuery.get();

    return Number(result.max_client_id) + 1;
}

function addCustomer(customer) {
    const clientId = getNextClientId();

    const result = insertCustomer.run({
        client_id: clientId,
        name: customer.name,
        ip: customer.ip,
        location: customer.location,
        service_id: customer.service_id || null,
        description: customer.description,
        monitoring_scope: customer.monitoring_scope || "prtg"
    });

    return getCustomerById(result.lastInsertRowid);
}

// ============================================================
// READ
// ============================================================

function getCustomers() {
    return getAllCustomers.all();
}

function getEnabled() {
    return getEnabledCustomers.all();
}

function getCustomerById(id) {
    const value = Number(id);

    if (!Number.isInteger(value) || value < 1) {
        return undefined;
    }

    return getCustomerByIdQuery.get(value);
}

function getCustomerByClientId(clientId) {
    const value = Number(clientId);

    if (!Number.isInteger(value) || value < 1) {
        return undefined;
    }

    return getCustomerByClientIdQuery.get(value);
}

function getCustomerByServiceId(serviceId) {
    if (!serviceId) {
        return undefined;
    }

    return getCustomerByServiceIdQuery.get(serviceId);
}

function getCustomerByIP(ip) {
    if (!ip) {
        return undefined;
    }

    return getCustomerByIPQuery.get(ip);
}

// ============================================================
// DUPLICATE CHECK
// ============================================================

function existsByIP(ip) {
    return Boolean(getCustomerByIP(ip));
}

function existsByServiceId(serviceId) {
    if (!serviceId) {
        return false;
    }

    return Boolean(
        getCustomerByServiceId(serviceId)
    );
}

// ============================================================
// UPDATE
// ============================================================

function disable(id) {
    return disableCustomerQuery.run(id);
}

function enable(id) {
    return enableCustomerQuery.run(id);
}

// ============================================================
// DELETE
// ============================================================

function remove(id) {
    return deleteCustomerQuery.run(id);
}

// ============================================================
// REINDEX CLIENT IDS
// ============================================================

function reindexClientIds() {

    const all = getAllCustomers.all();

    const reindex = db.transaction(() => {

        for (let i = 0; i < all.length; i++) {

            updateCustomerClientId.run(
                i + 1,
                all[i].id
            );
        }
    });

    reindex();
}

function updateScope(customerId, scope, options = {}) {

    const {
        note = null,
        updatedBy = null
    } = options;

    if (note) {
        return updateScopeQuery.run(
            scope,
            note,
            updatedBy,
            customerId
        );
    }

    return updateScopeNoNoteQuery.run(
        scope,
        updatedBy,
        customerId
    );
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    addCustomer,

    getCustomers,
    getEnabled,

    getCustomerById,
    getCustomerByClientId,
    getCustomerByServiceId,
    getCustomerByIP,

    existsByIP,
    existsByServiceId,

    disable,
    enable,
    remove,
    updateScope,
    reindexClientIds
};