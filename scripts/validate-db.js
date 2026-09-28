#!/usr/bin/env node
/**
 * Validate helper: checks SQLite file integrity, foreign keys,
 * and full application schema derived from migrations 1-5.
 *
 * Uses a temporary in-memory SQLite database to apply the OFFICIAL
 * migration SQL files, then compares table_info() of the result
 * against the target database. This ensures schema validation matches
 * the real migration behavior, not a hand-written parser.
 *
 * Usage:
 *   node scripts/validate-db.js <db-path>
 *   npm run validate-backup -- <db-path>
 *
 * Exit codes:
 *   0 = valid
 *   1 = wrong usage
 *   2 = invalid database or schema mismatch
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const [, , dbPath] = process.argv;

if (!dbPath) {
    console.error('Usage: node scripts/validate-db.js <db-path>');
    process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'infrastructure', 'database', 'migrations');

if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: File not found: ${dbPath}`);
    process.exit(2);
}

if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`ERROR: Migrations dir not found: ${MIGRATIONS_DIR}`);
    process.exit(2);
}

try {
    // 1. Build reference schema from real migration files in an in-memory DB
    const refDb = new Database(':memory:');
    // Create schema_migrations table FIRST (normally done by migration runner's ensureMigrationTable)
    refDb.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    refDb.exec('PRAGMA foreign_keys = ON;');

    const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (migrationFiles.length === 0) {
        console.error('ERROR: No migration files found in', MIGRATIONS_DIR);
        refDb.close();
        process.exit(2);
    }

    const expectedVersions = [];
    for (const file of migrationFiles) {
        const match = file.match(/^(\d+)_/);
        if (match) {
            expectedVersions.push(parseInt(match[1], 10));
        }
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
        refDb.exec(sql);
    }

    // 2. Get reference table structure from in-memory DB
    const refTables = refDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    // Get reference columns per table (from in-memory DB with real migrations)
    const refColumns = {};
    for (const table of refTables) {
        if (table === 'sqlite_sequence') continue;
        const cols = refDb.prepare(`PRAGMA table_info("${table}")`).all();
        refColumns[table] = cols.map(c => ({ name: c.name, type: c.type }));
    }

    expectedVersions.sort((a, b) => a - b);

    // 3. Open target database (readonly)
    const db = new Database(dbPath, { readonly: true });

    // 4. Integrity check
    const integrity = db.pragma('integrity_check', { simple: false });
    let integrityResult = 'ok';
    if (Array.isArray(integrity) && integrity.length > 0) {
        integrityResult = integrity[0].integrity_check || integrity[0];
    }
    if (integrityResult !== 'ok') {
        console.error('Integrity check failed:', integrityResult);
        db.close();
        refDb.close();
        process.exit(2);
    }

    // 5. Foreign key check
    const fkErrors = db.pragma('foreign_key_check', { simple: false });
    if (Array.isArray(fkErrors) && fkErrors.length > 0) {
        console.error('Foreign key violations:', JSON.stringify(fkErrors));
        db.close();
        refDb.close();
        process.exit(2);
    }

    // 6. Tables in target must match reference exactly
    const targetTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    const missingTables = refTables.filter(t => !targetTables.includes(t));
    if (missingTables.length > 0) {
        console.error('Missing core tables:', missingTables.join(', '));
        db.close();
        refDb.close();
        process.exit(2);
    }

    // 7. Columns in target must match reference (name + type)
    const columnErrors = [];
    for (const table of refTables) {
        if (table === 'sqlite_sequence') continue;
        const targetCols = db.prepare(`PRAGMA table_info("${table}")`).all();
        const targetColMap = {};
        for (const c of targetCols) {
            targetColMap[c.name] = c.type;
        }

        for (const refCol of refColumns[table]) {
            const actualType = targetColMap[refCol.name];
            if (actualType === undefined) {
                columnErrors.push(`${table}.${refCol.name} (missing)`);
            } else if (actualType !== refCol.type) {
                columnErrors.push(`${table}.${refCol.name} (type mismatch: expected ${refCol.type}, got ${actualType})`);
            }
        }
    }

    if (columnErrors.length > 0) {
        console.error('Schema column mismatches:', columnErrors.join('; '));
        db.close();
        refDb.close();
        process.exit(2);
    }
    console.error('migrationTableCheck: no schema drift detected');

    // 8. Migration records: must have all expected versions
    const versions = db.prepare(
        'SELECT version FROM schema_migrations ORDER BY version'
    ).all();
    const appliedVersions = versions.map(v => v.version);
    const missingVersions = expectedVersions.filter(v => !appliedVersions.includes(v));

    if (missingVersions.length > 0) {
        console.error('Missing migration records:', missingVersions.join(', '));
        db.close();
        refDb.close();
        process.exit(2);
    }

    db.close();
    refDb.close();

    console.log(JSON.stringify({
        valid: true,
        integrity: 'ok',
        foreign_keys: 'ok',
        tables_checked: refTables.length,
        columns_checked: Object.values(refColumns).reduce((s, cols) => s + cols.length, 0),
        schema_versions: appliedVersions,
        migration_files: expectedVersions.length,
    }));
} catch (err) {
    console.error('Validation error:', err.message);
    process.exit(2);
}
