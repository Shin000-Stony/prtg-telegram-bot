#!/bin/env node

/**
 * UI Contract Test
 *
 * Verifies that all UI exports referenced by command modules
 * are actually present and callable.
 *
 * Run: node scripts/ui-contract-test.js
 */

const ui = require("../src/telegram/ui");

const requiredFunctions = [
    "separator",
    "safe",
    "escapeHtml",
    "formatScopeLabel",
    "operatorCard",
    "section",
    "formatFooter",
    "formatCustomerIdentity",
    "formatCustomerIdentityCompact",
    "formatClientListItem",
    "successMessage",
    "errorMessage",
    "warningMessage",
    "accessDeniedMessage",
    "infoMessage",
    "confirmationMessage",
    "renderStatusSummary",
    "renderCustomerStatus",
    "renderClientDetail",
    "renderMappingSummary",
    "renderMappingDetail",
    "renderHealthSummary"
];

let failed = false;

for (const name of requiredFunctions) {
    const val = ui[name];
    if (val === undefined) {
        console.error("FAIL: " + name + " is not exported from ui.js");
        failed = true;
    } else if (typeof val !== "function") {
        console.error("FAIL: " + name + " is not a function (type: " + typeof val + ")");
        failed = true;
    }
}

if (failed) {
    console.error("\nUI CONTRACT TEST: FAILED");
    process.exit(1);
}

console.log("OK: " + requiredFunctions.length + " UI functions verified.");
console.log("UI CONTRACT TEST: PASSED");
