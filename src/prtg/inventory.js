const db = require("../database/database");

// ============================================================
// SENSOR STATUS HELPERS
// ============================================================

function isSensorPaused(status) {
    if (!status) {
        return false;
    }

    return String(status).trim().toLowerCase().startsWith("paused");
}

// ============================================================
// QUERIES
// ============================================================

const insertDevice = db.prepare(`
    INSERT INTO customer_prtg_devices (
        customer_id,
        prtg_objid,
        device,
        host,
        group_name,
        probe,
        status,
        mapping_status,
        mapping_source,
        mapping_mode,
        mapped_by,
        mapped_at,
        is_primary,
        last_verified_at
    )
    VALUES (
        @customer_id,
        @prtg_objid,
        @device,
        @host,
        @group_name,
        @probe,
        @status,
        @mapping_status,
        @mapping_source,
        @mapping_mode,
        @mapped_by,
        @mapped_at,
        @is_primary,
        @last_verified_at
    )
`);

const insertSensor = db.prepare(`
    INSERT INTO customer_prtg_sensors (
        device_mapping_id,
        prtg_objid,
        sensor,
        status,
        lastvalue,
        sensor_type,
        is_primary,
        enabled,
        last_verified_at
    )
    VALUES (
        @device_mapping_id,
        @prtg_objid,
        @sensor,
        @status,
        @lastvalue,
        @sensor_type,
        @is_primary,
        @enabled,
        @last_verified_at
    )
`);

const getDevicesByCustomer = db.prepare(`
    SELECT * FROM customer_prtg_devices
    WHERE customer_id = ?
    ORDER BY id ASC
`);

const getSensorsByDevice = db.prepare(`
    SELECT * FROM customer_prtg_sensors
    WHERE device_mapping_id = ?
    ORDER BY id ASC
`);

const deleteDevicesByCustomer = db.prepare(`
    DELETE FROM customer_prtg_devices
    WHERE customer_id = ?
`);

const deleteSensorsByDevice = db.prepare(`
    DELETE FROM customer_prtg_sensors
    WHERE device_mapping_id = ?
`);

// ============================================================
// HELPERS
// ============================================================

function getNow() {
    return new Date().toISOString();
}

// ============================================================
// SAVE MAPPING
// ============================================================

function saveMapping(customerId, mappingResult, options = {}) {

    const {
        mappingSource = "auto",
        mappingMode = "auto_primary",
        mappedBy = null,
        mappedAt = null
    } = options;

    const now = getNow();

    const deleteTransaction = db.transaction(() => {

        const existingDevices = getDevicesByCustomer.all(customerId);

        for (const device of existingDevices) {
            deleteSensorsByDevice.run(device.id);
        }

        deleteDevicesByCustomer.run(customerId);
    });

    deleteTransaction();

    if (mappingResult.status === "unmapped") {

        const insertUnmapped = db.transaction(() => {

            insertDevice.run({
                customer_id: customerId,
                prtg_objid: null,
                device: null,
                host: null,
                group_name: null,
                probe: null,
                status: null,
                mapping_status: "unmapped",
                mapping_source: mappingSource,
                mapping_mode: mappingMode,
                mapped_by: mappedBy,
                mapped_at: mappedAt,
                is_primary: 0,
                last_verified_at: now
            });
        });

        insertUnmapped();

        return;
    }

    if (mappingResult.status === "ambiguous") {

        const insertAmbiguous = db.transaction(() => {

            insertDevice.run({
                customer_id: customerId,
                prtg_objid: null,
                device: null,
                host: null,
                group_name: null,
                probe: null,
                status: null,
                mapping_status: "ambiguous",
                mapping_source: mappingSource,
                mapping_mode: mappingMode,
                mapped_by: mappedBy,
                mapped_at: mappedAt,
                is_primary: 0,
                last_verified_at: now
            });
        });

        insertAmbiguous();

        return;
    }

    const insertMapping = db.transaction(() => {

        for (const device of mappingResult.devices) {

            const deviceResult = insertDevice.run({
                customer_id: customerId,
                prtg_objid: device.objid,
                device: device.device,
                host: device.host,
                group_name: device.group,
                probe: device.probe,
                status: null,
                mapping_status: mappingResult.status,
                mapping_source: mappingSource,
                mapping_mode: mappingMode,
                mapped_by: mappedBy,
                mapped_at: mappedAt,
                is_primary: device === mappingResult.devices[0] ? 1 : 0,
                last_verified_at: now
            });

            const deviceMappingId = deviceResult.lastInsertRowid;

            for (const sensor of device.sensors) {

                const isPrimary =
                    mappingResult.primarySensor &&
                    mappingResult.primarySensor.objid === sensor.objid;

                insertSensor.run({
                    device_mapping_id: deviceMappingId,
                    prtg_objid: sensor.objid,
                    sensor: sensor.sensor,
                    status: sensor.status,
                    lastvalue: sensor.lastvalue,
                    sensor_type: sensor.sensor_type,
                    is_primary: isPrimary ? 1 : 0,
                    enabled: 1,
                    last_verified_at: now
                });
            }
        }
    });

    insertMapping();
}

// ============================================================
// GET EXISTING MAPPING
// ============================================================

function getExistingMapping(customerId) {

    const deviceRows = db.prepare(`
        SELECT * FROM customer_prtg_devices
        WHERE customer_id = ?
        ORDER BY id ASC
    `).all(customerId);

    if (deviceRows.length === 0) {
        return null;
    }

    const devices = [];

    for (const deviceRow of deviceRows) {

        const sensorRows = db.prepare(`
            SELECT * FROM customer_prtg_sensors
            WHERE device_mapping_id = ?
            ORDER BY id ASC
        `).all(deviceRow.id);

        devices.push({
            id: deviceRow.id,
            objid: deviceRow.prtg_objid,
            device: deviceRow.device,
            host: deviceRow.host,
            group: deviceRow.group_name,
            probe: deviceRow.probe,
            status: deviceRow.status,
            mappingStatus: deviceRow.mapping_status,
            mappingSource: deviceRow.mapping_source,
            mappingMode: deviceRow.mapping_mode,
            mappedBy: deviceRow.mapped_by,
            mappedAt: deviceRow.mapped_at,
            isPrimary: Boolean(deviceRow.is_primary),
            sensors: sensorRows.map(s => ({
                id: s.id,
                objid: s.prtg_objid,
                name: s.sensor,
                status: s.status,
                lastvalue: s.lastvalue,
                isPrimary: Boolean(s.is_primary)
            }))
        });
    }

    return devices;
}

// ============================================================
// DELETE MAPPING
// ============================================================

function deleteMapping(customerId) {

    const deleteTxn = db.transaction(() => {

        const deviceRows = db.prepare(`
            SELECT id FROM customer_prtg_devices
            WHERE customer_id = ?
        `).all(customerId);

        for (const row of deviceRows) {
            db.prepare(`
                DELETE FROM customer_prtg_sensors
                WHERE device_mapping_id = ?
            `).run(row.id);
        }

        db.prepare(`
            DELETE FROM customer_prtg_devices
            WHERE customer_id = ?
        `).run(customerId);
    });

    const result = deleteTxn();

    console.log(
        `[MAPPING] Deleted mapping for customer ${customerId}`
    );

    return result;
}

// ============================================================
// LOAD INVENTORY
// ============================================================

function loadInventory() {

    const rows = db.prepare(`
        SELECT
            c.id AS customer_id,
            c.client_id,
            c.name,
            c.ip,
            c.location,
            c.service_id,
            c.description,
            c.enabled,
            c.monitoring_scope,
            c.monitoring_note,
            c.scope_updated_by,
            c.scope_updated_at,

            d.id AS device_id,
            d.prtg_objid AS device_objid,
            d.device,
            d.host,
            d.group_name,
            d.probe,
            d.status AS device_status,
            d.mapping_status,
            d.mapping_source,
            d.mapping_mode,
            d.mapped_by,
            d.mapped_at,
            d.is_primary AS device_is_primary,
            d.last_verified_at AS device_verified_at

        FROM customers c
        LEFT JOIN customer_prtg_devices d
            ON c.id = d.customer_id
        ORDER BY c.client_id ASC, d.id ASC
    `).all();

    const deviceMappingIds = rows
        .filter(r => r.device_id)
        .map(r => r.device_id);

    const sensorsByDevice = {};

    if (deviceMappingIds.length > 0) {

        const placeholders = deviceMappingIds.map(() => "?").join(",");

        const sensors = db.prepare(`
            SELECT * FROM customer_prtg_sensors
            WHERE device_mapping_id IN (${placeholders})
            ORDER BY device_mapping_id ASC, id ASC
        `).all(...deviceMappingIds);

        for (const sensor of sensors) {

            if (!sensorsByDevice[sensor.device_mapping_id]) {
                sensorsByDevice[sensor.device_mapping_id] = [];
            }

            sensorsByDevice[sensor.device_mapping_id].push(sensor);
        }
    }

    const customers = {};

    for (const row of rows) {

        if (!customers[row.customer_id]) {
            customers[row.customer_id] = {
                id: row.customer_id,
                clientId: row.client_id,
                name: row.name,
                ip: row.ip,
                location: row.location,
                serviceId: row.service_id,
                description: row.description,
                enabled: Boolean(row.enabled),
                monitoringScope: row.monitoring_scope || "prtg",
                monitoringNote: row.monitoring_note || null,
                scopeUpdatedBy: row.scope_updated_by || null,
                scopeUpdatedAt: row.scope_updated_at || null,
                devices: []
            };
        }

        if (!row.device_id) {
            continue;
        }

        const deviceSensors = sensorsByDevice[row.device_id] || [];

        customers[row.customer_id].devices.push({
            objid: row.device_objid,
            device: row.device,
            host: row.host,
            group: row.group_name,
            probe: row.probe,
            status: row.device_status,
            mappingStatus: row.mapping_status,
            mappingSource: row.mapping_source,
            mappingMode: row.mapping_mode,
            mappedBy: row.mapped_by,
            mappedAt: row.mapped_at,
            sensors: deviceSensors.map(s => ({
                objid: s.prtg_objid,
                name: s.sensor,
                status: s.status,
                lastvalue: s.lastvalue,
                sensorType: s.sensor_type,
                isPrimary: Boolean(s.is_primary)
            }))
        });
    }

    const inventory = [];

    for (const id of Object.keys(customers)) {

        const customer = customers[id];

    let mappingStatus = "unmapped";
    let primarySensor = null;
    let mappingSource = "auto";
    let mappingMode = "auto_primary";
    let mappedBy = null;
        let mappedAt = null;

        if (customer.devices.length > 0) {

            const firstDevice = customer.devices[0];

            if (firstDevice.mappingStatus === "unmapped" || firstDevice.mappingStatus === "ambiguous") {
                mappingStatus = firstDevice.mappingStatus;
            } else {
                mappingStatus = "mapped";

                mappingSource = firstDevice.mappingSource || "auto";
                mappingMode = firstDevice.mappingMode || "auto_primary";
                mappedBy = firstDevice.mappedBy || null;
                mappedAt = firstDevice.mappedAt || null;

                for (const device of customer.devices) {
                    for (const sensor of device.sensors) {
                        if (sensor.isPrimary) {
                            primarySensor = { objid: sensor.objid, name: sensor.name };
                            break;
                        }
                    }
                    if (primarySensor) break;
                }
            }
        }

    let sensorCount = 0;
    let activeSensorCount = 0;
    let pausedSensorCount = 0;

    for (const device of customer.devices) {
        for (const sensor of device.sensors) {
            sensorCount++;
            if (isSensorPaused(sensor.status)) {
                pausedSensorCount++;
            } else {
                activeSensorCount++;
            }
        }
    }

    let prtgObjid = null;
    if (mappingStatus === "mapped" && customer.devices.length > 0) {
        const firstMapped = customer.devices.find(d => d.mappingStatus === "mapped");
        prtgObjid = firstMapped ? firstMapped.objid : null;
    }

        inventory.push({
            customerId: customer.id,
            clientId: customer.clientId,
            name: customer.name,
            ip: customer.ip,
            location: customer.location,
            serviceId: customer.serviceId,
            description: customer.description,
            enabled: customer.enabled,
            monitoringScope: customer.monitoringScope,
            monitoringNote: customer.monitoringNote,
            mappingStatus,
            mappingSource,
            mappingMode,
            mappedBy,
            mappedAt,
            prtgObjid,
            sensorCount,
            activeSensorCount,
            pausedSensorCount,
            devices: customer.devices.filter(d => d.mappingStatus !== "unmapped" && d.mappingStatus !== "ambiguous"),
            primarySensor,
            lastVerifiedAt: customer.devices[0]?.device_verified_at
        });
    }

    return inventory;
}

// ============================================================
// GET INVENTORY SUMMARY
// ============================================================

function getInventorySummary() {

    const inventory = loadInventory();

    const summary = {
        total: inventory.length,
        mapped: 0,
        unmapped: 0,
        ambiguous: 0
    };

    for (const item of inventory) {

        if (item.mappingStatus === "mapped") {
            summary.mapped++;
        } else if (item.mappingStatus === "unmapped") {
            summary.unmapped++;
        } else if (item.mappingStatus === "ambiguous") {
            summary.ambiguous++;
        }
    }

    return {
        summary,
        inventory
    };
}

function getMonitoringScopeSummary() {

    const inventory = loadInventory();

    const scopeCounts = {
        total: inventory.length,
        prtg: 0,
        notInPrtg: 0,
        picManaged: 0
    };

    for (const item of inventory) {

        const scope = item.monitoringScope;

        if (scope === "not_in_prtg") {
            scopeCounts.notInPrtg++;
        } else if (scope === "pic_managed") {
            scopeCounts.picManaged++;
        } else {
            scopeCounts.prtg++;
        }
    }

    const prtgItems = inventory.filter(
        i => i.monitoringScope === "prtg"
    );

    const mappingStats = {
        mapped: 0,
        pausedOnly: 0,
        unresolved: 0
    };

    for (const item of prtgItems) {

        if (item.mappingStatus === "mapped" && item.primarySensor) {
            mappingStats.mapped++;
        } else if (item.mappingStatus === "mapped" && !item.primarySensor) {
            mappingStats.pausedOnly++;
        } else {
            mappingStats.unresolved++;
        }
    }

    return {
        scopeCounts,
        mappingStats,
        inventory
    };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    isSensorPaused,
    saveMapping,
    getExistingMapping,
    deleteMapping,
    loadInventory,
    getInventorySummary,
    getMonitoringScopeSummary
};