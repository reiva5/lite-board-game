# Kartu 100: satu ronde

## Aturan

- Satu dek 52 kartu tanpa Joker, 2-6 pemain, masing-masing 3 kartu.
- Pemain pertama mengikuti urutan peserta saat start. Arah awal searah jarum jam.
- Total meja mulai 0. Angka 2-8 menambah nilainya; 9 dan J tidak mengubah total;
  10 memilih +10/-10; A memilih +1/+11; K mengatur total menjadi 99.
- Q membalik arah, lalu giliran berpindah sesuai arah baru.
- Dengan 3-6 pemain aktif, J meneruskan ke pemain aktif berikutnya, sesuai
  ketentuan melewati giliran sendiri. Dengan tepat 2 pemain aktif, J dan Q
  memberi giliran lagi kepada pemain yang memainkannya; Q tetap membalik arah.
- Batas atas adalah 100, inklusif. Total boleh negatif: tidak ada batas bawah 0
  dalam spesifikasi. Total tepat 100 tidak otomatis memenangkan permainan.
- Pemain yang memilih kartu/efek yang melewati 100 kalah. Total meja tetap pada
  nilai sah sebelumnya. Kartu pemain kalah masuk discard, tanpa kartu pengganti.
- Saat awal giliran, pemain tanpa opsi kartu legal langsung kalah. Pemeriksaan
  ini dapat mengeliminasi beberapa pemain secara berurutan dalam satu transisi.
- Pemain kalah dilewati. Pemain terakhir yang aktif menang, sekalipun tangannya
  tidak punya langkah legal; permainan sudah terminal sebelum giliran berikut.
- Pemain aktif mengambil satu kartu sesudah memainkan kartu. Jika draw habis,
  discard dikocok kecuali kartu teratas, kemudian draw dilanjutkan.
- Tidak ada nyawa, skor lintas ronde, rematch, atau eliminasi karena disconnect.
  Pengumuman total dilakukan UI berdasarkan hasil server, bukan input manual.

## Rencana commit

1. Kontrak aturan dan state (dokumen ini).
2. Engine kartu dan integrasi command server: dealing, scoring, giliran,
   eliminasi, terminal state, sanitasi tangan, serta test domain/runtime.
3. Client gameplay: validasi snapshot, pending command, stale turn dan recovery.
4. UI: kartu sendiri, pilihan efek, total, arah, giliran, status kalah/pemenang.
5. Dokumentasi upgrade dan validasi pertandingan lengkap; test disertakan pada
   setiap commit implementasi, bukan ditumpuk hanya pada commit terakhir.

## Batas kompatibilitas

Schema registrasi/lobby tetap versi 1. Game baru memperoleh objek `round`
berversi 1; game placeholder lama tanpa `round` tetap dapat dipulihkan sebagai
read-only, tidak di-reset atau diberi kartu diam-diam. Gunakan spreadsheet baru
untuk ronde baru. State rusak tetap ditolak tanpa overwrite.

Backend menyimpan seluruh dek/tangan, tetapi respons publik hanya memuat tangan
peminta yang terautentikasi, jumlah kartu pemain lain, top discard, dan jumlah
draw. Editor spreadsheet masih dapat melihat semua data; ini bukan platform
anti-cheat terhadap pemilik/editor spreadsheet.
Pengocokan menggunakan Fisher-Yates dan `Math.random` di backend, bukan RNG
kriptografis; implementasi ini ditujukan untuk permainan kasual.

Command gameplay mengikat gameId dan nomor giliran yang diharapkan. Request
ulang yang masih tercatat mengembalikan snapshot saat ini, bukan memainkan kartu
dua kali. Setelah history retry ter-evict, nomor giliran lama tetap ditolak.
Seluruh transisi tetap berada dalam read/modify/write/flush script lock yang sama.

## Kontrak ronde dan command

Private `round` menyimpan `version`, `status` (`playing`/`finished`), `tableScore`,
`direction` (1/-1), `turnPlayerId`, `turnNumber`, `hands`, `drawPile`,
`discardPile`, `eliminatedIds`, `winnerId`, `endedAt`, dan `lastMove`.
`hands` mengikuti urutan peserta; setiap tangan aktif berisi 3 kartu dan tangan
kalah kosong. Tepat 52 ID kartu unik harus berada di tangan/draw/discard.
ID kartu memakai rank A/2-10/J/Q/K dan suit S/H/D/C, misalnya `10H`.

Public `round` mengganti tangan/dek privat dengan `hand` peminta,
`players: [{playerId,status,cardCount}]`, `drawCount`, dan `discardTop`.
Initialize tanpa autentikasi tidak pernah mendapatkan tangan pemain.
`lastMove` mengumumkan kartu, pemain, pilihan, skor sebelum/sesudah dan hasil.

`playCard` memakai field autentikasi yang sama dengan sync ditambah:

```json
{
  "gameId": "id-game-yang-dikonfirmasi",
  "turnNumber": 0,
  "card": "AS",
  "choice": 11
}
```

`choice` adalah angka efek: 2-8 sesuai rank, 9/J/Q bernilai 0, A bernilai 1/11,
10 bernilai 10/-10, K bernilai 99 (set, bukan penambahan).
Command harus dikirim dengan `action`, `requestId`, `spreadsheetUrl`, `serverId`,
`playerId`, dan `secret` seperti protokol registrasi.

Kesalahan eksplisit meliputi `INVALID_MOVE`, `NOT_YOUR_TURN`, `STALE_TURN`,
`GAME_CHANGED`, `GAME_NOT_STARTED`, `GAME_UPGRADE_REQUIRED`, dan `GAME_FINISHED`.
Penolakan definitif membersihkan pending gameplay tanpa menghapus identitas.
Kegagalan ambigu mempertahankan command persis sama untuk retry/recovery.
Client UI mengikat aksi ke nomor giliran yang sedang ditampilkan, bukan sekadar
nomor terbaru di storage tab lain. Tidak ada endpoint set-score/set-winner bebas.

## Terminal state dan deployment

Saat satu peserta aktif tersisa: status `finished`, `winnerId` peserta itu,
`turnPlayerId: null`, dan `endedAt` waktu server. Semua command kartu baru ditolak;
sync/resume dan retry kartu yang sudah tercatat tetap dapat membaca hasil tanpa
mutasi ronde. Tidak ada jalur otomatis kembali ke lobby.

Build dengan `npm run build:apps-script`, salin **seluruh** `Code.gs` dan
`appsscript.json`, lalu **Deploy > Manage deployments > Edit > New version**.
Memperbarui source tanpa memilih versi baru tidak memperbarui endpoint `/exec`.
Frontend dan backend harus diperbarui bersama. Upgrade memerlukan spreadsheet
baru untuk ronde kartu; jangan menghapus `round` atau mengosongkan state live.
Untuk kembali ke versi placeholder, jangan jalankan backend lama terhadap
spreadsheet yang sudah memiliki `round`; validator lama tidak mendukungnya.

## Validasi

`npm run check`, `npm run test:coverage`, dan `npm run build:apps-script` tetap
digunakan. Ambang line/branch tetap 100% pada semua 15 source produksi.
Pengujian mencakup pertandingan penuh dengan move budget dan RNG deterministik,
dua hingga enam peserta, kartu spesial, duel, dead hand berantai, giliran pemain
kalah, reshuffle yang mempertahankan kartu teratas, konservasi dek, privasi,
terminal immutability, retry setelah respons hilang dan eviction, storage
failure, snapshot corrupt, dan recovery placeholder lama.

Tidak ada jaminan semua urutan kartu selalu berakhir dalam batas giliran tetap:
pemain dapat sengaja memperpanjang permainan dengan kartu netral/pengurangan.
Move budget adalah pengaman pengujian, bukan aturan timeout ronde.
