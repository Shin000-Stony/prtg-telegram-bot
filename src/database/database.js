const Database = require("better-sqlite3");
const path = require("path");

function getDatabasePath() {

    const envPath = process.env.DATABASE_PATH;

    if (envPath) {
        return envPath;
    }

    const dataDir = path.join(
        process.cwd(),
        "data"
    );

    return path.join(
        dataDir,
        "prtg_bot.db"
    );
}

const dbPath = getDatabasePath();

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

module.exports = db;