// ============================================================
// TRANSITION CONFIRMATION ENGINE
// ============================================================

// ============================================================
// EVALUATE TRANSITION
// ============================================================

function evaluateTransition(options) {

    const {
        currentState,
        lastOperationalState,
        pendingState,
        pendingCount,
        downConfirmCount,
        recoveryConfirmCount
    } = options;

    const operational =
        currentState === "UP" || currentState === "DOWN";

    if (!operational) {

        return {
            confirmedState: lastOperationalState || currentState,
            pendingState: null,
            pendingCount: 0,
            event: null
        };
    }

    if (!lastOperationalState) {

        return {
            confirmedState: currentState,
            pendingState: null,
            pendingCount: 0,
            event: null
        };
    }

    if (currentState === lastOperationalState) {

        return {
            confirmedState: currentState,
            pendingState: null,
            pendingCount: 0,
            event: null
        };
    }

    const required =
        currentState === "DOWN"
            ? downConfirmCount
            : recoveryConfirmCount;

    let newPendingState = pendingState;
    let newPendingCount = pendingCount;

    if (pendingState === currentState) {
        newPendingCount = pendingCount + 1;
    } else {
        newPendingState = currentState;
        newPendingCount = 1;
    }

    if (newPendingCount >= required) {

        return {
            confirmedState: currentState,
            pendingState: null,
            pendingCount: 0,
            event: currentState === "DOWN" ? "DOWN" : "RECOVERY"
        };
    }

    return {
        confirmedState: lastOperationalState,
        pendingState: newPendingState,
        pendingCount: newPendingCount,
        event: null
    };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    evaluateTransition
};