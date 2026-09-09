const customers = require("../database/customers");
const { saveMapping, getExistingMapping, deleteMapping } = require("../prtg/inventory");
const { selectPrimarySensor } = require("../prtg/mapper");
const { resetMonitoringState } = require("../monitoring/state-store");
const { searchDevices, searchSensors, fetchDeviceByObjid, fetchDeviceDetail, fetchSensorByObjid, fetchSensorsForDevice } = require("../prtg/search");
const { isPrtgScope, scopeDisplay } = require("../constants/scopes");

const {
    formatDateTime,
    formatDuration
} = require("../monitoring/classifier");

const {
    confirmationMessage,
    successMessage,
    errorMessage,
    warningMessage,
    infoMessage,
    escapeHtml
} = require("./ui");

const sessions = new Map();

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function getSession(userId) {
    return sessions.get(String(userId));
}

function setSession(userId, session) {
    sessions.set(String(userId), session);
}

function clearSession(userId) {
    sessions.delete(String(userId));
}

function hasActiveSession(userId) {
    return sessions.has(String(userId));
}

// ============================================================
// HELPERS
// ============================================================

function getNow() {
    return new Date().toISOString();
}

function formatDevicePreview(device, sensors, primarySensor) {

    const lines = [
        `ObjID: ${device.objid}`,
        "",
        `Device: ${device.device || "-"}`,
        "",
        `Host: ${device.host || "-"}`,
        "",
        `Group: ${device.group || "-"}`,
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        ""
    ];

    if (sensors.length > 0) {

        lines.push("Sensors:");
        lines.push("");

        for (const sensor of sensors) {

            const icon = sensor.isPaused ? "⏸" : "🟢";

            lines.push(`${icon} ${sensor.name || "-"}`);
            lines.push("");
            lines.push("ObjID");
            lines.push(String(sensor.objid));

            if (sensor.lastvalue) {
                lines.push("");
                lines.push("Value");
                lines.push(sensor.lastvalue);
            }

            lines.push("");
        }
    }

    if (primarySensor) {

        lines.push("━━━━━━━━━━━━━━━━━━━━");
        lines.push("");
        lines.push("Primary Sensor:");
        lines.push("");
        lines.push(`⭐ ${primarySensor.name}`);
        lines.push(`ObjID: ${primarySensor.objid}`);

    } else {

        lines.push("━━━━━━━━━━━━━━━━━━━━");
        lines.push("");
        lines.push("⚠️ Device ditemukan, tetapi tidak ada sensor aktif yang dapat dipilih sebagai primary.");
        lines.push("");
        lines.push("Customer akan disimpan sebagai mapped / paused-only dan tidak menghasilkan DOWN alert.");
    }

    return lines.join("\n");
}

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

// ============================================================
// FIND PRTG
// ============================================================

async function findPrtg(query) {

    try {

        const results = await searchDevices(query);

        if (results.length === 0) {
            return {
                query,
                total: 0,
                devices: []
            };
        }

        const devices = results.map(obj => ({
            objid: obj.objid,
            device: obj.device,
            host: obj.host,
            group: obj.group,
            status: obj.status,
            isPaused: String(obj.status || "").toLowerCase().includes("paused")
        }));

        return {
            query,
            total: devices.length,
            devices,
            truncated: results.length >= 10
        };

    } catch (error) {

        console.error(
            `[FIND] Search error: ${error.message}`
        );

        return {
            query,
            total: 0,
            devices: [],
            error: error.message
        };
    }
}

// ============================================================
// MAP CLIENT
// ============================================================

async function startMapClient(ctx, bot, next) {

    const userId = ctx.from?.id;

    const parts = (ctx.message.text || "").trim().split(/\s+/);

    if (parts.length < 3) {

        await ctx.reply(
            "⚠️ FORMAT COMMAND\n\n" +
            "Gunakan:\n" +
            "/map_client <client_id> <prtg_device_objid>\n\n" +
            "Contoh:\n" +
            "/map_client 21 14520"
        );

        return;
    }

    const clientIdInput = parts[1];
    const objidInput = parts[2];

    const clientId = Number(clientIdInput);
    const objid = Number(objidInput);

    if (!Number.isInteger(clientId) || clientId < 1) {
        await ctx.reply("❌ client_id harus berupa angka.");
        return;
    }

    if (!Number.isInteger(objid) || objid < 1) {
        await ctx.reply("❌ PRTG device ObjID harus berupa angka.");
        return;
    }

    const customer = customers.getCustomerByClientId(clientId);

    if (!customer) {
        await ctx.reply(
            "❌ CUSTOMER NOT FOUND\n\n" +
            `Client ID #${clientId} tidak ditemukan.`
        );
        return;
    }

    if (!isPrtgScope(customer.monitoring_scope)) {
        await ctx.reply(
            "⚠️ Customer berada di scope non-PRTG.\n\n" +
            "Ubah scope ke PRTG terlebih dahulu.\n\n" +
            `/set_scope ${customer.client_id} prtg`
        );
        return;
    }

    // --------------------------------------------------------
    // Check existing mapping
    // --------------------------------------------------------

    const existing = getExistingMapping(customer.id);

    if (existing && existing.length > 0) {

        const firstDevice = existing[0];

        await ctx.reply(
            "⚠️ Customer already has mapping.\n\n" +
            `#${customer.client_id} ${customer.name}\n\n` +
            `Device: ${firstDevice.device || "-"}\n` +
            `ObjID: ${firstDevice.objid || "-"}\n` +
            `Primary: ${firstDevice.sensors.find(s => s.isPrimary)?.name || "-"}\n` +
            `Source: ${firstDevice.mappingSource === "manual" ? "Manual" : "Automatic"}\n\n` +
            "Gunakan /unmap_client dulu."
        );

        return;
    }

    // --------------------------------------------------------
    // Fetch exact device by ObjID
    // --------------------------------------------------------

    const device = await fetchDeviceByObjid(objid);

    if (!device) {
        await ctx.reply(
            "❌ PRTG device ObjID tidak valid."
        );
        return;
    }

    // --------------------------------------------------------
    // Fetch sensors for the device
    // --------------------------------------------------------

    const sensorObjects = await fetchSensorsForDevice(objid);
    const sensors = sensorObjects.map(s => ({ ...s }));

    // --------------------------------------------------------
    // Select primary sensor
    // --------------------------------------------------------

    const primarySensor = selectPrimarySensor(
        sensors.map(s => ({
            ...s,
            sensor: s.name
        }))
    );

    const selectedPrimary = primarySensor
        ? {
            objid: primarySensor.objid,
            name: primarySensor.name,
            lastvalue: primarySensor.lastvalue
        }
        : null;

    // --------------------------------------------------------
    // Store session
    // --------------------------------------------------------

    setSession(userId, {
        type: "map",
        customerId: customer.id,
        clientId: customer.client_id,
        customerName: customer.name,
        customerIp: customer.ip,
        customerLocation: customer.location,
        serviceId: customer.service_id,
        description: customer.description,
        deviceObjid: objid,
        deviceName: device.device,
        deviceHost: device.host,
        deviceGroup: device.group,
        deviceProbe: device.probe,
        sensors,
        primarySensor: selectedPrimary
    });

    // --------------------------------------------------------
    // Show preview
    // --------------------------------------------------------

    const identity = [
        `#${customer.client_id} ${customer.name}`,
        `🌐 ${customer.ip}`
    ];

    const now = formatDateTime(new Date().toISOString());

    const bodyLines = [
        "🗺 PRTG DEVICE",
        "",
        `Device: ${device.device || "-"}`,
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
        "━━━━━━━━━━━━━━━━━━━━",
        ""
    ];

    if (sensors.length > 0) {

        bodyLines.push("Sensors");
        bodyLines.push("");

        for (const sensor of sensors) {

            const icon = sensor.isPaused ? "⏸" : "🟢";

            bodyLines.push(`${icon} ${sensor.name || "-"}`);
            bodyLines.push("");
            bodyLines.push("ObjID");
            bodyLines.push(String(sensor.objid));

            if (sensor.lastvalue) {
                bodyLines.push("");
                bodyLines.push("Value");
                bodyLines.push(sensor.lastvalue);
            }

            bodyLines.push("");
        }
    }

    bodyLines.push("━━━━━━━━━━━━━━━━━━━━");
    bodyLines.push("");

    if (selectedPrimary) {

        bodyLines.push("Primary Sensor");
        bodyLines.push(`⭐ ${selectedPrimary.name}`);
        bodyLines.push("");
        bodyLines.push("Sensor ObjID");
        bodyLines.push(String(selectedPrimary.objid));

    } else {

        bodyLines.push("⚠️ No primary sensor available.");
        bodyLines.push("");
        bodyLines.push("Customer will be saved as paused-only");
        bodyLines.push("and will NOT generate DOWN alerts.");
    }

    bodyLines.push("");
    bodyLines.push("");
    bodyLines.push("🕒 " + now);

    await ctx.reply(
        confirmationMessage(
            "CONFIRM MAPPING",
            identity,
            bodyLines,
            "/confirm_map",
            "/cancel"
        )
    );
}

// ============================================================
// CONFIRM MAP
// ============================================================

async function processConfirmMap(ctx) {

    const userId = ctx.from?.id;
    const session = getSession(userId);

    if (!session || session.type !== "map") {
        await ctx.reply(
            infoMessage("Tidak ada sesi pemetaan yang menunggu konfirmasi.")
        );
        return true;
    }

    try {

        const now = getNow();

        const mappingResult = {
            customer: {
                id: session.customerId,
                name: session.customerName,
                ip: session.customerIp,
                location: session.customerLocation,
                service_id: session.serviceId,
                description: session.description
            },
            status: "mapped",
            devices: [{
                objid: session.deviceObjid,
                device: session.deviceName,
                host: session.deviceHost,
                group: session.deviceGroup,
                probe: session.deviceProbe,
                sensors: (session.sensors || []).map(s => ({
                    objid: s.objid,
                    sensor: s.name,
                    status: s.status || null,
                    lastvalue: s.lastvalue || null,
                    sensor_type: null,
                    is_primary: s.objid === session.primarySensor?.objid ? 1 : 0,
                    enabled: s.isPaused ? 0 : 1
                }))
            }],
            primarySensor: session.primarySensor
                ? {
                    objid: session.primarySensor.objid,
                    name: session.primarySensor.name
                }
                : null
        };

        saveMapping(
            session.customerId,
            mappingResult,
            {
                mappingSource: "manual",
                mappedBy: String(userId),
                mappedAt: now
            }
        );

        resetMonitoringState(session.customerId);

        clearSession(userId);

        console.log(
            `[MAP] Customer #${session.clientId} ` +
            `${session.customerName} mapped to PRTG device ` +
            `${session.deviceObjid}`
        );

        await ctx.reply(
            successMessage(
                "MAPPING CONFIRMED",
                [
                    `#${session.clientId} ${session.customerName}`,
                    `🌐 ${session.customerIp}`,
                    "",
                    "📡 Device",
                    session.deviceName || "-",
                    "",
                    "Primary Sensor",
                    `⭐ ${session.primarySensor?.name || "none"}`,
                    "",
                    "Source",
                    "🛠 Manual"
                ]
            )
        );

    } catch (error) {

        console.error("[MAP] Failed to save mapping:", error);

        await ctx.reply(
            errorMessage(
                "Gagal menyimpan mapping manual.",
                escapeHtml(error.message)
            )
        );
    }

    return true;
}

// ============================================================
// UNMAP CLIENT
// ============================================================

async function startUnmapClient(ctx) {

    const userId = ctx.from?.id;
    const parts = (ctx.message.text || "").trim().split(/\s+/);

    if (parts.length < 2) {
        await ctx.reply(
            "⚠️ FORMAT COMMAND\n\n" +
            "Gunakan:\n" +
            "/unmap_client <client_id>\n\n" +
            "Contoh:\n" +
            "/unmap_client 21"
        );
        return;
    }

    const clientId = Number(parts[1]);

    if (!Number.isInteger(clientId) || clientId < 1) {
        await ctx.reply("❌ client_id harus berupa angka.");
        return;
    }

    const customer = customers.getCustomerByClientId(clientId);

    if (!customer) {
        await ctx.reply(
            "❌ CUSTOMER NOT FOUND\n\n" +
            `Client ID #${clientId} tidak ditemukan.`
        );
        return;
    }

    const existing = getExistingMapping(customer.id);

    if (!existing || existing.length === 0) {

        await ctx.reply(
            infoMessage(
                `Customer #${clientId} ${customer.name}`,
                "Belum memiliki mapping PRTG."
            )
        );

        return;
    }

    const firstDevice = existing[0];

    const primarySensor =
        firstDevice.sensors.find(s => s.isPrimary) ||
        firstDevice.sensors[0] ||
        null;

    setSession(userId, {
        type: "unmap",
        customerId: customer.id,
        clientId: customer.client_id,
        customerName: customer.name,
        customerIp: customer.ip,
        deviceName: firstDevice.device,
        deviceObjid: firstDevice.objid,
        primarySensor: primarySensor ? primarySensor.name : "none",
        mappingSource: firstDevice.mappingSource
    });

    const identity = [
        `#${customer.client_id} ${customer.name}`,
        `🌐 ${customer.ip}`
    ];

    const bodyLines = [
        "Current PRTG Device",
        "",
        firstDevice.device || "-",
        "",
        "Primary Sensor",
        primarySensor?.name || "none",
        "",
        "Source",
        firstDevice.mappingSource === "manual" ? "🛠 Manual" : "🤖 Automatic",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "",
        "After unmap:",
        "",
        "🧩 Customer will become UNRESOLVED",
        "until a new PRTG mapping is configured.",
        "",
        "Monitoring alerts will stop."
    ];

    await ctx.reply(
        confirmationMessage(
            "CONFIRM UNMAP",
            identity,
            bodyLines,
            "/confirm_unmap",
            "/cancel"
        )
    );
}

// ============================================================
// CONFIRM UNMAP
// ============================================================

async function processConfirmUnmap(ctx) {

    const userId = ctx.from?.id;
    const session = getSession(userId);

    if (!session || session.type !== "unmap") {
        await ctx.reply(
            infoMessage("Tidak ada sesi unmap yang menunggu konfirmasi.")
        );
        return true;
    }

    try {

        deleteMapping(session.customerId);
        resetMonitoringState(session.customerId);
        clearSession(userId);

        await ctx.reply(
            successMessage(
                "CUSTOMER UNMAPPED",
                [
                    `#${session.clientId} ${session.customerName}`,
                    `🌐 ${session.customerIp}`,
                    "",
                    "🧩 Mapping PRTG berhasil dihapus.",
                    "Monitoring state telah direset.",
                    "Customer kembali menjadi UNRESOLVED."
                ]
            )
        );

    } catch (error) {

        console.error("[UNMAP] Failed to remove mapping:", error);

        await ctx.reply(
            errorMessage(
                "Gagal menghapus mapping.",
                escapeHtml(error.message)
            )
        );
    }

    return true;
}

// ============================================================
// FIND PRTG SENSOR
// ============================================================

async function findPrtgSensor(query) {

    try {

        const result = await searchSensors(query);

        return {
            query: result.query,
            total: result.total,
            sensors: result.sensors,
            cached: result.cacheHit,
            durationMs: result.durationMs
        };

    } catch (error) {

        console.error(
            `[FIND SENSOR] Search error: ${error.message}`
        );

        return {
            query,
            total: 0,
            sensors: [],
            error: error.message
        };
    }
}

// ============================================================
// MAP SENSOR
// ============================================================

async function startMapSensor(ctx) {

    const userId = ctx.from?.id;
    const parts = (ctx.message.text || "").trim().split(/\s+/);

    if (parts.length < 3) {
        await ctx.reply(
            "⚠️ FORMAT COMMAND\n\n" +
            "/map_sensor <client_id> <sensor_objid>\n\n" +
            "Contoh:\n" +
            "/map_sensor 21 18432"
        );
        return;
    }

    const clientIdInput = parts[1];
    const sensorObjidInput = parts[2];

    const clientId = Number(clientIdInput);
    const sensorObjid = Number(sensorObjidInput);

    if (!Number.isInteger(clientId) || clientId < 1) {
        await ctx.reply("❌ client_id harus berupa angka.");
        return;
    }

    if (!Number.isInteger(sensorObjid) || sensorObjid < 1) {
        await ctx.reply("❌ Sensor ObjID harus berupa angka.");
        return;
    }

    const customer = customers.getCustomerByClientId(clientId);

    if (!customer) {
        await ctx.reply(
            "❌ CUSTOMER NOT FOUND\n\n" +
            `Client ID #${clientId} tidak ditemukan.`
        );
        return;
    }

    if (!isPrtgScope(customer.monitoring_scope)) {
        await ctx.reply(
            "⚠️ Customer berada di scope non-PRTG.\n\n" +
            "Ubah scope ke PRTG terlebih dahulu.\n\n" +
            `/set_scope ${customer.client_id} prtg`
        );
        return;
    }

    // --------------------------------------------------------
    // Check existing mapping
    // --------------------------------------------------------

    const existing = getExistingMapping(customer.id);

    if (existing && existing.length > 0) {

        const firstDevice = existing[0];
        const currentPrimary = firstDevice.sensors.find(s => s.isPrimary) ||
            firstDevice.sensors[0] || null;

        await ctx.reply(
            "⚠️ Customer already has mapping.\n\n" +
            `#${customer.client_id} ${customer.name}\n\n` +
            `Device: ${firstDevice.device || "-"}\n` +
            `Primary: ${currentPrimary?.name || "-"}\n` +
            `Mode: ${firstDevice.mappingMode === "explicit_sensor" ? "🎯 Explicit Sensor" : "🤖 Auto Primary"}\n\n` +
            "Gunakan /unmap_client dulu."
        );

        return;
    }

    // --------------------------------------------------------
    // Fetch exact sensor by ObjID
    // --------------------------------------------------------

    const sensorResult = await fetchSensorByObjid(sensorObjid);

    if (!sensorResult) {
        await ctx.reply("❌ Gagal mengambil sensor dari PRTG.");
        return;
    }

    if (sensorResult.notFound) {
        await ctx.reply("❌ PRTG sensor ObjID tidak valid.");
        return;
    }

    if (sensorResult.isDevice) {
        await ctx.reply("❌ ObjID tersebut adalah device, bukan sensor.");
        return;
    }

    // --------------------------------------------------------
    // Validate parent device exists
    // --------------------------------------------------------

    if (!sensorResult.parentDevice) {
        await ctx.reply("❌ Sensor tidak memiliki parent device yang valid.");
        return;
    }

    const device = sensorResult.parentDevice;

    // --------------------------------------------------------
    // Fetch ALL sensors for the parent device
    // --------------------------------------------------------

    const allSensors = await fetchSensorsForDevice(device.objid);

    // --------------------------------------------------------
    // Build mapping result with explicit primary sensor
    // --------------------------------------------------------

    const sensorMapping = allSensors.map(s => ({
        objid: s.objid,
        sensor: s.name,
        status: s.status || null,
        lastvalue: s.lastvalue || null,
        sensor_type: null,
        is_primary: s.objid === sensorObjid ? 1 : 0,
        enabled: 1
    }));

    const now = getNow();

    const explicitSensor = {
        objid: sensorResult.objid,
        name: sensorResult.sensor
    };

    // --------------------------------------------------------
    // Store session
    // --------------------------------------------------------

    setSession(userId, {
        type: "map_sensor",
        customerId: customer.id,
        clientId: customer.client_id,
        customerName: customer.name,
        customerIp: customer.ip,
        customerLocation: customer.location,
        serviceId: customer.service_id,
        description: customer.description,
        sensorObjid: sensorObjid,
        sensorName: sensorResult.sensor,
        sensorStatus: sensorResult.status,
        sensorLastvalue: sensorResult.lastvalue,
        deviceObjid: device.objid,
        deviceName: device.device,
        deviceHost: device.host,
        deviceGroup: device.group,
        deviceProbe: device.probe,
        allSensors: allSensors,
        primarySensor: explicitSensor,
        createdAt: now
    });

    // --------------------------------------------------------
    // Show preview
    // --------------------------------------------------------

    const identity = [
        `#${customer.client_id} ${customer.name}`,
        `🌐 ${customer.ip}`
    ];

    const timestamp = formatDateTime(new Date().toISOString());

    const bodyLines = [
        "🎯 EXPLICIT SENSOR MAPPING",
        "",
        "PRTG Device",
        "",
        device.device || "-",
        "",
        "Device ObjID",
        String(device.objid),
        "",
        "Host",
        device.host || "-",
        "",
        "Group",
        device.group || "-",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "",
        "Selected Primary Sensor",
        "",
        `⭐ ${sensorResult.sensor}`,
        "",
        "Sensor ObjID",
        String(sensorObjid),
        "",
        "Status",
        formatSensorStatusShort(sensorResult.status),
        "",
        "Last Value",
        sensorResult.lastvalue || "-"
    ];

    if (sensorResult.isPaused) {
        bodyLines.push("");
        bodyLines.push("⚠️ Sensor sedang PAUSED.");
        bodyLines.push("");
        bodyLines.push("Customer tidak akan dianggap DOWN selama sensor paused.");
    }

    bodyLines.push("");
    bodyLines.push("━━━━━━━━━━━━━━━━━━━━");
    bodyLines.push("");
    bodyLines.push("Mode");
    bodyLines.push("🎯 EXPLICIT SENSOR");
    bodyLines.push("");
    bodyLines.push("🕒 " + timestamp);

    await ctx.reply(
        confirmationMessage(
            "CONFIRM SENSOR MAPPING",
            identity,
            bodyLines,
            "/confirm_map_sensor",
            "/cancel"
        )
    );
}

// ============================================================
// CONFIRM MAP SENSOR
// ============================================================

async function processConfirmMapSensor(ctx) {

    const userId = ctx.from?.id;
    const session = getSession(userId);

    if (!session || session.type !== "map_sensor") {
        await ctx.reply(
            infoMessage("Tidak ada sesi pemetaan sensor yang menunggu konfirmasi.")
        );
        return true;
    }

    try {

        const now = getNow();

        const mappingResult = {
            customer: {
                id: session.customerId,
                name: session.customerName,
                ip: session.customerIp,
                location: session.customerLocation,
                service_id: session.serviceId,
                description: session.description
            },
            status: "mapped",
            devices: [{
                objid: session.deviceObjid,
                device: session.deviceName,
                host: session.deviceHost,
                group: session.deviceGroup,
                probe: session.deviceProbe,
                sensors: session.allSensors.map(s => ({
                    objid: s.objid,
                    sensor: s.name,
                    status: s.status || null,
                    lastvalue: s.lastvalue || null,
                    sensor_type: null,
                    is_primary: s.objid === session.sensorObjid ? 1 : 0,
                    enabled: 1
                }))
            }],
            primarySensor: session.primarySensor
        };

        saveMapping(
            session.customerId,
            mappingResult,
            {
                mappingSource: "manual",
                mappingMode: "explicit_sensor",
                mappedBy: String(userId),
                mappedAt: now
            }
        );

        resetMonitoringState(session.customerId);

        clearSession(userId);

        await ctx.reply(
            successMessage(
                "SENSOR MAPPING CONFIRMED",
                [
                    `#${session.clientId} ${session.customerName}`,
                    `🌐 ${session.customerIp}`,
                    "",
                    "📡 Device",
                    session.deviceName || "-",
                    "",
                    "Primary Sensor",
                    `⭐ ${session.sensorName}`,
                    "",
                    "Sensor ObjID",
                    String(session.sensorObjid),
                    "",
                    "Source",
                    "🛠 Manual",
                    "",
                    "Mode",
                    "🎯 Explicit Sensor"
                ]
            )
        );

    } catch (error) {

        console.error("[MAP SENSOR] Failed to save mapping:", error);

        await ctx.reply(
            errorMessage(
                "Gagal menyimpan mapping sensor.",
                escapeHtml(error.message)
            )
        );
    }

    return true;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    hasActiveSession,
    clearSession,
    startMapClient,
    processConfirmMap,
    startUnmapClient,
    processConfirmUnmap,
    startMapSensor,
    processConfirmMapSensor,
    findPrtg,
    findPrtgSensor
};
