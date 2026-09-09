# Panduan Operator - PRTG Telegram Monitoring Bot

Panduan ini untuk operator/staff kantor yang menggunakan bot monitoring PRTG ini.

---

## Apa yang dilakukan bot ini?

Bot ini memonitor customer tertentu dari sistem PRTG dan mengirim notifikasi Telegram ketika koneksi customer benar-benar mati (DOWN) atau sudah pulih (UP).

**Hanya customer yang terdaftar di bot yang dimonitor.**

---

## Perintah Telegram yang Sering Digunakan

### Melihat Status Customer

```
/status
```

Menampilkan ringkasan status semua customer.

```
/status 11
```

Menampilkan detail status customer nomor 11.

### Melihat Daftar Customer

```
/clients
```

Menampilkan daftar semua customer terdaftar.

### Melihat Detail Customer

```
/client 11
```

Menampilkan detail customer nomor 11 (alamat, IP, lokasi, dll).

### Melihat Mapping PRTG

```
/mapping
```

Menampilkan ringkasan mapping customer ke PRTG, termasuk scope classification.

```
/mapping 11
```

Menampilkan detail mapping customer nomor 11, termasuk sumber mapping (Manual/Automatic), mode (Auto Primary/Explicit Sensor), dan monitoring scope.

### Mencari Device PRTG (Admin)

```
/find_prtg <query>
```

Pencarian cepat device PRTG berdasarkan nama, IP, Service ID, atau ObjID.

```
/find_prtg_deep <query>
```

Pencarian luas device PRTG dengan scoring. Digunakan ketika pencarian cepat tidak menemukan hasil yang relevan.

```
/prtg_device <objid>
```

Lihat detail device PRTG termasuk daftar sensor.

### Mencari Sensor PRTG (Admin)

```
/find_prtg_sensor <query>
```

Pencarian sensor PRTG berdasarkan nama sensor, nama device, host, group, atau ObjID. Digunakan ketika customer berada pada shared/aggregation router.

```
/prtg_sensor <sensor_objid>
```

Lihat detail sensor PRTG termasuk parent device.

---

## Admin Commands

### Menambah Customer

```
/add_client
```

Ikuti instruksi di chat untuk menambah customer baru.

### Menonaktifkan Customer

```
/disable_client 11
```

Menghentikan monitoring untuk customer nomor 11.

### Mengaktifkan Customer

```
/enable_client 11
```

Melanjutkan monitoring untuk customer nomor 11.

### Menghapus Customer

```
/remove_client 11
```

Menghapus customer nomor 11 dari database.

### Test Alert

```
/test_alert
```

Mengirim test alert untuk memverifikasi Telegram notification bekerja.

### Cek Kesehatan Bot

```
/health
```

Menampilkan status kesehatan bot (Telegram, PRTG, Database, Monitoring).

### Memetakan Customer ke PRTG (Manual Mapping)

Jika customer tidak ter-mapping otomatis, gunakan alur berikut:

1. Cari device PRTG:
   ```
   /find_prtg_deep CITRA
   ```

2. Inspeksi device:
   ```
   /prtg_device 14520
   ```

3. Pastikan device benar, lalu petakan:
   ```
   /map_client 21 14520
   ```

4. Konfirmasi mapping:
   ```
   /confirm_map
   ```

### Explicit Sensor Mapping

Untuk customer pada shared/aggregation router (misal: CITRA pada CORE ROUTER):

1. Cari sensor:
   ```
   /find_prtg_sensor CITRA
   ```

2. Inspeksi sensor:
   ```
   /prtg_sensor 18432
   ```

3. Pastikan sensor benar, lalu petakan:
   ```
   /map_sensor 21 18432
   ```

4. Konfirmasi mapping:
   ```
   /confirm_map_sensor
   ```

### Monitoring Scope Classification

Setiap customer masuk ke salah satu dari lima klasifikasi:

| Classification | Scope | Icon | Arti |
|----------------|-------|------|------|
| Active PRTG | `prtg` | 📡 | Customer dimonitor oleh PRTG sensor. Mapping & primary sensor aktif diperlukan. |
| Active ICMP | `not_in_prtg` | 🌐 | Customer tidak ada di PRTG utama, tetapi dimonitor via Direct ICMP Ping. |
| Paused PRTG | `prtg` (semua sensor paused) | ⏸ | Customer terhubung ke PRTG, tetapi semua sensor dalam keadaan paused. |
| Unresolved PRTG | `prtg` | 🟡 | Customer terhubung ke PRTG, ada sensor aktif, tetapi tidak ada primary sensor yang dapat dipakai. |
| PIC Managed | `pic_managed` | 👤 | Monitoring dikelola oleh PIC/tim lain. Tidak dimonitor oleh bot ini. |
| Disabled | `disabled` | ❌ | Customer dihapus dari monitoring sama sekali. |

Classification ditentukan otomatis berdasarkan:
1. Apakah customer `enabled` di database (jika tidak → **Disabled**)
2. Monitoring scope yang diset
3. Status mapping PRTG
4. Status sensor PRTG (UP/DOWN/WARNING/UNUSUAL/PAUSED/UNKNOWN)

Setelah migrasi, semua customer yang sudah ada mendapat scope `PRTG` secara otomatis.

Gunakan `/set_scope` untuk mengubah scope secara eksplisit:

```
/set_scope 21 not_in_prtg
```

Atau dengan catatan:

```
/set_scope 21 not_in_prtg "Customer hanya tercatat di Excel"
```

Kemudian konfirmasi dengan:

```
/confirm_scope
```

**Penting:** `NOT IN PRTG` tidak lagi berarti "tidak dimonitor". Customer dengan scope `NOT IN PRTG` akan dimonitor via Direct ICMP Ping jika IP address valid.

### Membatalkan Mapping

1. Lihat konfirmasi unmap:
   ```
   /unmap_client 21
   ```

2. Konfirmasi penghapusan:
   ```
   /confirm_unmap
   ```

---

## Peringatan Penting

### Jangan anggap UNRESOLVED sebagai DOWN

Jika customer terhubung ke PRTG tetapi tidak ada device/sensor mapping yang valid, bot menampilkan status **UNRESOLVED**. Ini **bukan** berarti customer DOWN. Hubungi tim technical untuk membuat mapping.

### PAUSED bukan DOWN

Jika sensor PRTG dalam keadaan paused, bot menampilkan status `PAUSED`. Ini berarti sensor tidak aktif untuk monitoring, bukan customer DOWN.

Customer dengan semua sensor paused akan otomatis diklasifikasikan sebagai **Paused PRTG**.

### UNKNOWN bukan DOWN

Status `UNKNOWN` (⚪) dapat berarti PRTG API sementara tidak dapat diakses. Ini **bukan** berarti customer DOWN. Tunggu beberapa menit dan cek kembali.

**Penting:** `NULL` monitoring state (belum pernah di-monitor) **bukan** sama dengan `UNKNOWN`. Hanya target yang sedang aktif dipantau yang dapat berada dalam status UP, DOWN, atau UNKNOWN.

### UNRESOLVED bukan DOWN

Jika customer terhubung ke PRTG tetapi tidak ada primary sensor yang dapat dipilih (semua sensor unknown/unrecognized), bot menampilkan status `UNRESOLVED`. Ini **bukan** berarti customer DOWN.

Customer dengan klasifikasi **Unresolved PRTG** perlu ditinjau secara manual untuk memastikan mapping benar.

### PIC MANAGED tidak dimonitor

Customer dengan scope `PIC MANAGED` sengaja tidak dimonitor oleh bot ini. Pertanyaan "customer mana yang down?" **tidak termasuk** customer PIC MANAGED.

### DISABLED tidak dimonitor

Customer yang dinonaktifkan (via `/disable_client`) tidak dimonitoring dan tidak muncul dalam ringkasan status. Ini berbeda dengan PIC MANAGED — disabled customer adalah customer sementara tidak aktif, sedangkan PIC MANAGED adalah customer yang monitoringnya dikelola oleh tim lain secara permanen.

---

## Troubleshooting

### Bot tidak merespon

1. Periksa internet connection
2. Periksa Docker container: `docker compose ps`
3. Lihat logs: `docker compose logs --tail=100 prtg-bot`

### Alert tidak masuk

1. Pastikan `ALERTS_ENABLED=true` di `.env`
2. Pastikan `TELEGRAM_CHAT_ID` sudah diisi
3. Test dengan `/test_alert`
4. Periksa logs untuk error notification

### Customer tidak dimonitor

1. Cek status customer dengan `/mapping <id>`
2. Periksa monitoring scope dan classification dengan `/client <id>`
3. Pastikan customer `enabled`
4. Untuk classification **Active PRTG**: pastikan customer memiliki `mapped` status dan primary sensor aktif
5. Untuk classification **Active ICMP**: pastikan IP address valid untuk direct ping

Jika customer memiliki classification **PIC MANAGED** atau **Disabled**, ini memang sengaja tidak dimonitor oleh bot ini.

Jika customer memiliki classification **Paused PRTG**, semua sensor PRTG-nya sedang di-pause. Customer tidak akan dianggap DOWN sampai ada sensor yang aktif kembali.

Jika customer memiliki classification **Unresolved PRTG**, tidak ada primary sensor yang dapat dipilih. Hubungi tim technical untuk memastikan mapping sensor benar.

Jika customer memiliki classification **Active PRTG** dengan semua sensor dalam status UNKNOWN, PRTG API mungkin sedang bermasalah.

### PRTG tidak reachable

1. Periksa koneksi network
2. Periksa `PRTG_URL` di `.env`
3. Periksa VPN/LAN jika PRTG hanya accessible dari office network

---

## Backup

### Membuat Backup

```bash
docker compose exec prtg-bot npm run backup
```

Backup disimpan di volume `prtg_backup` atau direktori `backups/` (jika menggunakan bind mount).

### Restore

1. Stop container:
   ```bash
   docker compose stop
   ```
2. List backups:
   ```bash
   docker compose exec prtg-bot node scripts/restore.js list
   ```
3. Restore:
   ```bash
   docker compose exec prtg-bot node scripts/restore.js backups/prtg_bot_YYYY-MM-DD_HHMMSS.db
   ```
4. Start container:
   ```bash
   docker compose start
   ```
5. Verifikasi dengan `/health`

---

## Kontak

Untuk pertanyaan teknis, hubungi tim technical.
