#!/usr/bin/env node
/**
 * Backup helper: creates a consistent SQLite backup using the SQLite backup API.
 * Does NOT import the application or start the bot.
 *
 * The SQLite backup API (source.backup(dest)) handles WAL files transparently —
 * it acquires a read lock and copies all committed data (including WAL content)
 * into the destination file. No manual wal_checkpoint needed: the backup API
 * internally checkpoints WAL at the appropriate point.
 *
 * Usage:
 *   node scripts/sqlite-backup.js <source-db-path> <output-path>
 *   npm run backup -- <source-db-path> <output-path>
 */
const Database = require('better-sqlite3');

const [, , srcPath, destPath] = process.argv;

if (!srcPath || !destPath) {
    console.error('Usage: node scripts/sqlite-backup.js <source-db> <output>');
    process.exit(1);
}

if (!require('fs').existsSync(srcPath)) {
    console.error(`ERROR: Source database not found: ${srcPath}`);
    process.exit(1);
}

const source = new Database(srcPath, { readonly: true });

try {
    // backup(filename) uses the SQLite backup API:
    // - Copies all committed data including WAL content
    // - Checkpoints WAL into the destination
    // - Returns a Promise (better-sqlite3 convention)
    source.backup(destPath).then(() => {
        source.close();
        console.log(JSON.stringify({
            dbPath: srcPath,
            outputPath: destPath,
            status: 'success',
        }));
    }).catch((err) => {
        try { source.close(); } catch { /* ignore */ }
        console.error('Backup failed:', err.message);
        process.exit(1);
    });
} catch (err) {
    try { source.close(); } catch { /* ignore */ }
    console.error('Backup failed:', err.message);
    process.exit(1);
}
