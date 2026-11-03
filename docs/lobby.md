# Kartu 100: lobby (layer 2)

PR ini ditumpuk di atas registrasi, bukan `main`. Registrasi dan library
`src/index.js` tetap tersedia. Layer ini menambahkan ready, heartbeat/snapshot,
dan expiry lobby. **Semua siap tetap di lobby**; auto-start, game placeholder,
dan aturan kartu tidak termasuk layer ini.

## Kontrak backend tambahan

Endpoint, envelope, kredensial, lock script 5000 ms, dan reserved
`Game100State!A1` mengikuti [registrasi](./registration.md). Semua mutasi dan
cleanup menggunakan domain yang sama pada Node dan build `Code.gs`.

| action | Field selain action/requestId/spreadsheetUrl | Perilaku |
| --- | --- | --- |
| `setReady` | `serverId`, `playerId`, `secret`, `ready` boolean, `readyVersion` integer positif | Set nilai eksplisit, bukan toggle; heartbeat server-time dan snapshot terbaru. |
| `sync` | `serverId`, `playerId`, `secret` | Satu request untuk heartbeat sekaligus snapshot. |
| `resume` | Sama dengan sebelumnya | Sekarang juga heartbeat setelah cleanup, bukan hanya read. |

Public player sekarang `{id,name,ready,lastSeenAt,readyVersion}`.
`ready` boleh boolean. `readyVersion` adalah counter keputusan per pemain:
player baru mulai 0, keputusan baru harus versi terakhir + 1, versi lebih lama
atau sama tidak mengubah ready. SetReady dengan versi meloncat ditolak.
Counter tidak menggantikan kredensial atau requestId.

Persisted player layer 1 yang belum memiliki `readyVersion` diterima sebagai
versi 0. Penulisan berikutnya menambahkan counter bila diperlukan; tidak
menghapus/menginisialisasi ulang server. Keys lain tetap ketat. SchemaVersion
tetap 1; fase yang didukung saat ini tetap hanya `lobby`.

SetReady memakai fingerprint berisi nilai ready dan readyVersion serta
identitas. Join/leave tetap kompatibel dengan fingerprint layer 1.
32 record dedupe terakhir mencakup join/leave/setReady, **bukan** heartbeat.
Retry dalam window itu mengembalikan snapshot terbaru tanpa mengulang
keputusan. Counter per-player tetap mencegah replay keputusan lama membalik
ready setelah record dedupe dieviksikan. Penggunaan requestId berbeda dengan
versi yang sama tidak mengganti keputusan yang lebih dahulu diterima.
Jaminan deteksi body/requestId berbeda tetap terbatas 32 record; tombstone
join/leave tidak abadi.

## Timeout dan urutan mutasi

Expire bila `serverNow - lastSeenAt >= 60000`, termasuk tepat 60 detik.
Cleanup terjadi **sebelum** heartbeat, capacity/name check, atau perubahan
ready. Pemain yang telah timeout tidak dapat menyelamatkan identitasnya
dengan heartbeat yang terlambat.

Cleanup request-driven: initialize valid, join valid, dan perintah sesi
terautentikasi membersihkan pemain stale dalam lock yang sama. Tidak ada
timer/scheduler backend atau janji penghapusan persis pada detik ke-60 jika
tidak ada request. Kredensial salah tidak mengubah state, termasuk heartbeat
atau cleanup.

Jika ada pemain expired, hapus mereka dan reset **semua pemain tersisa**
menjadi `ready:false`; naikkan readyVersion mereka untuk membatalkan
keputusan lama yang masih tertunda. Join biasa dan leave eksplisit **tidak**
mereset ready pemain lain. Pemain baru selalu belum siap.

Cleanup tetap ditulis dan di-flush sebelum envelope error dikembalikan,
misalnya `SESSION_ENDED` untuk requester yang baru saja expired atau
`NAME_TAKEN` setelah pemain stale lain dihapus. Request berikutnya dengan
identitas yang sudah tidak ada dapat menghasilkan `INVALID_SESSION`.
Domain outcome internal dapat berupa `{state,changed,error:{code,message}}`;
runtime wajib menyimpan `state` bila `changed` sebelum mengirim error.
Jangan mengubahnya menjadi throw yang membuang cleanup.

Revision naik sekali per request yang mengubah state (cleanup, heartbeat
timestamp baru, keputusan, membership, atau dedupe metadata). Response retry
tidak mengembalikan roster historis. Secret digest dan retries tetap tidak
masuk public response.

Cleanup memiliki guard `phase === 'lobby'`. Layer game berikutnya harus
memperluas validator/kontrak fase secara eksplisit; jangan menerapkan expiry
lobby pada peserta game.

## Validasi dan batas deployment

Jalankan `npm run check`, `npm test`, dan `npm run build:apps-script`.
Test deterministik mencakup boundary 60 detik, cleanup yang bertahan pada
error, ready reset versus join/leave biasa, dedupe/eviction, kredensial salah,
capacity/nama NFC setelah expiry, dan reserved-cell isolation.
Fake layanan Google dan artifact VM **bukan** validasi Google/CORS live.
