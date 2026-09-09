const fs = require("fs");
const path = require("path");

const config = require("../src/config/env");

const dataDir = config.database.path
    ? path.dirname(config.database.path)
    : path.join(process.cwd(), "data");

const dbPath = config.database.path || path.join(dataDir, "prtg_bot.db");

const backupDir = process.env.BACKUP_DIR || "/backups";

function listBackups() {

    if (!fs.existsSync(backupDir)) {
        console.log("[RESTORE] No backups directory found.");
        return [];
    }

    return fs.readdirSync(backupDir)
        .filter(f => f.startsWith("prtg_bot_") && f.endsWith(".db"))
        .map(f => ({
            name: f,
            path: path.join(backupDir, f),
            mtime: fs.statSync(path.join(backupDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
}

function runRestore(backupFile) {

    console.log("[RESTORE] Starting restore...");

    if (!fs.existsSync(backupFile)) {
        console.error(`[RESTORE] Backup file not found: ${backupFile}`);
        process.exit(1);
    }

    try {
        fs.copyFileSync(backupFile, dbPath);
        console.log(`[RESTORE] Restored to: ${dbPath}`);
    } catch (error) {
        console.error("[RESTORE] Restore failed:", error.message);
        process.exit(1);
    }

    console.log("[RESTORE] Restore complete.");
}

function printUsage() {
    console.log("Usage:");
    console.log("  node scripts/restore.js [backup-file]");
    console.log("  node scripts/restore.js list");
    console.log("");
    console.log("Examples:");
    console.log("  node scripts/restore.js backups/prtg_bot_2026-08-31_170000.db");
    console.log("  node scripts/restore.js list");
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "list") {
    const backups = listBackups();
    if (backups.length === 0) {
        console.log("No backups found.");
    } else {
        console.log("Available backups:");
        backups.forEach((b, i) => {
            const date = b.mtime.toLocaleString("id-ID");
            console.log(`  ${i + 1}. ${b.name} (${date})`);
        });
    }
} else if (args[0] === "--help" || args[0] === "-h") {
    printUsage();
} else {
    runRestore(args[0]);
}