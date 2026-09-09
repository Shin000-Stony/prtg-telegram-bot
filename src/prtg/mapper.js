const client = require("./client");
const { parseResponse } = require("./parser");

// ============================================================
// SENSOR TYPE CLASSIFICATION
// ============================================================

function classifySensor(sensorName) {

    const name = String(sensorName || "").toUpperCase();

    if (name.includes("PING")) {
        return "ping";
    }

    if (
        name.includes("WAN") ||
        name.includes("INTERNET") ||
        name.includes("UPLINK") ||
        name.includes("LINK")
    ) {
        return "wan";
    }

    if (
        name.includes("TRAFFIC") ||
        name.includes("INTERFACE") ||
        name.includes("ETHER") ||
        name.includes("PORT")
    ) {
        return "link";
    }

    if (
        name.includes("UPTIME") ||
        name.includes("UPTIME")
    ) {
        return "uptime";
    }

    return "other";
}

const SENSOR_PRIORITY = [
    "ping",
    "wan",
    "link",
    "uptime",
    "other"
];

// ============================================================
// IS PAUSED
// ============================================================

function isPaused(obj) {

    const status = String(obj.status || "").toLowerCase();

    return (
        status.includes("paused") ||
        status === "paused (paused)" ||
        status === "paused (paused by parent)"
    );
}

// ============================================================
// SELECT PRIMARY SENSOR
// ============================================================

function selectPrimarySensor(sensors) {

    const eligible = sensors.filter(sensor =>
        !isPaused(sensor)
    );

    if (eligible.length === 0) {
        return null;
    }

    let best = null;
    let bestPriority = Infinity;

    for (const sensor of eligible) {

        const type = classifySensor(sensor.sensor);
        const priority = SENSOR_PRIORITY.indexOf(type);

        if (priority < bestPriority) {
            bestPriority = priority;
            best = sensor;
        }
    }

    return best || eligible[0];
}

// ============================================================
// GROUP BY DEVICE
// ============================================================

function groupByDevice(objects) {

    const groups = {};

    for (const obj of objects) {

        const device = String(obj.device || "").trim();

        if (!device) {
            continue;
        }

        if (!groups[device]) {
            groups[device] = {
                device,
                objid: obj.objid,
                host: obj.host,
                group: obj.group,
                probe: obj.probe,
                sensors: []
            };
        }

        const sensorName = String(obj.sensor || "").trim();

        if (sensorName) {
            groups[device].sensors.push({
                objid: obj.objid,
                sensor: sensorName,
                status: obj.status,
                lastvalue: obj.lastvalue,
                sensor_type: classifySensor(sensorName)
            });
        }
    }

    return Object.values(groups);
}

// ============================================================
// SEARCH TARGET
// ============================================================

function searchTarget(customer, objects) {

    const serviceId = String(
        customer.service_id || ""
    ).trim();

    const ip = String(customer.ip || "").trim();
    const name = String(customer.name || "").trim().toUpperCase();

    const result = {
        customer,
        serviceIdMatches: [],
        ipMatches: [],
        nameMatches: []
    };

    for (const obj of objects) {

        const text = [
            obj.device,
            obj.sensor,
            obj.host
        ]
            .filter(Boolean)
            .join(" ")
            .toUpperCase();

        if (serviceId && serviceId !== "-" && text.includes(serviceId)) {
            result.serviceIdMatches.push(obj);
        }

        if (ip && text.includes(ip)) {
            result.ipMatches.push(obj);
        }

        const tokens = name
            .split(" ")
            .filter(token => token.length >= 4);

        const matchedTokens = tokens.filter(token =>
            text.includes(token)
        );

        if (
            tokens.length > 0 &&
            matchedTokens.length >= Math.min(2, tokens.length)
        ) {
            result.nameMatches.push({
                object: obj,
                matchedTokens
            });
        }
    }

    return result;
}

// ============================================================
// FETCH OBJECTS FOR CUSTOMER
// ============================================================

async function fetchObjectsForCustomer(customer) {

    const serviceId = String(
        customer.service_id || ""
    ).trim();

    const ip = String(customer.ip || "").trim();

    let deviceObj = null;
    let objects = [];

    // --------------------------------------------------------
    // STRATEGY 1: Find device by IP
    // --------------------------------------------------------

    if (ip) {

        try {

            const data = await client.getTable({
                start: 0,
                count: 10,
                filters: {
                    filter_host: ip
                }
            });

            const parsed = parseResponse(data);

            if (parsed.objects.length > 0) {
                deviceObj = parsed.objects.find(obj =>
                    String(obj.device || "").trim() !== ""
                ) || parsed.objects[0];
            }

        } catch (error) {

            console.error(
                `[MAPPER] Gagal fetch device untuk IP ${ip}:`,
                error.message
            );
        }
    }

    // --------------------------------------------------------
    // STRATEGY 2: Find device by exact device name (if service ID is known)
    // --------------------------------------------------------

    if (!deviceObj && serviceId && serviceId !== "-") {

        try {

            const data = await client.getTable({
                start: 0,
                count: 10,
                filters: {
                    filter_device: `${serviceId}-`
                }
            });

            const parsed = parseResponse(data);

            if (parsed.objects.length > 0) {
                deviceObj = parsed.objects.find(obj =>
                    String(obj.device || "").trim() !== ""
                ) || parsed.objects[0];
            }

        } catch (error) {

            console.error(
                `[MAPPER] Gagal fetch device untuk Service ID ${serviceId}:`,
                error.message
            );
        }
    }

    // --------------------------------------------------------
    // STRATEGY 3: Get sensors/children of the device
    // --------------------------------------------------------

    if (deviceObj && deviceObj.objid) {

        try {

            const data = await client.getSensors({
                start: 0,
                count: 500,
                filters: {
                    filter_parentid: String(deviceObj.objid)
                }
            });

            const parsed = parseResponse(data);
            objects = parsed.objects;

        } catch (error) {

            console.error(
                `[MAPPER] Gagal fetch children untuk objid ${deviceObj.objid}:`,
                error.message
            );
        }
    }

    // --------------------------------------------------------
    // FALLBACK: Local search in limited batch
    // --------------------------------------------------------

    if (objects.length === 0) {

        try {

            const data = await client.getTable({
                start: 0,
                count: 500
            });

            const parsed = parseResponse(data);

            objects = parsed.objects.filter(obj => {
                const text = [
                    obj.device,
                    obj.sensor,
                    obj.host
                ].join(" ").toUpperCase();
                return (
                    text.includes(ip) ||
                    (serviceId && serviceId !== "-" && text.includes(serviceId)) ||
                    text.includes(customer.name.toUpperCase())
                );
            });

        } catch (error) {

            console.error(
                `[MAPPER] Gagal fallback search untuk ${customer.name}:`,
                error.message
            );
        }
    }

    return objects;
}

// ============================================================
// MAP CUSTOMER
// ============================================================

async function mapCustomer(customer) {

    const objects = await fetchObjectsForCustomer(customer);

    if (objects.length === 0) {
        return {
            customer,
            status: "unmapped",
            devices: [],
            primarySensor: null
        };
    }

    const search = searchTarget(customer, objects);

    let status = "unmapped";
    let matchedObjects = [];

    if (search.serviceIdMatches.length > 0) {
        status = "mapped";
        matchedObjects = search.serviceIdMatches;
    } else if (search.ipMatches.length > 0) {
        status = "mapped";
        matchedObjects = search.ipMatches;
    } else if (search.nameMatches.length > 0) {
        status = "ambiguous";
        matchedObjects = search.nameMatches.map(m => m.object);
    }

    const devices = groupByDevice(matchedObjects);

    let primarySensor = null;

    for (const device of devices) {
        primarySensor = selectPrimarySensor(device.sensors);
        if (primarySensor) {
            break;
        }
    }

    return {
        customer,
        status,
        devices,
        primarySensor
    };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    classifySensor,
    isPaused,
    selectPrimarySensor,
    groupByDevice,
    searchTarget,
    fetchObjectsForCustomer,
    mapCustomer
};