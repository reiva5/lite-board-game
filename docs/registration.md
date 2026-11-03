# Kartu 100: registrasi (layer 1)

Frontend yang dituju: **https://reiva5.github.io/lite-board-game/** dari `web/`
di repo ini. Backend: satu **standalone Apps Script**, dijalankan sebagai akun
Google khusus game. Pemain tidak login Google. Tidak memakai HTMLService,
`google.script.run`, server Node produksi, atau repo hosting lain.

Layer ini hanya inisialisasi, daftar unik, pulihkan sesi, keluar, dan konfirmasi
roster. Minimum kelompok yang dituju 2, maksimum 4; registrasi pertama tentu boleh
berisi satu pemain. Belum ada ready, heartbeat, timeout, polling, auto-start,
layar permainan, atau aturan kartu. `ready: false` dan `lastSeenAt` dicadangkan
untuk layer berikutnya; resume **tidak** mengubah timestamp.

## Status deployment: belum live

Pengujian lokal menggunakan fake Google services, fake Fetch, fake DOM, dan VM
yang menjalankan artifact Apps Script yang benar-benar dihasilkan dari source.
Ini **bukan** bukti CORS browser/Google asli atau deployment live.

Prasyarat yang belum tersedia:

- Endpoint Apps Script `/exec` milik akun game, otorisasi akun itu, dan
  spreadsheet disposable yang dibagikan sebagai Editor kepada akun tersebut.
- Pages aktif untuk repo ini. Repo privat; percobaan konfigurasi Pages oleh
  koordinator menghasilkan HTTP 422: `Your current plan does not support GitHub
  Pages for this repository.` GET situs saat pemeriksaan koordinator masih 404.
  Diperlukan paket GitHub yang mendukung Pages untuk repo privat, atau keputusan
  eksplisit pengguna mengenai alternatif. Implementasi ini **tidak** mengubah
  visibility repo maupun target hosting.

Jangan menyatakan deployment berhasil hanya karena CI hijau atau curl berhasil.

## Menyiapkan backend

1. Gunakan akun Google **khusus game**, tanpa spreadsheet pribadi/pekerjaan.
   Buat standalone Apps Script project dari akun itu di script.google.com.
   Gunakan satu project untuk seluruh server; jangan membuat deployment penulis
   terpisah yang tidak berbagi script lock.
2. Jalankan `npm run build:apps-script` (Node 22+). Hasil
   `dist/apps-script/Code.gs` menggabungkan `game100/domain.js`,
   `apps-script/runtime.js`, dan `apps-script/entry.js`; tidak ada implementasi
   domain kedua. Salin seluruh `Code.gs` ke editor Apps Script dan
   `dist/apps-script/appsscript.json` ke manifest (aktifkan tampilan manifest di
   pengaturan project). Jangan menyalin file ESM mentah satu per satu.
3. Deploy > New deployment > Web app: **Execute as: Me** (akun game),
   **Who has access: Anyone** (anonim, bukan hanya pengguna Google).
   Otorisasi scope Google Sheets dari akun game. Jika kebijakan organisasi
   melarang akses anonim, deployment ini tidak cocok; jangan menganggap halaman
   login sebagai respons API. Setelah perubahan backend, buat versi baru dan
   edit deployment agar memakai versi itu.
4. Simpan URL kanonis `https://script.google.com/macros/s/DEPLOYMENT_ID/exec`.
   URL ini publik, bukan secret. Masukkan melalui input endpoint UI atau
   `web/config.js` pada properti `endpoint`. Jangan isi OAuth token, password,
   session secret, atau key akun Google pada config/frontend.
5. Pemilik setiap spreadsheet membagikan akses **Editor** ke alamat akun game.
   Tidak perlu dan tidak ada allowlist ID spreadsheet manual. Buka frontend,
   masukkan tautan Google Sheets dan klik **Inisialisasi server**. Setelah server
   mengonfirmasi, daftar nama dengan tombol berbeda.

Hanya URL HTTPS `docs.google.com/spreadsheets/d/ID` dengan suffix kanonis
`edit`, `view`, `preview`, atau `copy` diterima (query/hash sharing opsional).
Backend mengekstrak ID lalu menggunakan `SpreadsheetApp.openById`, tidak fetch
URL pengguna dan tidak menerima range/aksi spreadsheet generik.

## Menyiapkan GitHub Pages

Setelah blocker paket/akses di atas diselesaikan, Settings > Pages > Build and
deployment > Source: **GitHub Actions**. Izinkan environment `github-pages`
deploy dari `main`. Workflow `.github/workflows/pages.yml` berjalan hanya pada
`main` atau manual dispatch dengan ref `main`, menjalankan syntax check + seluruh
test sebelum upload **hanya `web/`** dan deploy artifact itu. Tidak ada source
backend, library, test, atau file repo lain dalam artifact Pages.

Assets relatif (`./app.js`, `./style.css`), tanpa SPA route/rewrite. Jangan
memasukkan path root `/app.js` yang merusak project Pages `/lite-board-game/`.
Frontend memerlukan HTTPS, ES modules, Web Crypto, localStorage dan Web Locks
(browser modern). Web Locks menyerialkan pembuatan identitas antartab pada origin
yang sama; browser tanpa dukungan ini menampilkan error, tidak membuat sesi
berisiko. Mode penyimpanan privat/terblokir/quota penuh bisa menggagalkan sesi.

localStorage bukan vault: script pada origin yang sama dapat membacanya.
Project Pages lain di `reiva5.github.io` berbagi origin yang sama walau path
berbeda. Jangan menaruh script/proyek tidak tepercaya pada origin itu; isolasi
session key per server tidak melindungi dari XSS atau script origin yang jahat.

## Kontrak API untuk layer lobby

Satu POST ke `/exec`, body JSON sebagai **string text/plain**, tanpa header auth
atau `Content-Type: application/json`. `fetch` diberi `mode: 'cors'`,
`credentials: 'omit'`, `redirect: 'follow'`, `cache: 'no-store'`. Browser memberi
Content-Type sederhana untuk string. Credential hanya di body, tidak di URL.
`ContentService` mengarahkan ke `script.googleusercontent.com`: ikuti redirect,
jangan menyimpan URL redirect sementara.

Request sederhana menghindari OPTIONS, tetapi **tidak membuktikan respons dapat
dibaca lewat CORS**. NETWORK_ERROR menyebut jaringan/CORS/timeout dan menyatakan
hasil belum pasti. HTTP_ERROR, INVALID_RESPONSE (misalnya HTML login),
PROVIDER_ERROR, dan error domain tetap eksplisit. Tidak ada opaque `no-cors`,
JSONP, atau success-shaped fallback. Respons:

```json
{"ok":true,"data":{"state":{"schemaVersion":1,"serverId":"server-generated-id","revision":1,"phase":"lobby","players":[{"id":"server-generated-player-id","name":"Ayu","ready":false,"lastSeenAt":123456789}]},"playerId":"server-generated-player-id","left":false}}
```

```json
{"ok":false,"error":{"code":"NAME_TAKEN","message":"Nama sudah dipakai di server ini."}}
```

Semua request: `action`, `requestId` (16-128 karakter ASCII alfanumerik/`_`/`-`),
`spreadsheetUrl`. Field lain yang tidak dikenal ditolak. Request maksimum 4096
UTF-16 code units.

| action | Field tambahan | Hasil/perilaku |
| --- | --- | --- |
| `initialize` | Tidak ada | Membuat server hanya bila reserved A1 kosong/tab tidak ada. Jika sudah valid, tidak mengubah apa pun. `data` hanya berisi `state`; tidak mendaftarkan pemain. |
| `join` | `name`, `secret`; `serverId` opsional | Daftar unik + capacity check dalam lock yang sama. Mengembalikan state publik, `playerId`, `left:false`. Secret yang sama pada pemain aktif memulihkan identitas, tidak membuat duplikat. |
| `resume` | `serverId`, `playerId`, `secret` | Verifikasi seluruh identitas; snapshot publik tanpa mutasi/timestamp update. |
| `leave` | `serverId`, `playerId`, `secret` | Hapus hanya pemain terautentikasi; data pemain lain tetap. Mengembalikan `left:true`. |

`secret` adalah 32 byte random browser dalam 64 karakter hex kecil (256 bit);
backend hanya menyimpan SHA-256 digest. Nama NFC + trim, 1-40 UTF-16 code units,
tanpa Unicode Cc/Cf; keunikan `name.normalize('NFC').trim().toLowerCase()`.
Ini lowercase Unicode biasa, bukan full Unicode case-folding atau pencegahan
homoglyph. Nama **bukan kredensial**. ID pemain/server dibuat backend.

Client public module: `web/client.js` mengekspor `createRegistrationClient`,
`postCommand`, `validateResult`, `ClientError`, `endpointUrl`, `sheetId`,
`randomHex`. `createRegistrationClient({ endpoint, spreadsheetUrl, storage,
send?, random?, exclusive? })` mengembalikan `initialize()`, `join(name)`,
`resume()`, `leave()`, `hasSession()`, `lockKey`. `send(command)` opsional
mengembalikan data hasil, bukan envelope; default menggunakan `postCommand`.
`exclusive(operation)` harus menyerialkan operasi antartab bila dipakai di
browser; UI memasangnya dengan `navigator.locks.request`. Jangan memakai default
tanpa lock untuk integrasi browser multi-tab.

`mountRegistration` di `web/ui.js` memasang handler UI dan auto-resume saat refresh
untuk endpoint + spreadsheet terakhir. Tidak ada polling. `renderRoster` memakai
`textContent` untuk nama, tidak memakai `innerHTML`.

### Persistensi, retry, dan concurrency

Reserved storage **`Game100State!A1`** (bukan `State!A1`):

```text
schemaVersion: 1
serverId: ID backend
revision: integer aman nonnegatif, bertambah hanya saat join/leave
phase: "lobby"
players: [{id, name, nameKey, secretDigest, ready:false, lastSeenAt}]
retries: [{requestId, action, secretDigest, fingerprint, playerId}]
```

Marker, versi, keys root/nested, tipe, normalisasi nama, keunikan, panjang
array, identitas, dan batas payload divalidasi sebelum perubahan. Tidak menerima
formula di reserved A1. JSON corrupt/versi lain tidak direset otomatis. State
dibatasi **48000 UTF-16 code units**, di bawah batas sel Sheets 50000.
Sel/tab lain tidak dibaca atau ditulis. Script boleh membuat tab reserved jika
belum ada; tidak menghapus/menimpa tab `State` maupun data lain.

Setiap snapshot dan read-modify-write mengambil
`LockService.getScriptLock().tryLock(5000)`. Flush dilakukan sebelum release,
termasuk setelah error provider yang mungkin telah membuffer mutasi; `finally`
melepas lock bahkan bila flush gagal. `getDocumentLock()` bukan pengganti:
nilainya null untuk standalone web apps. Lock ini **script-wide**, sehingga server
berbeda ikut berebut lock; bukan kunci per spreadsheet. Editor manual dan project
Apps Script penulis lain tidak mengikuti lock ini.

Join/leave memiliki request ID dan fingerprint yang dideduplikasi dalam 32
mutasi terakhir per server; metadata tidak tumbuh tanpa batas. Request ID sama
dengan body/credential berbeda ditolak. Hasil retry menyertakan **snapshot
terbaru**, bukan replay roster lama. Join dengan secret pemain aktif yang sama
tetap pulih setelah dedup history dieviksikan. Retry leave dipastikan idempotent
selama tombstone masih dalam history; setelah 32 mutasi lain, sesi sudah tidak
ada dan server dapat memberi INVALID_SESSION. Jangan menjanjikan retry abadi.

Browser menyimpan secret dan request join **sebelum** mengirim. Key localStorage:
`game100:v1:<endpoint>:<spreadsheetId>`; record pending pertama menemukan serverId
dari respons lalu menyimpan `serverId`/`playerId`. ServerId diverifikasi pada
resume/leave. Penggantian backend/storage server tidak bisa diam-diam memindahkan
identitas. Respons hilang/timeout/provider error/invalid JSON mempertahankan
pending command; gunakan **Pulihkan / ulangi sesi**, jangan membuat identitas baru.
Setelah respons leave terkonfirmasi barulah record dihapus.

Penolakan join yang pasti tanpa mutasi (`INVALID_NAME`, `NAME_TAKEN`,
`SERVER_FULL`, `NOT_INITIALIZED`) membersihkan pending agar nama/input bisa
diperbaiki. Error lain mempertahankan record. Jangan membagikan secret atau
menghapus data browser sewaktu masih terdaftar: tanpa secret identitas tidak dapat
diklaim berdasarkan nama. Layer ini tidak punya reset/admin kick/expiry; sesi
yang benar-benar kehilangan secret memerlukan penanganan manual pemilik
spreadsheet setelah koordinasi, bukan impersonasi via nama.

### Batas keamanan dan operasional

Ini akses informal berbasis tautan, **bukan** verifikasi pemilik Google. Siapa pun
yang mengetahui tautan spreadsheet dapat mencoba initialize/join bila akun game
memiliki akses edit. Initialize terhadap server valid juga menampilkan roster.
Editor spreadsheet dapat melihat digest dan memodifikasi semua state, termasuk
merusak invariant. Tidak ada kerahasiaan kartu terhadap editor; jangan memakai
model ini untuk data sensitif/kompetisi berhadiah.

Akun game menjalankan API dengan kewenangannya sendiri. Tidak ada allowlist
manual; karena itu isolasi akun khusus game adalah batas penting. Jangan
membagikan spreadsheet non-game ke akun itu. Scope Sheets bukan pembatas
per-server. Endpoint anonim publik **bukan** batas anti-abuse: capacity 4,
ukuran request/state, bounded retry history dan lock wait membatasi pekerjaan
satu request, tetapi tidak membatasi jumlah request/total server. Serangan spam
dapat menghabiskan quota Sheets/Apps Script, waktu eksekusi, concurrency atau
storage akun game. Tidak ada rate limiter terdistribusi/CAPTCHA pada layer ini.
Pantau quota/error akun, batasi sebaran endpoint, dan nonaktifkan deployment bila
disalahgunakan. Jangan mengklaim siap untuk trafik publik besar.

## Smoke test live yang wajib sebelum dipakai

Setelah seluruh prasyarat tersedia, lakukan dari URL Pages yang sebenarnya,
bukan hanya curl atau localhost:

1. Buka DevTools Network di browser tanpa login Google. Isi endpoint `/exec`
   dan spreadsheet uji yang dibagikan ke akun game. Initialize harus menunjukkan
   JSON yang dapat dibaca frontend setelah redirect ContentService, bukan
   halaman login, response opaque, atau pesan CORS.
2. Pastikan hanya `Game100State!A1` terisi; sentinel pada `State!A1` dan sel lain
   tetap. Initialize lagi tidak mengubah state/revision.
3. Daftar nama di dua profil/perangkat terpisah; coba nama sama dengan variasi
   kapitalisasi/NFC/spasi, lalu isi sampai 4. Pemain kelima ditolak.
4. Refresh mempertahankan playerId. Hilangkan respons join **setelah server
   menulis** (misalnya DevTools interception), lalu pulihkan; hanya satu pemain
   dan playerId tetap sama. Uji dua tab browser bersamaan juga.
5. Keluar menghapus hanya pemain itu; refresh tidak mendaftar lagi. Hilangkan
   respons leave dan ulangi: hasil akhirnya tetap keluar.
6. Cabut izin akun game; UI menampilkan kegagalan dan tidak mengklaim sukses.
   Pulihkan izin dan ulangi request yang sama. Cek pesan saat endpoint salah,
   backend non-anonim, atau jaringan gagal.
7. Catat browser, URL Pages, deployment version, hasil redirect/CORS, dan hasil
   tes di atas. Jangan menaruh credential/secret atau isi spreadsheet dalam log
   publik. Baru setelah ini integrasi Google/Pages boleh disebut terverifikasi.

Jalankan `npm run check` dan `npm test` untuk regresi deterministik. Test library
lama tetap dipertahankan. Test baru mencakup domain, runtime dengan lock
contention reentrant, permission/quota/flush failure, no-overwrite, artifact VM,
transport, localStorage, cross-tab sequencing fake, dan UI fake DOM. Fake tidak
mensimulasikan izin/quota Google sesungguhnya atau kebijakan CORS browser.
