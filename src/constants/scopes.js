const SCOPES = {
    PRTG: "prtg",
    NOT_IN_PRTG: "not_in_prtg",
    PIC_MANAGED: "pic_managed"
};

const SCOPE_LABELS = {
    [SCOPES.PRTG]: "📡 PRTG",
    [SCOPES.NOT_IN_PRTG]: "🚫 NOT IN PRTG",
    [SCOPES.PIC_MANAGED]: "👤 PIC MANAGED"
};

const SCOPE_DISPLAY = {
    [SCOPES.PRTG]: "PRTG",
    [SCOPES.NOT_IN_PRTG]: "NOT IN PRTG",
    [SCOPES.PIC_MANAGED]: "PIC MANAGED"
};

const SCOPE_NOTE_PROMPT = {
    [SCOPES.NOT_IN_PRTG]:
        "Customer hanya tercatat pada list Excel dan tidak ditambahkan ke PRTG utama.",
    [SCOPES.PIC_MANAGED]:
        "Monitoring dikelola oleh PIC customer."
};

const VALID_SCOPE_INPUT = {
    prtg: SCOPES.PRTG,
    notinprtg: SCOPES.NOT_IN_PRTG,
    not_in_prtg: SCOPES.NOT_IN_PRTG,
    "not in prtg": SCOPES.NOT_IN_PRTG,
    pic: SCOPES.PIC_MANAGED,
    pic_managed: SCOPES.PIC_MANAGED,
    "pic managed": SCOPES.PIC_MANAGED
};

function isValidScope(value) {
    return Boolean(value && SCOPES.hasOwnProperty(value));
}

function normalizeScopeInput(input) {
    if (!input) {
        return null;
    }

    const trimmed = String(input).trim().toLowerCase();
    return VALID_SCOPE_INPUT[trimmed] || null;
}

function scopeLabel(scope) {
    return SCOPE_LABELS[scope] || "❓ UNKNOWN";
}

function scopeDisplay(scope) {
    return SCOPE_DISPLAY[scope] || "UNKNOWN";
}

function isPrtgScope(scope) {
    return scope === SCOPES.PRTG;
}

module.exports = {
    SCOPES,
    SCOPE_LABELS,
    SCOPE_DISPLAY,
    SCOPE_NOTE_PROMPT,
    VALID_SCOPE_INPUT,
    isValidScope,
    normalizeScopeInput,
    scopeLabel,
    scopeDisplay,
    isPrtgScope
};
