const config = require("../config/env");
const { getInventorySummary } = require("../prtg/inventory");
const { evaluateCustomerState } = require("./evaluator");
const { evaluateTransition } = require("./transition");
const { saveState, saveTransitionResult, loadState } = require("./state-store");
const { notifyDown, notifyRecovery } = require("./notifier");
const { recordCycle, getHeartbeatData } = require("./heartbeat");
const client = require("../prtg/client");
const { extractContainer } = require("../prtg/parser");
const { isValidIPv4, pingCustomer, pingTargets } = require("./direct-ping");

// ============================================================
// MONITORING ENGINE
// ============================================================

let monitoringRunning = false;
let monitoringIntervalId = null;

// ============================================================
// QUERY PRIMARY SENSOR STATUS
// ============================================================

async function queryPrimarySensorStatus(primarySensor) {

    try {

        const data = await client.getSensors({
            start: 0,
            count: 1,
            filters: {
                filter_objid: String(primarySensor.objid)
            }
        });

        const objects = extractContainer(data);

        if (objects.length === 0) {
            return null;
        }

        const obj = objects[0];

        return {
            objid: obj.objid,
            name: obj.sensor,
            status: obj.status,
            lastvalue: obj.lastvalue
        };
    } catch (error) {

        console.error(
            `[MONITOR] Gagal query sensor ${primarySensor.objid}:`,
            error.message
        );

        return null;
    }
}

// ============================================================
// SEND ALERT IF NEEDED
// ============================================================

async function sendAlertIfNeeded(bot, event, target, sensorOrResult) {

    if (!config.monitoring.alertsEnabled) {
        console.log(`[ALERT] ${event} event detected; Alerts disabled; Telegram notification skipped.`);
        return;
    }

    try {

        if (event === "DOWN") {

            await notifyDown(
                bot,
                {
                    name: target.name,
                    location: target.location,
                    description: target.description,
                    ip: target.ip,
                    client_id: target.clientId
                },
                target.customerId,
                sensorOrResult.name || "Direct Ping",
                sensorOrResult.lastvalue || sensorOrResult.error || "timeout",
                sensorOrResult.backend || "prtg"
            );

        } else if (event === "RECOVERY") {

            await notifyRecovery(
                bot,
                {
                    name: target.name,
                    location: target.location,
                    description: target.description,
                    ip: target.ip,
                    client_id: target.clientId
                },
                target.customerId,
                sensorOrResult.name || "Direct Ping",
                sensorOrResult.lastvalue || sensorOrResult.error || "timeout",
                sensorOrResult.backend || "prtg"
            );
        }

    } catch (error) {

        console.error("[NOTIFIER] Gagal kirim alert:", error.message);
    }
}

// ============================================================
// PROCESS PRTG TARGET
// ============================================================

async function processPrtgTarget(bot, target) {

    const debug = String(process.env.DEBUG_MONITORING || "false").toLowerCase() === "true";

    if (!debug) {
        process.stdout.write(`[MONITOR] #${target.clientId} ${target.name}... `);
    }

    try {

        const currentSensor = await queryPrimarySensorStatus(target.primarySensor);

        if (!currentSensor) {
            if (!debug) {
                console.log("API ERROR");
            }

            saveState(target.customerId, "UNKNOWN", target.primarySensor, { backend: "prtg" });
            return "unknown";
        }

        const normalizedState = evaluateCustomerState(currentSensor);

        const existing = loadState(target.customerId);

        let transitionResult = null;

        if (existing) {

            transitionResult = evaluateTransition({
                currentState: normalizedState,
                lastOperationalState: existing.last_operational_state,
                pendingState: existing.pending_state,
                pendingCount: existing.pending_count,
                downConfirmCount: config.monitoring.downConfirmCount,
                recoveryConfirmCount: config.monitoring.recoveryConfirmCount
            });

            saveTransitionResult(target.customerId, transitionResult, transitionResult.event, {
                backend: "prtg"
            });
        } else {

            saveState(target.customerId, normalizedState, currentSensor, { backend: "prtg" });
        }

        if (transitionResult && transitionResult.event) {

            await sendAlertIfNeeded(bot, transitionResult.event, target, {
                ...currentSensor,
                backend: "prtg"
            });
        }

        if (!debug) {
            const prev = existing ? existing.current_state : "NULL";
            const pending = transitionResult && transitionResult.pendingState
                ? ` (pending ${transitionResult.pendingState} ${transitionResult.pendingCount}/${normalizedState === "DOWN" ? config.monitoring.downConfirmCount : config.monitoring.recoveryConfirmCount})`
                : "";
            console.log(`${currentSensor.status} -> ${normalizedState} (prev: ${prev}${pending})`);
        }

        return normalizedState.toLowerCase();

    } catch (error) {

        if (!debug) {
            console.log("ERROR:", error.message);
        }

        saveState(target.customerId, "UNKNOWN", target.primarySensor, { backend: "prtg" });
        return "unknown";
    }
}

// ============================================================
// PROCESS DIRECT PING TARGET
// ============================================================

function processPingTarget(bot, target, result) {

    const debug = String(process.env.DEBUG_MONITORING || "false").toLowerCase() === "true";

    if (!debug) {
        process.stdout.write(`[MONITOR] #${target.clientId} ${target.name} (${target.ip})... `);
    }

    const existing = loadState(target.customerId);
    const prevState = existing ? existing.current_state : "NULL";

    if (result.reachable) {

        const normalizedState = "UP";

        const transitionResult = evaluateTransition({
            currentState: normalizedState,
            lastOperationalState: existing ? existing.last_operational_state : null,
            pendingState: existing ? existing.pending_state : null,
            pendingCount: existing ? existing.pending_count : 0,
            downConfirmCount: config.monitoring.downConfirmCount,
            recoveryConfirmCount: config.monitoring.recoveryConfirmCount
        });

        saveTransitionResult(target.customerId, transitionResult, transitionResult.event, {
            backend: "icmp_ping",
            latencyMs: result.avgLatency,
            packetLoss: 0
        });

        if (transitionResult && transitionResult.event) {
            void sendAlertIfNeeded(bot, transitionResult.event, target, {
                name: "ICMP Ping",
                backend: "icmp_ping",
                latencyMs: result.avgLatency,
                packetLoss: 0
            });
        }

        if (!debug) {
            console.log(`UP (prev: ${prevState}) latency:${result.avgLatency}ms`);
        }

        return "up";

    } else {

        const normalizedState = "DOWN";

        const transitionResult = evaluateTransition({
            currentState: normalizedState,
            lastOperationalState: existing ? existing.last_operational_state : null,
            pendingState: existing ? existing.pending_state : null,
            pendingCount: existing ? existing.pending_count : 0,
            downConfirmCount: config.monitoring.downConfirmCount,
            recoveryConfirmCount: config.monitoring.recoveryConfirmCount
        });

        saveTransitionResult(target.customerId, transitionResult, transitionResult.event, {
            backend: "icmp_ping",
            latencyMs: null,
            packetLoss: result.packetLoss
        });

        if (transitionResult && transitionResult.event) {
            void sendAlertIfNeeded(bot, transitionResult.event, target, {
                name: "ICMP Ping",
                backend: "icmp_ping",
                packetLoss: result.packetLoss,
                error: result.error || "unreachable"
            });
        }

        if (!debug) {
            console.log(`DOWN (prev: ${prevState}) ${result.error || "unreachable"}`);
        }

        return "down";
    }
}

// ============================================================
// RUN MONITORING CYCLE
// ============================================================

async function runMonitoringCycle(bot) {

    if (monitoringRunning) {
        console.log("[MONITOR] Cycle skipped: previous cycle still running");
        return;
    }

    monitoringRunning = true;

    const startTime = Date.now();

    try {

        const debug = String(process.env.DEBUG_MONITORING || "false").toLowerCase() === "true";

        if (!debug) {
            console.log("[MONITOR] Cycle started");
        }

        const { summary, inventory } = getInventorySummary();

        const mappedTargets = inventory.filter(item => {
            return (
                item.enabled &&
                item.monitoringScope === "prtg" &&
                item.mappingStatus === "mapped" &&
                item.primarySensor &&
                item.primarySensor.name
            );
        });

        const pingTargetsList = config.directPing.enabled
            ? inventory.filter(item => {
                  return (
                      item.enabled &&
                      item.monitoringScope === "not_in_prtg" &&
                      isValidIPv4(item.ip)
                  );
              })
            : [];

        if (!debug) {
            console.log(`[MONITOR] PRTG targets: ${mappedTargets.length}`);
            console.log(`[MONITOR] Direct ping targets: ${pingTargetsList.length}`);
        }

        let prtgUp = 0;
        let prtgDown = 0;
        let prtgWarning = 0;
        let prtgUnusual = 0;
        let prtgPaused = 0;
        let prtgUnknown = 0;
        let prtgApiErrors = 0;

        let pingUp = 0;
        let pingDown = 0;
        let pingUnknown = 0;

        for (const target of mappedTargets) {

            const state = await processPrtgTarget(bot, target);

            switch (state) {
                case "up":
                    prtgUp++;
                    break;
                case "down":
                    prtgDown++;
                    break;
                case "warning":
                    prtgWarning++;
                    break;
                case "unusual":
                    prtgUnusual++;
                    break;
                case "paused":
                    prtgPaused++;
                    break;
                case "unknown":
                    prtgUnknown++;
                    prtgApiErrors++;
                    break;
                default:
                    prtgUnknown++;
                    break;
            }
        }

        if (pingTargetsList.length > 0) {

            const results = await pingTargets(pingTargetsList, {
                count: config.directPing.count,
                timeoutSeconds: config.directPing.timeoutSeconds,
                concurrency: config.directPing.concurrency
            });

            for (let i = 0; i < pingTargetsList.length; i++) {

                const target = pingTargetsList[i];
                const result = results[i];

                try {

                    const state = processPingTarget(bot, target, result);

                    if (state === "up") pingUp++;
                    else if (state === "down") pingDown++;
                    else pingUnknown++;

                } catch (error) {

                    if (!debug) {
                        console.error(`[MONITOR] Error processing ping target #${target.clientId}:`, error.message);
                    }
                    pingUnknown++;
                }
            }
        }

        const duration = Date.now() - startTime;

        if (!debug) {
            console.log(`[MONITOR] Cycle complete. Duration: ${duration}ms`);
            console.log(`[MONITOR] PRTG: ${mappedTargets.length} | UP: ${prtgUp} | DOWN: ${prtgDown} | WARNING: ${prtgWarning} | UNUSUAL: ${prtgUnusual} | PAUSED: ${prtgPaused} | UNKNOWN: ${prtgUnknown}`);
            if (prtgApiErrors > 0) {
                console.log(`[MONITOR] PRTG API errors: ${prtgApiErrors}`);
            }
            console.log(`[MONITOR] DIRECT PING: ${pingTargetsList.length} | UP: ${pingUp} | DOWN: ${pingDown} | UNKNOWN: ${pingUnknown}`);
            console.log(`[MONITOR] TOTAL: ${mappedTargets.length + pingTargetsList.length} | UP: ${prtgUp + pingUp} | DOWN: ${prtgDown + pingDown} | UNKNOWN: ${prtgUnknown + pingUnknown}`);
        }

        recordCycle({
            success: true,
            durationMs: duration,
            targetCount: mappedTargets.length + pingTargetsList.length,
            error: null
        });

    } catch (error) {

        console.error("[MONITOR] Cycle error:", error);

        recordCycle({
            success: false,
            durationMs: Date.now() - startTime,
            targetCount: 0,
            error: error.message
        });

    } finally {

        monitoringRunning = false;
    }
}

// ============================================================
// START MONITORING
// ============================================================

function startMonitoring(bot) {

    const intervalSeconds = config.monitoring.pollInterval;
    const intervalMs = intervalSeconds * 1000;

    console.log(`[MONITOR] Interval: ${intervalSeconds}s`);
    console.log(`[MONITOR] DOWN confirmation: ${config.monitoring.downConfirmCount} polls`);
    console.log(`[MONITOR] Recovery confirmation: ${config.monitoring.recoveryConfirmCount} polls`);
    console.log(`[MONITOR] Alerts enabled: ${config.monitoring.alertsEnabled}`);
    console.log(`[MONITOR] Direct Ping enabled: ${config.directPing.enabled}`);
    console.log(`[MONITOR] Direct Ping concurrency: ${config.directPing.concurrency}`);

    runMonitoringCycle(bot);

    monitoringIntervalId = setInterval(() => {
        runMonitoringCycle(bot);
    }, intervalMs);

    console.log("[MONITOR] Engine started");
}

// ============================================================
// STOP MONITORING
// ============================================================

function stopMonitoring() {

    if (monitoringIntervalId) {
        clearInterval(monitoringIntervalId);
        monitoringIntervalId = null;
        console.log("[MONITOR] Engine stopped");
    }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    runMonitoringCycle,
    startMonitoring,
    stopMonitoring,
    getHeartbeatData
};
