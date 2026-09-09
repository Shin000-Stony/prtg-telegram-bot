const fs = require("fs");
const path = require("path");

const config = require("../src/config/env");

const dataDir = config.database.path
    ? path.dirname(config.database.path)
    : path.join(process.cwd(), "data");

const dbPath = config.database.path || path.join(dataDir, "prtg_bot.db");

const backupDir = process.env.BACKUP_DIR || "/backups";

function getTimestamp() {

    const now = new Date();

    const pad = n => String(n).padStart(2, "0");

    return (
        now.getFullYear() +
        "-" +
        pad(now.getMonth() + 1) +
        "-" +
        pad(now.getDate()) +
        "_" +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds())
    );
}

function ensureDir(dir) {

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function pruneOldBackups(dir, keep) {

    const files = fs.readdirSync(dir)
        .filter(f => f.startsWith("prtg_bot_") && f.endsWith(".db"))
        .map(f => ({
            name: f,
            path: path.join(dir, f),
            mtime: fs.statSync(path.join(dir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);

    for (let i = keep; i < files.length; i++) {
        fs.unlinkSync(files[i].path);
    }
}

async function runBackup() {

    console.log("[BACKUP] Starting backup...");

    if (!fs.existsSync(dbPath)) {
        console.error(`[BACKUP] Database not found: ${dbPath}`);
        process.exit(1);
    }

    ensureDir(backupDir);

    const timestamp = getTimestamp();
    const backupFile = path.join(backupDir, `prtg_bot_${timestamp}.db`);

    const Database = require("better-sqlite3");
    const source = new Database(dbPath);

    try {
        await source.backup(backupFile);
        console.log(`[BACKUP] Backup created: ${backupFile}`);
    } catch (error) {
        console.error("[BACKUP] Backup failed:", error.message);
        process.exit(1);
    } finally {
        source.close();
    }

    pruneOldBackups(backupDir, 7);

    console.log("[BACKUP] Backup complete.");
}

(async () => {
    await runBackup();
})();