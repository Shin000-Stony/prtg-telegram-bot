const axios = require("axios");
const https = require("https");

const config = require("../config/env");

// ============================================================
// HTTP CLIENT
// ============================================================

const api = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    }),
    timeout: 60000,
    validateStatus: () => true
});

// ============================================================
// HELPERS
// ============================================================

function buildUrl(path) {
    return `${config.prtg.url}${path}`;
}

function buildQuery(params) {
    return {
        username: config.prtg.username,
        passhash: config.prtg.passhash,
        output: "json",
        ...params
    };
}

// ============================================================
// REQUEST
// ============================================================

async function request(path, params = {}) {

    const url = buildUrl(path);
    const query = buildQuery(params);

    const response = await api.get(url, {
        params: query
    });

    if (response.status !== 200) {
        throw new Error(
            `PRTG HTTP ${response.status}`
        );
    }

    return response.data;
}

// ============================================================
// PUBLIC API
// ============================================================

async function getApiInfo() {

    return request("/api/table.json", {
        content: "devices,sensors",
        columns: "objid,device,sensor,status,lastvalue,host,group,probe,message",
        start: 0,
        count: 1
    });
}

async function getSensors(options = {}) {

    const {
        start = 0,
        count = 500,
        columns = "objid,device,sensor,status,lastvalue,host,group,probe,message",
        filters = {}
    } = options;

    const params = {
        content: "sensors",
        columns,
        start,
        count,
        ...filters
    };

    return request("/api/table.json", params);
}

async function getDevices(options = {}) {

    const {
        start = 0,
        count = 500,
        columns = "objid,device,sensor,status,lastvalue,host,group,probe,message",
        filters = {}
    } = options;

    const params = {
        content: "devices",
        columns,
        start,
        count,
        ...filters
    };

    return request("/api/table.json", params);
}

async function getTable(options = {}) {

    const {
        start = 0,
        count = 500,
        columns = "objid,device,sensor,status,lastvalue,host,group,probe,message",
        filters = {}
    } = options;

    const params = {
        content: "devices,sensors",
        columns,
        start,
        count,
        ...filters
    };

    return request("/api/table.json", params);
}

module.exports = {
    getApiInfo,
    getSensors,
    getDevices,
    getTable
};