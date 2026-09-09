// ============================================================
// PRTG RESPONSE PARSER
// ============================================================

// ============================================================
// EXTRACT CONTAINER
// ============================================================

function extractContainer(data) {

    if (!data || typeof data !== "object") {
        return [];
    }

    if (data[""] && typeof data[""] === "object") {
        return Object.values(data[""]);
    }

    const possibleKeys = [
        "devices,sensors",
        "devices%2Csensors",
        "sensors",
        "devices"
    ];

    for (const key of possibleKeys) {
        if (data[key]) {
            if (Array.isArray(data[key])) {
                return data[key];
            }
            if (typeof data[key] === "object") {
                return Object.values(data[key]);
            }
        }
    }

    return [];
}

// ============================================================
// NORMALIZE OBJECT
// ============================================================

function normalizeObject(raw) {

    if (!raw || typeof raw !== "object") {
        return null;
    }

    return {
        objid: raw.objid ?? null,
        parentid: raw.parentid ?? null,
        type: raw.type ?? null,
        device: raw.device ?? null,
        sensor: raw.sensor ?? null,
        host: raw.host ?? null,
        status: raw.status ?? null,
        lastvalue: raw.lastvalue ?? null,
        group: raw.group ?? null,
        probe: raw.probe ?? null,
        message: raw.message ?? null
    };
}

// ============================================================
// IS USEFUL OBJECT
// ============================================================

function isUsefulObject(obj) {

    if (!obj || typeof obj !== "object") {
        return false;
    }

    const device = String(obj.device || "").trim();
    const sensor = String(obj.sensor || "").trim();
    const host = String(obj.host || "").trim();

    return device !== "" || sensor !== "" || host !== "";
}

// ============================================================
// PARSE RESPONSE
// ============================================================

function parseResponse(data) {

    const rawObjects = extractContainer(data);

    const normalized = rawObjects
        .map(normalizeObject)
        .filter(Boolean);

    const useful = normalized.filter(isUsefulObject);

    return {
        total: rawObjects.length,
        useful: useful.length,
        objects: useful
    };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    extractContainer,
    normalizeObject,
    isUsefulObject,
    parseResponse
};