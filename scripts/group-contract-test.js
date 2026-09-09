#!/bin/env node

/**
 * Group Contract Test
 *
 * Verifies that all group-management exports referenced by command modules
 * are actually present and callable.
 *
 * This catches runtime regressions like:
 *   canGroupViewCustomer is not defined
 *   confirmationMessage is not a function
 *
 * Run: node scripts/group-contract-test.js
 */

require("dotenv").config();

const tgRepo = require("../src/database/telegram-groups");
const groupContext = require("../src/telegram/group-context");
const ui = require("../src/telegram/ui");
const notifier = require("../src/monitoring/notifier");

const requiredNotifierMethods = [
    "resolveAlertRecipients",
    "sendAlertToRecipients",
    "notifyDown",
    "notifyRecovery"
];

const requiredTgRepoMethods = [
    "registerGroup",
    "getGroupByChatId",
    "getGroupById",
    "listGroups",
    "enableGroup",
    "disableGroup",
    "deleteGroup",
    "assignCustomerToGroup",
    "unassignCustomerFromGroup",
    "getGroupCustomers",
    "getGroupVisibleCustomers",
    "getCustomerGroups",
    "setGroupAlertPreference",
    "canGroupViewCustomer",
    "isCustomerAssignedToGroup",
    "getAssignmentFlags",
    "getAlertRecipientsForCustomer"
];

const requiredContextHelpers = [
    "isPrivateChat",
    "isGroupChat",
    "getChatId",
    "getRegisteredGroup",
    "requireRegisteredGroup",
    "getVisibleCustomersForContext",
    "canViewCustomerInContext"
];

const requiredUIRenderers = [
    "renderGroupRegistered",
    "renderGroupAlreadyRegistered",
    "renderGroupList",
    "renderGroupInfo",
    "renderGroupClients",
    "renderGroupAssignmentConfirmation",
    "renderGroupUnassignConfirmation",
    "renderGroupRemoveConfirmation",
    "renderGroupStatus"
];

const requiredUIMessageHelpers = [
    "successMessage",
    "errorMessage",
    "warningMessage",
    "infoMessage",
    "accessDeniedMessage",
    "confirmationMessage"
];

let failed = false;

function check(target, name, label) {
    const val = target[name];
    if (val === undefined) {
        console.error("FAIL: " + label + "." + name + " is not exported");
        failed = true;
    } else if (typeof val !== "function") {
        console.error("FAIL: " + label + "." + name + " is not a function (type: " + typeof val + ")");
        failed = true;
    }
}

console.log("=== Telegram Groups Repository ===");
for (const name of requiredTgRepoMethods) {
    check(tgRepo, name, "telegram-groups");
}

console.log("=== Group Context Helpers ===");
for (const name of requiredContextHelpers) {
    check(groupContext, name, "group-context");
}

console.log("=== Group UI Renderers ===");
for (const name of requiredUIRenderers) {
    check(ui, name, "ui");
}

console.log("=== Group UI Message Helpers ===");
for (const name of requiredUIMessageHelpers) {
    check(ui, name, "ui");
}

console.log("=== Notifier Alert Routing ===");
for (const name of requiredNotifierMethods) {
    check(notifier, name, "notifier");
}

if (failed) {
    console.error("\nGROUP CONTRACT TEST: FAILED");
    process.exit(1);
}

const total = requiredTgRepoMethods.length +
    requiredContextHelpers.length +
    requiredUIRenderers.length +
    requiredUIMessageHelpers.length +
    requiredNotifierMethods.length;

console.log("\nOK: " + total + " group-related exports verified.");
console.log("GROUP CONTRACT TEST: PASSED");
