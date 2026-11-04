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

## Client dan UI

`createRegistrationClient` mempertahankan API registrasi dan menambah
`setReady(boolean)` serta `sync()`. Client menyimpan versi keputusan dan
revision snapshot dalam session record endpoint + spreadsheet yang sama.
Record lama tanpa counter/revision tetap dapat dipulihkan.

SetReady menyimpan seluruh pending command (termasuk requestId/nilai/versi)
**sebelum** pengiriman. `resume()` maupun `sync()` menyelesaikan pending
join/leave/setReady yang sama sebelum mengirim heartbeat baru. Perintah baru
ready/leave ditolak dengan `PENDING_COMMAND` selama masih ada write ambigu.
`NETWORK_ERROR`, provider/permission/quota error, respons rusak, atau timeout
tidak menghapusnya. Dedupe hasil yang diterima mungkin menunjukkan ready=false
karena cleanup membatalkan keputusan lama; pengguna dapat menekan Siap lagi.

`SESSION_ENDED`, `INVALID_SESSION`, atau `SERVER_CHANGED` dari backend
membatalkan sesi lokal yang cocok dan UI kembali ke pendaftaran dengan alasan
jelas. Respons sukses untuk server/player lain ditolak sebagai
`INVALID_RESPONSE`, bukan dipercaya atau disimpan. Respons revision lama atau
untuk session record yang telah diganti diabaikan (`STALE_RESPONSE`).
Leave menghapus record hanya setelah konfirmasi; expiry/rejection kredensial
adalah pengecualian eksplisit karena identitas sudah tidak valid.

Satu antrean per client ditambah `navigator.locks.request` pada UI
menyerialkan poll dan mutasi, termasuk tab browser lain pada origin sama.
Semua operasi memuat sesi terbaru **di dalam** lock; dua tab tidak memakai
counter ready yang dicache sendiri. Dua tab masih boleh masing-masing
poll, tetapi request tidak overlap; tidak ada leader election baru.

UI memakai satu `setTimeout` setelah request selesai, normal sekitar
10 detik; ini bukan interval yang menumpuk request. Poll tunggal `sync`
memuat heartbeat + state. Error berturut-turut memberi backoff 20/40/60
detik; sukses kembali ke 10 detik. Fokus/online/visibility visible segera
meminta sync; bila sedang busy, refresh dikoaleskan sampai request selesai.
Mutasi langsung menampilkan snapshot yang dikembalikan server.

Form masuk mengikuti follow-up registrasi: `entry-form` hanya memuat
spreadsheet + nama + submit `join` (**Gabung server**). Submit mencegah
navigasi default; tidak ada handler click join terpisah, sehingga Enter dan
klik tidak menggandakan perintah. Jika sesi sudah tersimpan, `run('join')`
memulihkannya, bukan membuat identitas baru. Endpoint/init tetap di
`details#setup` tertutup; ini presentasi pengelola, bukan batas otorisasi.

`registration-fields` disembunyikan bila sesi tersimpan, dan `name.required`
dinonaktifkan. `session-recovery` muncul hanya untuk sesi tersimpan yang
belum terkonfirmasi, termasuk write ambigu. Kontrol `ready`, `not-ready`,
dan `leave` kini berada dalam `roster`, tersembunyi sampai sesi dikonfirmasi
server, dan disembunyikan lagi saat busy/error ambigu. Snapshot terakhir
boleh tetap tampil sebagai data stale tanpa menyiratkan kontrol sesi aktif.
Pemulihan sukses mengembalikan kontrol; leave/expiry mengembalikan form.
Polling recovery tetap sequential dan memakai pending request yang sama.

Input/change endpoint atau spreadsheet langsung menginvalidasi generasi
response, menghentikan timer, dan menyembunyikan roster/kontrol lama tanpa
request jaringan. Memilih server dengan sesi tersimpan memperlihatkan
pemulihan saja, bukan auto-join/poll. Refresh halaman tetap auto-resume.
Hook DOM lama serta `mountRegistration`, `run`, `renderRoster`, `unmount`
dipertahankan untuk integrasi layer game; tidak ada perubahan protokol backend.

Tombol/input disabled saat busy, ready hanya tersedia bagi sesi aktif,
nama ditulis lewat `textContent`. Snapshot lama tetap terlihat saat koneksi
gagal dengan peringatan eksplisit bahwa data mungkin stale. UI tidak
mengklaim siap/game/keluar sebelum konfirmasi. Poll berhenti saat leave
terkonfirmasi, sesi ditolak, pilihan server berubah, atau `unmount()`.
Unmount melepaskan event listener dan mengabaikan hasil request terlambat.
Perubahan pilihan server juga menginvalidasi generasi response lama.

**Tab background dapat di-throttle atau dibekukan browser.** Kehilangan
heartbeat 60 detik tetap dapat mengeluarkan pemain walau tab masih terbuka.
Kembali fokus meminta sync tetapi tidak menghidupkan kembali sesi expired.
Jaringan/Google lambat dan backoff juga dapat menyebabkan expiry. Jangan
menjanjikan presence real-time atau deadline timer browser yang presisi.

## Validasi dan batas deployment

Jalankan `npm run check`, `npm test`, `npm run test:coverage`, dan
`npm run build:apps-script`. Coverage wajib mencapai 100% baris dan cabang pada seluruh
sumber JavaScript produksi, termasuk lobby; workflow test dan Pages memakai
gate yang sama. Coverage penuh bukan jaminan semua keadaan domain atau bug teruji.
Test deterministik mencakup boundary 60 detik, cleanup yang bertahan pada
error, ready reset versus join/leave biasa, dedupe/eviction, kredensial salah,
capacity/nama NFC setelah expiry, dan reserved-cell isolation.
Fake layanan Google dan artifact VM **bukan** validasi Google/CORS live.
Test frontend memakai Node runner/fake DOM, timers, storage dan transport
tanpa dependency browser baru. Cakupan mencakup lost-ready-response,
cross-tab serialization, resume, backoff/fokus, disabled controls, stale
identity/revision/selection, leave dan unmount. Test juga menolak snapshot
inisialisasi dari server berbeda atau revision lama, menangani kegagalan
storage saat recovery, dan memeriksa refresh hanya saat tab kembali terlihat.
Skenario tambahan mencakup ready tanpa sesi/nilai non-boolean/write tertunda,
counter sesi legacy, error terlambat setelah pilihan berubah atau unmount,
serta fault injection clock pada guard fase. Guard fase terakhir tidak dapat
dicapai oleh state normal yang lolos validator lobby; test menyuntikkan korupsi
setelah validasi awal dan memastikan cleanup dilewati serta state ditolak,
bukan mengklaim dukungan fase game.

Repo sudah publik atas permintaan pengguna dan Pages memakai workflow,
namun publikasi perubahan tetap menunggu merge yang disetujui ke `main`.
Tidak ada endpoint Apps Script `/exec`, otorisasi akun game, atau spreadsheet
uji nyata yang tersedia pada implementasi ini. Validasi Google/CORS live
tetap terblokir; ikuti smoke test registrasi lalu uji:

1. Dua sampai empat profil browser: ready/not-ready terlihat lintas profil
   setelah sync; semua siap tetap lobby pada layer ini.
2. Leave satu profil mempertahankan ready pemain lain. Join pengganti belum
   siap, tanpa mereset yang lain.
3. Hentikan heartbeat satu profil 60 detik. Request profil lain menghapusnya
   dan mereset semua yang tersisa. Tab expired tidak bisa ready/heartbeat/
   leave pemain lain; UI memberi alasan dan nama boleh dipakai kembali.
4. Putuskan response setReady setelah server commit, lalu refresh/pulihkan.
   Identity tetap, request yang sama dicoba lagi, keputusan yang lebih baru
   tidak dibalik. Cek permission/quota/network failure tampil eksplisit.
