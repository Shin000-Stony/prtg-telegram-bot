const client = require("./client");
const { parseResponse } = require("./parser");
const { isPaused } = require("./mapper");

const MAX_RESULTS = 10;
const MAX_DEEP_RESULTS = 20;
const CACHE_TTL_MS = 120000;

let deviceCache = null;
let cacheExpiry = 0;

function normalizeQuery(raw) {
    return String(raw || "").trim();
}

function isNumeric(value) {
    return /^\d{3,15}$/.test(String(value || "").trim());
}

async function searchDevices(query) {

    const q = normalizeQuery(query);

    if (q.length < 3) {
        throw new Error("Query minimal 3 karakter.");
    }

    let results = [];

    // --------------------------------------------------------
    // Strategy 1: Exact ObjID if numeric
    // --------------------------------------------------------

    if (isNumeric(q)) {

        try {

            const data = await client.getTable({
                start: 0,
                count: MAX_RESULTS,
                filters: {
                    filter_objid: q
                }
            });

            const parsed = parseResponse(data);

            const deviceObjs = parsed.objects.filter(obj => {
                const sensorName = String(obj.sensor || "").trim();
                return sensorName === "";
            });

            if (deviceObjs.length > 0) {
                results = deviceObjs;
            }

        } catch (error) {

            console.error(
                `[SEARCH] ObjID lookup failed: ${error.message}`
            );
        }

        if (results.length > 0) {
            return results.slice(0, MAX_RESULTS);
        }
    }

    // --------------------------------------------------------
    // Strategy 2: Exact host
    // --------------------------------------------------------

    try {

        const data = await client.getTable({
            start: 0,
            count: MAX_RESULTS,
            filters: {
                filter_host: q
            }
        });

        const parsed = parseResponse(data);

        const deviceObjs = parsed.objects.filter(obj => {
            const sensorName = String(obj.sensor || "").trim();
            return sensorName === "";
        });

        results = [...deviceObjs];

    } catch (error) {

        console.error(
            `[SEARCH] Host lookup failed: ${error.message}`
        );
    }

    // --------------------------------------------------------
    // Strategy 3: Device name contains query
    // --------------------------------------------------------

    if (results.length < MAX_RESULTS) {

        try {

            const data = await client.getTable({
                start: 0,
                count: MAX_RESULTS,
                filters: {
                    filter_device: q
                }
            });

            const parsed = parseResponse(data);

            const deviceObjs = parsed.objects.filter(obj => {
                const sensorName = String(obj.sensor || "").trim();
                return sensorName === "";
            });

            for (const d of deviceObjs) {

                const exists = results.some(r => r.objid === d.objid);

                if (!exists) {
                    results.push(d);
                }
            }

        } catch (error) {

            console.error(
                `[SEARCH] Device name search failed: ${error.message}`
            );
        }
    }

    // --------------------------------------------------------
    // Strategy 4: Group contains query
    // --------------------------------------------------------

    if (results.length < MAX_RESULTS) {

        try {

            const data = await client.getTable({
                start: 0,
                count: MAX_RESULTS,
                filters: {
                    filter_group: q
                }
            });

            const parsed = parseResponse(data);

            const deviceObjs = parsed.objects.filter(obj => {
                const sensorName = String(obj.sensor || "").trim();
                return sensorName === "";
            });

            for (const d of deviceObjs) {

                const exists = results.some(r => r.objid === d.objid);

                if (!exists) {
                    results.push(d);
                }
            }

        } catch (error) {

            console.error(
                `[SEARCH] Group search failed: ${error.message}`
            );
        }
    }

    // --------------------------------------------------------
    // Strategy 5: Broad fallback (device or host contains query)
    // --------------------------------------------------------

    if (results.length < MAX_RESULTS) {

        try {

            const data = await client.getTable({
                start: 0,
                count: 500,
                filters: {}
            });

            const parsed = parseResponse(data);

            const queryLower = q.toLowerCase();

            const deviceObjs = parsed.objects.filter(obj => {

                const sensorName = String(obj.sensor || "").trim();

                if (sensorName !== "") {
                    return false;
                }

                const deviceText = String(obj.device || "").toLowerCase();
                const hostText = String(obj.host || "").toLowerCase();

                return deviceText.includes(queryLower) || hostText.includes(queryLower);
            });

            for (const d of deviceObjs) {

                const exists = results.some(r => r.objid === d.objid);

                if (!exists) {
                    results.push(d);
                }
            }

        } catch (error) {

            console.error(
                `[SEARCH] Fallback search failed: ${error.message}`
            );
        }
    }

    return results.slice(0, MAX_RESULTS);
}

// ============================================================
// FETCH SINGLE DEVICE BY OBJID
// ============================================================

async function fetchDeviceByObjid(objid) {

    const numericObjid = Number(objid);

    if (!Number.isInteger(numericObjid) || numericObjid < 1) {
        return null;
    }

    try {

        const data = await client.getTable({
            start: 0,
            count: 1,
            filters: {
                filter_objid: String(numericObjid)
            }
        });

        const parsed = parseResponse(data);

        if (parsed.objects.length === 0) {
            return null;
        }

        const obj = parsed.objects[0];

        const deviceName = String(obj.device || "").trim();

        if (!deviceName) {
            return null;
        }

        return {
            objid: obj.objid,
            device: obj.device,
            host: obj.host,
            group: obj.group,
            probe: obj.probe,
            status: obj.status,
            isPaused: isPaused(obj)
        };

    } catch (error) {

        console.error(
            `[SEARCH] fetchDeviceByObjid failed: ${error.message}`
        );

        return null;
    }
}

// ============================================================
// FETCH SENSORS FOR DEVICE
// ============================================================

async function fetchSensorsForDevice(objid) {

    const numericObjid = Number(objid);

    if (!Number.isInteger(numericObjid) || numericObjid < 1) {
        return [];
    }

    try {

        const data = await client.getSensors({
            start: 0,
            count: 500,
            filters: {
                filter_parentid: String(numericObjid)
            }
        });

        const parsed = parseResponse(data);

        return parsed.objects.map(obj => ({
            objid: obj.objid,
            name: obj.sensor,
            status: obj.status,
            lastvalue: obj.lastvalue,
            isPaused: isPaused(obj)
        }));

    } catch (error) {

        console.error(
            `[SEARCH] fetchSensorsForDevice failed: ${error.message}`
        );

        return [];
    }
}

// ============================================================
// DEVICE INVENTORY CACHE
// ============================================================

function getCachedDevices() {

    const now = Date.now();

    if (deviceCache && now < cacheExpiry) {
        return deviceCache;
    }

    return null;
}

function setCachedDevices(devices) {

    deviceCache = devices;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
}

function isCacheValid() {

    return !!(deviceCache && Date.now() < cacheExpiry);
}

// ============================================================
// FETCH DEVICE INVENTORY (cached)
// ============================================================

async function fetchDeviceInventory() {

    const cached = getCachedDevices();

    if (cached) {

        console.log(
            `[SEARCH] Cache hit: ${cached.length} devices`
        );

        return cached;
    }

    console.log(
        "[SEARCH] Cache miss: fetching device inventory..."
    );

    const fetchStart = Date.now();

    let allObjects = [];

    try {

        let start = 0;
        const batchSize = 500;

        while (true) {

            const data = await client.getTable({
                start,
                count: batchSize,
                filters: {}
            });

            const parsed = parseResponse(data);

            if (parsed.objects.length === 0) {
                break;
            }

            allObjects = allObjects.concat(parsed.objects);

            if (parsed.objects.length < batchSize) {
                break;
            }

            start += batchSize;
        }

    } catch (error) {

        console.error(
            `[SEARCH] Inventory fetch failed: ${error.message}`
        );

        throw error;
    }

    const devices = allObjects.filter(obj => {

        const sensorName = String(obj.sensor || "").trim();
        return sensorName === "";
    });

    setCachedDevices(devices);

    const duration = Date.now() - fetchStart;

    console.log(
        `[SEARCH] Inventory fetched: ${allObjects.length} objects, ` +
        `${devices.length} devices, ${duration}ms`
    );

    return devices;
}

// ============================================================
// TOKENIZE QUERY
// ============================================================

function tokenizeQuery(query) {

    return String(query || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(token => token.length > 0);
}

// ============================================================
// SCORE CANDIDATE
// ============================================================

function scoreCandidate(device, query) {

    const q = String(query || "").trim().toLowerCase();

    if (!q) {
        return 0;
    }

    const deviceText = String(device.device || "").toLowerCase();
    const hostText = String(device.host || "").toLowerCase();
    const groupText = String(device.group || "").toLowerCase();
    const probeText = String(device.probe || "").toLowerCase();
    const messageText = String(device.message || "").toLowerCase();

    let score = 0;

    // --------------------------------------------------------
    // Numeric query: exact Service ID or ObjID text
    // --------------------------------------------------------

    if (/^\d+$/.test(q)) {

        if (deviceText === q) score += 100;
        if (hostText === q) score += 100;

        if (deviceText.includes(q)) score += 80;
        if (hostText.includes(q)) score += 70;
        if (groupText.includes(q)) score += 50;
        if (messageText.includes(q)) score += 40;

        return score;
    }

    // --------------------------------------------------------
    // Text query: exact matches
    // --------------------------------------------------------

    if (deviceText === q) score += 100;
    if (hostText === q) score += 100;

    // --------------------------------------------------------
    // Service ID text embedded
    // --------------------------------------------------------

    if (/^\d{7,15}$/.test(q)) {

        if (deviceText.includes(q)) score += 100;
        if (hostText.includes(q)) score += 100;
        if (groupText.includes(q)) score += 100;
        if (messageText.includes(q)) score += 100;
    }

    // --------------------------------------------------------
    // Contains matches
    // --------------------------------------------------------

    if (deviceText.includes(q)) score += 60;
    if (hostText.includes(q)) score += 50;
    if (groupText.includes(q)) score += 30;
    if (probeText.includes(q)) score += 20;

    // --------------------------------------------------------
    // Token-based matching
    // --------------------------------------------------------

    if (!/^\d+$/.test(q)) {

        const tokens = tokenizeQuery(q);

        if (tokens.length > 0) {

            let allFound = true;
            let tokenScore = 0;

            for (const token of tokens) {

                const inDevice = deviceText.includes(token);
                const inHost = hostText.includes(token);
                const inGroup = groupText.includes(token);

                if (inDevice || inHost || inGroup) {
                    tokenScore += 10;
                }

                if (!inDevice && !inHost && !inGroup) {
                    allFound = false;
                }
            }

            if (allFound && tokens.length > 0) {
                score += 40;
            }

            score += tokenScore;
        }
    }

    return score;
}

// ============================================================
// DEEP SEARCH
// ============================================================

async function searchDevicesDeep(query) {

    const q = normalizeQuery(query);

    if (q.length < 3) {
        throw new Error("Query minimal 3 karakter.");
    }

    console.log(
        `[SEARCH] Deep search query="${q}"`
    );

    const searchStart = Date.now();

    const devices = await fetchDeviceInventory();

    console.log(
        `[SEARCH] Device inventory=${devices.length}`
    );

    const scored = devices.map(device => ({
        device,
        score: scoreCandidate(device, q)
    }));

    const candidates = scored
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_DEEP_RESULTS)
        .map(item => ({
            ...item.device,
            score: item.score,
            isPaused: isPaused(item.device)
        }));

    const duration = Date.now() - searchStart;

    console.log(
        `[SEARCH] Candidates=${candidates.length} Duration=${duration}ms`
    );

    return {
        query: q,
        total: candidates.length,
        devices: candidates,
        durationMs: duration,
        cacheHit: isCacheValid()
    };
}

// ============================================================
// FETCH DEVICE DETAIL (with sensors)
// ============================================================

async function fetchDeviceDetail(objid) {

    const numericObjid = Number(objid);

    if (!Number.isInteger(numericObjid) || numericObjid < 1) {
        return null;
    }

    try {

        const data = await client.getTable({
            start: 0,
            count: 1,
            filters: {
                filter_objid: String(numericObjid)
            }
        });

        const parsed = parseResponse(data);

        if (parsed.objects.length === 0) {
            return null;
        }

        const obj = parsed.objects[0];

        const deviceName = String(obj.device || "").trim();
        const sensorName = String(obj.sensor || "").trim();

        if (sensorName && !deviceName) {

            return { isSensor: true };
        }

        const device = await fetchDeviceByObjid(numericObjid);

        if (!device) {

            return { isSensor: sensorName ? true : false };
        }

        const sensors = await fetchSensorsForDevice(numericObjid);

        const primarySensor = selectPrimarySensorForDetail(
            sensors.map(s => ({
                ...s,
                sensor: s.name,
                lastvalue: s.lastvalue
            }))
        );

        return {
            ...device,
            sensors,
            primarySensorName: primarySensor?.name || null,
            sensorCount: sensors.length
        };

    } catch (error) {

        console.error(
            `[SEARCH] fetchDeviceDetail failed: ${error.message}`
        );

        return null;
    }
}

// ============================================================
// SELECT PRIMARY SENSOR FOR DETAIL VIEW
// ============================================================

function selectPrimarySensorForDetail(sensors) {

    const eligible = sensors.filter(s => !s.isPaused);

    if (eligible.length === 0) {
        return null;
    }

    const { classifySensor, isPaused } = require("./mapper");

    const SENSOR_PRIORITY = [
        "ping", "wan", "link", "uptime", "other"
    ];

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
// SENSOR INVENTORY CACHE
// ============================================================

let sensorCache = null;
let sensorCacheExpiry = 0;

const SENSOR_CACHE_TTL_MS = 120000;

function getCachedSensors() {

    const now = Date.now();

    if (sensorCache && now < sensorCacheExpiry) {
        return sensorCache;
    }

    return null;
}

function setCachedSensors(sensors) {

    sensorCache = sensors;
    sensorCacheExpiry = Date.now() + SENSOR_CACHE_TTL_MS;
}

// ============================================================
// SCORE SENSOR
// ============================================================

function scoreSensor(sensor, query) {

    const q = String(query || "").trim().toLowerCase();

    if (!q) {
        return 0;
    }

    const sensorText = String(sensor.sensor || "").toLowerCase();
    const deviceText = String(sensor.device || "").toLowerCase();
    const hostText = String(sensor.host || "").toLowerCase();
    const groupText = String(sensor.group || "").toLowerCase();
    const probeText = String(sensor.probe || "").toLowerCase();
    const messageText = String(sensor.message || "").toLowerCase();

    let score = 0;

    if (/^\d+$/.test(q)) {

        if (sensorText === q) score += 100;
        if (deviceText === q) score += 100;
        if (hostText === q) score += 100;

        if (sensorText.includes(q)) score += 80;
        if (deviceText.includes(q)) score += 60;
        if (hostText.includes(q)) score += 70;
        if (groupText.includes(q)) score += 50;
        if (messageText.includes(q)) score += 40;

        return score;
    }

    if (sensorText === q) score += 100;
    if (sensorText.includes(q)) score += 70;

    if (deviceText.includes(q)) score += 50;
    if (hostText === q) score += 60;
    if (hostText.includes(q)) score += 30;

    if (groupText.includes(q)) score += 30;
    if (probeText.includes(q)) score += 20;
    if (messageText.includes(q)) score += 20;

    const tokens = tokenizeQuery(q);

    if (tokens.length > 0) {

        let allFound = true;
        let tokenScore = 0;

        for (const token of tokens) {

            const inSensor = sensorText.includes(token);
            const inDevice = deviceText.includes(token);
            const inHost = hostText.includes(token);

            if (inSensor || inDevice || inHost) {
                tokenScore += 10;
            }

            if (!inSensor && !inDevice && !inHost) {
                allFound = false;
            }
        }

        if (allFound) {
            score += 40;
        }

        score += tokenScore;
    }

    return score;
}

// ============================================================
// DEEP SENSOR SEARCH
// ============================================================

async function searchSensors(query) {

    const q = normalizeQuery(query);

    if (q.length < 3) {
        throw new Error("Query minimal 3 karakter.");
    }

    console.log(
        `[SENSOR SEARCH] Deep search query="${q}"`
    );

    const searchStart = Date.now();

    let sensorObjects = getCachedSensors();
    let cacheHit = true;

    if (!sensorObjects) {

        cacheHit = false;

        try {

            const data = await client.getTable({
                start: 0,
                count: 500
            });

            const parsed = parseResponse(data);

            sensorObjects = parsed.objects;

            setCachedSensors(sensorObjects);

        } catch (error) {

            console.error(
                `[SENSOR SEARCH] Inventory fetch failed: ${error.message}`
            );

            throw error;
        }
    }

    console.log(
        `[SENSOR SEARCH] inventory=${sensorObjects.length} cache=${cacheHit ? "HIT" : "MISS"}`
    );

    const candidates = sensorObjects
        .filter(obj => {
            const sensorName = String(obj.sensor || "").trim();
            return sensorName !== "";
        })
        .map(obj => ({
            ...obj,
            score: scoreSensor(obj, q)
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_DEEP_RESULTS);

    const duration = Date.now() - searchStart;

    console.log(
        `[SENSOR SEARCH] matches=${candidates.length} duration=${duration}ms`
    );

    return {
        query: q,
        total: candidates.length,
        sensors: candidates,
        durationMs: duration,
        cacheHit
    };
}

// ============================================================
// FETCH SENSOR BY OBJID (with parent device)
// ============================================================

async function fetchSensorByObjid(sensorObjid) {

    const numericObjid = Number(sensorObjid);

    if (!Number.isInteger(numericObjid) || numericObjid < 1) {
        return null;
    }

    try {

        const data = await client.getTable({
            start: 0,
            count: 1,
            filters: {
                filter_objid: String(numericObjid)
            }
        });

        const parsed = parseResponse(data);

        if (parsed.objects.length === 0) {

            return { notFound: true };
        }

        const obj = parsed.objects[0];

        const sensorName = String(obj.sensor || "").trim();
        const deviceName = String(obj.device || "").trim();

        if (!sensorName) {

            return { isDevice: true };
        }

        const parentObjid = obj.parentid;

        let parentDevice = null;

        if (parentObjid) {

            const parentData = await client.getTable({
                start: 0,
                count: 1,
                filters: {
                    filter_objid: String(parentObjid)
                }
            });

            const parentParsed = parseResponse(parentData);

            if (parentParsed.objects.length > 0) {

                const parentObj = parentParsed.objects[0];

                parentDevice = {
                    objid: parentObj.objid,
                    device: parentObj.device,
                    host: parentObj.host,
                    group: parentObj.group,
                    probe: parentObj.probe,
                    status: parentObj.status,
                    isPaused: isPaused(parentObj)
                };
            }
        }

        return {
            objid: obj.objid,
            sensor: obj.sensor,
            status: obj.status,
            lastvalue: obj.lastvalue,
            message: obj.message,
            parentObjid: parentObjid,
            parentDevice,
            isPaused: isPaused(obj)
        };

    } catch (error) {

        console.error(
            `[SENSOR SEARCH] fetchSensorByObjid failed: ${error.message}`
        );

        return null;
    }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    searchDevices,
    searchDevicesDeep,
    searchSensors,
    fetchDeviceByObjid,
    fetchDeviceDetail,
    fetchSensorByObjid,
    fetchSensorsForDevice,
    MAX_RESULTS,
    MAX_DEEP_RESULTS
};
