const { execFile } = require("child_process");
const { SCOPES } = require("../constants/scopes");
const client = require("../prtg/client");
const { extractContainer } = require("../prtg/parser");
const { getDeviceByObjid } = require("../prtg/search");

// ============================================================
// UTILITIES
// ============================================================

function isValidIPv4(ip) {

    if (!ip || typeof ip !== "string") {
        return false;
    }

    const parts = ip.split(".");

    if (parts.length !== 4) {
        return false;
    }

    return parts.every(part => {
        const num = Number(part);
        return Number.isInteger(num) && num >= 0 && num <= 255 && !part.startsWith("0") || part === "0";
    });
}

function resolveMonitoringBackend(customer, configDirectPing) {

    if (!configDirectPing || !configDirectPing.enabled) {
        return "prtg";
    }

    const scope = customer.monitoring_scope;

    if (scope === SCOPES.NOT_IN_PRTG && isValidIPv4(customer.ip_address)) {
        return "icmp_ping";
    }

    return "prtg";
}

// ============================================================
// PERFORM PING
// ============================================================

function performPing(host, options) {

    return new Promise((resolve) => {

        const count = Math.max(1, options.count || 3);
        const timeoutMs = Math.max(1, options.timeoutSeconds || 3) * 1000;

        const args = [
            "-c",
            String(count),
            "-W",
            String(options.timeoutSeconds || 3),
            host
        ];

        const startTime = Date.now();

        const proc = execFile("ping", args, { timeout: timeoutMs + 1000 }, (error, stdout, stderr) => {

            if (error) {

                const packetLoss = 100;
                let latency = null;

                const lossMatch = stdout && stdout.match(/(\d+)% packet loss/);
                if (lossMatch) {
                    const parsed = Number(lossMatch[1]);
                    if (!isNaN(parsed)) {
                        packetLoss = parsed;
                    }
                }

                if (stdout) {
                    const lines = stdout.split("\n");
                    for (const line of lines) {
                        if (line.includes("rtt min/avg/max/mdev = ")) {
                            const parts = line.split("=");
                            if (parts.length >= 2) {
                                const values = parts[1].trim().split("/");
                                if (values.length >= 2) {
                                    latency = Number(values[1]);
                                }
                            }
                        }
                    }
                }

                resolve({
                    host,
                    reachable: false,
                    packetLoss,
                    avgLatency: latency,
                    error: error.message,
                    lastOutput: stdout || stderr || ""
                });

                return;
            }

            const duration = Date.now() - startTime;

            const lossMatch = stdout && stdout.match(/(\d+)% packet loss/);
            const packetLoss = lossMatch ? Number(lossMatch[1]) : 0;

            let avgLatency = null;
            const lines = stdout.split("\n");
            for (const line of lines) {
                if (line.includes("rtt min/avg/max/mdev = ")) {
                    const parts = line.split("=");
                    if (parts.length >= 2) {
                        const values = parts[1].trim().split("/");
                        if (values.length >= 2) {
                            avgLatency = Number(values[1]);
                        }
                    }
                }
            }
            if (avgLatency === null && duration > 0 && packetLoss < 100) {
                avgLatency = Math.round(duration / count);
            }

            resolve({
                host,
                reachable: packetLoss === 0,
                packetLoss,
                avgLatency,
                error: null,
                lastOutput: stdout || ""
            });
        });

        proc.on("error", (err) => {

            resolve({
                host,
                reachable: false,
                packetLoss: 100,
                avgLatency: null,
                error: err.message || "spawn error",
                lastOutput: ""
            });
        });
    });
}

// ============================================================
// PING SINGLE CUSTOMER
// ============================================================

async function pingCustomer(customer, configDirectPing) {

    if (!isValidIPv4(customer.ip)) {
        return {
            reachable: false,
            packetLoss: 100,
            avgLatency: null,
            error: "invalid_ip",
            backend: "icmp_ping"
        };
    }

    const options = {
        count: configDirectPing.count || 3,
        timeoutSeconds: configDirectPing.timeoutSeconds || 3
    };

    const result = await performPing(customer.ip, options);

    return {
        ...result,
        backend: "icmp_ping",
        customerId: customer.customer_id,
        name: customer.customer_name
    };
}

// ============================================================
// PING MULTIPLE TARGETS WITH CONCURRENCY
// ============================================================

function pingTargets(targets, options) {

    const concurrency = Math.max(1, options.concurrency || 5);
    const results = new Array(targets.length);

    return new Promise((resolve, reject) => {

        let idx = 0;
        let active = 0;
        let errors = 0;

        function next() {

            if (idx >= targets.length) {

                if (active === 0) {
                    resolve(results);
                }

                return;
            }

            const i = idx;
            idx++;
            active++;

            const target = targets[i];

            pingCustomer(target, options)
                .then(result => {

                    results[i] = result;
                    active--;
                    next();
                })
                .catch(error => {

                    results[i] = {
                        host: target.ip_address,
                        reachable: false,
                        packetLoss: 100,
                        avgLatency: null,
                        error: error.message,
                        backend: "icmp_ping"
                    };
                    errors++;
                    active--;
                    next();
                });
        }

        const initial = Math.min(concurrency, targets.length);
        for (let j = 0; j < initial; j++) {
            next();
        }
    });
}

// ============================================================
// DISCOVER PRTG FOR CUSTOMER (not_in_prtg scope)
// ============================================================

async function discoverPrtgForCustomer(customer, configPrtg) {

    const customerName = customer.customer_name || customer.name || "";
    const customerIp = customer.ip_address || customer.ip || "";

    if (!configPrtg || !configPrtg.url) {
        return null;
    }

    try {

        const devicesData = await client.getDevices({
            start: 0,
            count: 500
        });

        const devices = extractContainer(devicesData);

        if (!devices.length) {
            return null;
        }

        const matched = devices.find(device => {

            const deviceName = String(device.name || "").toLowerCase();
            const deviceIp = String(device.ip || "").toLowerCase();

            return (
                deviceName.includes(customerName.toLowerCase()) ||
                deviceIp === customerIp.toLowerCase()
            );
        });

        if (!matched) {
            return null;
        }

        const deviceDetail = await client.getDevice(matched.objid);
        const detail = extractContainer(deviceDetail);

        return {
            found: true,
            objid: matched.objid,
            deviceName: matched.name,
            ip: matched.ip,
            detail: detail
        };

    } catch (error) {

        console.error(
            `[DISCOVERY] Failed to discover PRTG for ${customerName}:`,
            error.message
        );

        return null;
    }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    isValidIPv4,
    resolveMonitoringBackend,
    performPing,
    pingCustomer,
    pingTargets,
    discoverPrtgForCustomer
};
