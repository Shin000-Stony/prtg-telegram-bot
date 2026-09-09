const db = require("./database");

// ============================================================
// INITIALIZE DATABASE
// ============================================================

function initializeDatabase() {

    // --------------------------------------------------------
    // Create table
    // --------------------------------------------------------

    db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            client_id INTEGER,

            name TEXT NOT NULL,

            ip TEXT NOT NULL,

            location TEXT NOT NULL,

            service_id TEXT,

            description TEXT NOT NULL,

            enabled INTEGER NOT NULL DEFAULT 1,

            monitoring_scope TEXT NOT NULL DEFAULT 'prtg',

            monitoring_note TEXT,

            scope_updated_by TEXT,

            scope_updated_at TEXT,

            created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // --------------------------------------------------------
    // Check columns
    // --------------------------------------------------------

    const columns = db.prepare(
        `PRAGMA table_info(customers)`
    ).all();

    const hasClientId = columns.some(
        column => column.name === "client_id"
    );

    // --------------------------------------------------------
    // Migration
    // --------------------------------------------------------

    if (!hasClientId) {

        console.log(
            "[DB] Kolom client_id belum ada."
        );

        console.log(
            "[DB] Menambahkan client_id..."
        );

        db.exec(`
            ALTER TABLE customers
            ADD COLUMN client_id INTEGER
        `);
    }

    // --------------------------------------------------------
    // Backfill missing client_id
    // --------------------------------------------------------

    const missing =
        db.prepare(`
            SELECT id
            FROM customers
            WHERE client_id IS NULL
            ORDER BY id ASC
        `).all();

    if (missing.length > 0) {

        console.log(
            `[DB] ${missing.length} customer belum memiliki client_id.`
        );

        const maxResult =
            db.prepare(`
                SELECT COALESCE(MAX(client_id), 0)
                AS max_client_id
                FROM customers
            `).get();

        let nextClientId =
            maxResult.max_client_id + 1;

        const update =
            db.prepare(`
                UPDATE customers
                SET client_id = ?
                WHERE id = ?
            `);

        const migrate =
            db.transaction(() => {

                for (const customer of missing) {

                    update.run(
                        nextClientId,
                        customer.id
                    );

                    nextClientId++;
                }
            });

        migrate();

        console.log(
            "[DB] client_id berhasil diisi."
        );
    }

    // --------------------------------------------------------
    // Monitoring scope columns
    // --------------------------------------------------------

    const scopeColumns = db.prepare(
        `PRAGMA table_info(customers)`
    ).all();

    const hasMonitoringScope = scopeColumns.some(
        column => column.name === "monitoring_scope"
    );

    if (!hasMonitoringScope) {

        console.log(
            "[DB] Kolom monitoring_scope belum ada."
        );

        console.log(
            "[DB] Menambahkan monitoring_scope, monitoring_note, " +
            "scope_updated_by, scope_updated_at..."
        );

        db.exec(`
            ALTER TABLE customers
            ADD COLUMN monitoring_scope TEXT NOT NULL DEFAULT 'prtg'
        `);

        db.exec(`
            ALTER TABLE customers
            ADD COLUMN monitoring_note TEXT
        `);

        db.exec(`
            ALTER TABLE customers
            ADD COLUMN scope_updated_by TEXT
        `);

        db.exec(`
            ALTER TABLE customers
            ADD COLUMN scope_updated_at TEXT
        `);

        console.log(
            "[DB] monitoring_scope migration complete."
        );
    }

    // --------------------------------------------------------
    // Unique index
    // --------------------------------------------------------

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_customers_client_id
        ON customers(client_id);
    `);

    // --------------------------------------------------------
    // Other indexes
    // --------------------------------------------------------

    db.exec(`
        CREATE INDEX IF NOT EXISTS
        idx_customers_service_id
        ON customers(service_id);

        CREATE INDEX IF NOT EXISTS
        idx_customers_ip
        ON customers(ip);

        CREATE INDEX IF NOT EXISTS
        idx_customers_enabled
        ON customers(enabled);
    `);

    // --------------------------------------------------------
    // Mapping tables
    // --------------------------------------------------------

    db.exec(`
        CREATE TABLE IF NOT EXISTS
        customer_prtg_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id INTEGER NOT NULL,

            prtg_objid INTEGER,

            device TEXT,

            host TEXT,

            group_name TEXT,

            probe TEXT,

            status TEXT,

            mapping_status TEXT NOT NULL
                DEFAULT 'mapped',

            mapping_source TEXT NOT NULL
                DEFAULT 'auto',

            mapping_mode TEXT NOT NULL
                DEFAULT 'auto_primary',

            mapped_by TEXT,

            mapped_at TEXT,

            is_primary INTEGER NOT NULL DEFAULT 0,

            last_verified_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (customer_id)
                REFERENCES customers(id)
                ON DELETE CASCADE
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS
        customer_prtg_sensors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            device_mapping_id INTEGER NOT NULL,

            prtg_objid INTEGER NOT NULL,

            sensor TEXT NOT NULL,

            status TEXT,

            lastvalue TEXT,

            sensor_type TEXT,

            is_primary INTEGER NOT NULL DEFAULT 0,

            enabled INTEGER NOT NULL DEFAULT 1,

            last_verified_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (device_mapping_id)
                REFERENCES customer_prtg_devices(id)
                ON DELETE CASCADE
        );
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS
        idx_customer_prtg_devices_customer
        ON customer_prtg_devices(customer_id);

        CREATE INDEX IF NOT EXISTS
        idx_customer_prtg_sensors_device
        ON customer_prtg_sensors(device_mapping_id);
    `);

    // --------------------------------------------------------
    // Monitoring state table
    // --------------------------------------------------------

    db.exec(`
        CREATE TABLE IF NOT EXISTS
        customer_monitoring_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id INTEGER NOT NULL,

            current_state TEXT NOT NULL,

            previous_state TEXT,

            last_operational_state TEXT,

            primary_sensor_objid INTEGER,

            primary_sensor_name TEXT,

            last_value TEXT,

            last_checked_at TEXT,

            last_changed_at TEXT,

            monitoring_backend TEXT DEFAULT 'none',

            last_latency_ms REAL,

            last_packet_loss INTEGER,

            created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (customer_id)
                REFERENCES customers(id)
                ON DELETE CASCADE
        );
    `);

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_customer_monitoring_state_customer
        ON customer_monitoring_state(customer_id);
    `);

    // --------------------------------------------------------
    // Monitoring state migration: confirmation fields
    // --------------------------------------------------------

    const monitoringColumns = db.prepare(
        `PRAGMA table_info(customer_monitoring_state)`
    ).all();

    const hasPendingState = monitoringColumns.some(
        column => column.name === "pending_state"
    );

    if (!hasPendingState) {

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN pending_state TEXT
        `);

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN pending_count INTEGER NOT NULL DEFAULT 0
        `);

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN last_alert_state TEXT
        `);

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN last_alert_at TEXT
        `);
    }

    // --------------------------------------------------------
    // Monitoring state migration: backend columns
    // --------------------------------------------------------

    const hasMonitoringBackend = monitoringColumns.some(
        column => column.name === "monitoring_backend"
    );

    if (!hasMonitoringBackend) {

        console.log(
            "[DB] Kolom monitoring_backend belum ada."
        );

        console.log(
            "[DB] Menambahkan monitoring_backend, last_latency_ms, last_packet_loss..."
        );

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN monitoring_backend TEXT DEFAULT 'none'
        `);

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN last_latency_ms REAL
        `);

        db.exec(`
            ALTER TABLE customer_monitoring_state
            ADD COLUMN last_packet_loss INTEGER
        `);
    }

    // --------------------------------------------------------
    // Mapping audit columns
    // --------------------------------------------------------

    const deviceColumns = db.prepare(
        `PRAGMA table_info(customer_prtg_devices)`
    ).all();

    const hasMappingSource = deviceColumns.some(
        column => column.name === "mapping_source"
    );

    if (!hasMappingSource) {

        console.log(
            "[DB] Kolom mapping_source belum ada."
        );

        console.log(
            "[DB] Menambahkan mapping_source, mapped_by, mapped_at..."
        );

        db.exec(`
            ALTER TABLE customer_prtg_devices
            ADD COLUMN mapping_source TEXT NOT NULL DEFAULT 'auto'
        `);

        db.exec(`
            ALTER TABLE customer_prtg_devices
            ADD COLUMN mapped_by TEXT
        `);

        db.exec(`
            ALTER TABLE customer_prtg_devices
            ADD COLUMN mapped_at TEXT
        `);
    }

    // --------------------------------------------------------
    // Mapping mode column
    // --------------------------------------------------------

    const hasMappingMode = deviceColumns.some(
        column => column.name === "mapping_mode"
    );

    if (!hasMappingMode) {

        console.log(
            "[DB] Kolom mapping_mode belum ada."
        );

        console.log(
            "[DB] Menambahkan mapping_mode..."
        );

        db.exec(`
            ALTER TABLE customer_prtg_devices
            ADD COLUMN mapping_mode TEXT NOT NULL DEFAULT 'auto_primary'
        `);
    }

    // --------------------------------------------------------
    // Monitoring heartbeat
    // --------------------------------------------------------

    db.exec(`
        CREATE TABLE IF NOT EXISTS monitoring_heartbeat (
            id INTEGER PRIMARY KEY CHECK (id = 1),

            last_cycle_at TEXT,

            last_successful_cycle_at TEXT,

            last_cycle_duration_ms INTEGER,

            last_cycle_target_count INTEGER,

            last_error TEXT,

            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
        INSERT OR IGNORE INTO monitoring_heartbeat (id)
        VALUES (1)
    `);

    // --------------------------------------------------------
    // Telegram groups tables (V8)
    // --------------------------------------------------------

    db.exec(`
        CREATE TABLE IF NOT EXISTS
        telegram_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            chat_id INTEGER NOT NULL,

            name TEXT NOT NULL,

            enabled INTEGER NOT NULL DEFAULT 1,

            created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_telegram_groups_chat_id
        ON telegram_groups(chat_id);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS
        customer_telegram_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id INTEGER NOT NULL,

            telegram_group_id INTEGER NOT NULL,

            can_view INTEGER NOT NULL DEFAULT 1,

            receive_alerts INTEGER NOT NULL DEFAULT 1,

            created_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (customer_id)
                REFERENCES customers(id)
                ON DELETE CASCADE,

            FOREIGN KEY (telegram_group_id)
                REFERENCES telegram_groups(id)
                ON DELETE CASCADE
        );
    `);

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_ctg_customer_group
        ON customer_telegram_groups(customer_id, telegram_group_id);

        CREATE INDEX IF NOT EXISTS
        idx_ctg_group
        ON customer_telegram_groups(telegram_group_id);

        CREATE INDEX IF NOT EXISTS
        idx_ctg_customer
        ON customer_telegram_groups(customer_id);
    `);

    console.log(
        "[DB] Database berhasil diinisialisasi."
    );

    console.log(
        `[DB] File: ${db.name}`
    );
}

// ============================================================

initializeDatabase();