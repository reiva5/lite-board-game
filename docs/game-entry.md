# Kartu 100: game entry (layer 3, final)

PR ini ditumpuk langsung di atas branch lobby `reiva5-lobby-sync-kartu-100`,
bukan `main` atau registration. Layer ini mengakhiri fitur pada **placeholder
game tersinkron**, bukan game kartu yang dapat dimainkan. Tidak ada kartu,
dealing, giliran, skor, host, kick, spectator, rematch, atau tombol Start.
API library `src/` tidak berubah.

## Kontrak state final

SchemaVersion tetap 1. State lobby layer 1/2 tetap valid, termasuk pemain lama
tanpa readyVersion (dibaca sebagai 0). State game memperluas private dan public
root dengan field berikut:

```text
phase: "game"
gameId: UUID backend
participantIds: [id pemain, ...] dalam urutan players saat start
startedAt: integer timestamp server (ms)
```

Ketiga field wajib hanya untuk fase game; metadata game pada lobby ditolak.
Game wajib memiliki 2-4 pemain siap dan participantIds persis sama dengan
urutan/isi players (tanpa ID duplikat, tambahan, atau hilang). Validator private
tetap ketat terhadap semua key; validator browser memeriksa metadata fase lalu
menyalin hanya field publik. Digest, retries, dan field provider tambahan
tidak bocor lewat snapshot publik; secret browser tetap disimpan lokal untuk
reconnect, tidak dikembalikan server. State corrupt tidak diinisialisasi
ulang, ditimpa, atau diperbaiki diam-diam.

## Start atomik dan lifecycle

Semua request memakai domain yang sama pada Node dan artifact Apps Script.
Runtime tetap memegang script lock 5000 ms sepanjang read/RMW, write reserved
`Game100State!A1`, flush, dan release di finally. Tidak ada endpoint baru/range
generik; spreadsheet lain/sel lain tetap tidak disentuh.

Sebelum menyelesaikan request sukses, server memeriksa lobby terkini. Jika
jumlah pemain 2-4 dan semuanya siap, server mengubah phase, menghasilkan gameId,
membekukan participantIds, dan mengisi startedAt dalam **satu penulisan** bersama
keputusan/membership/retry metadata. Revision naik sekali untuk seluruh request.
Lobby kosong, satu pemain, atau ada pemain belum siap tidak memulai.
Lobby lama yang sudah semuanya siap dapat bertransisi pada request valid
pertama setelah backend layer 3 dipasang.

Cleanup timeout tetap **sebelum** heartbeat/ready/membership dan start check.
Boundary tetap `>=60000` ms. Hapus pemain expired dan reset readiness/counter
seluruh survivor sebelum memeriksa start. Expiry tidak dapat memicu start;
request lama ready juga tidak dapat membatalkan reset readiness. Sebaliknya,
leave eksplisit mempertahankan ready survivor dan bisa memulai game jika
minimal dua survivor semuanya siap.

Urutan lock menentukan pemenang race: join sebelum final-ready menambah pemain
belum siap sehingga mencegah start; final-ready lebih dulu menolak late join.
Leave sebelum final-ready memperbarui roster terlebih dahulu; setelah start,
leave peserta ditolak. Tidak ada read state atau keputusan start dari browser.

Sesudah game tersimpan:

- Cleanup lobby tidak berjalan, termasuk setelah 60 detik/jauh lebih lama.
  players, readyVersion, participantIds, startedAt dan gameId tetap. Sync,
  resume, initialize, dan pemulihan join peserta tidak menulis heartbeat baru.
- `resume`/`sync` dengan kredensial peserta sah mengembalikan snapshot game
  yang sama; join dengan secret/nama peserta aktif juga memulihkan identitas.
- Join baru serta leave/setReady baru peserta mendapat `GAME_STARTED`, bukan
  `INVALID_SESSION`. Kredensial salah tetap `INVALID_SESSION`; serverId salah
  tetap `SERVER_CHANGED`. Tidak ada jalur kembali ke lobby.
- Exact retry dalam history 32 record tetap mendapat snapshot terbaru, tidak
  mengeksekusi ulang efek. Leave yang benar-benar selesai sebelum start tetap
  mengembalikan left:true pada retry, tanpa mengubah peserta game. Ready lama
  yang ter-evict mendapat GAME_STARTED dan tidak mengubah apa pun. Join lama
  peserta tetap dipulihkan melalui secret meskipun record ter-evict.
- History/fingerprint join/leave tetap kompatibel; setReady tetap mencakup
  nilai dan versi. Anti-stale readyVersion tidak dihapus atau diganti oleh
  dedupe window. Tidak ada gameId kedua karena retry/error transport.

Outcome cleanup yang berubah disimpan/flush walau request kemudian ditolak.
Error transport/provider setelah commit tetap ambigu bagi browser; coba ulang
request tersimpan, bukan membuat identitas baru. Jaminan ini mengasumsikan
semua penulis memakai deployment script/lock yang sama; editor manual/proyek
Apps Script lain tidak tunduk pada lock ini.

## Browser dan placeholder

Client masih menyimpan pending join/leave/setReady sebelum mengirim, dalam
antrean dan Web Lock yang sama. Pada GAME_STARTED yang definitif, pending
control dibersihkan **tanpa menghapus secret/serverId/playerId/revision/counter
peserta**. Error tetap disampaikan secara eksplisit; UI segera menjadwalkan
sync untuk mengambil game. Reload saat pending akan mereplay command yang sama,
menerima penolakan terminal bila perlu, lalu memulihkan game. Jika storage gagal,
error eksplisit dan pending lama tetap dapat dipulihkan.

Late join yang pasti ditolak dan belum punya playerId membersihkan pending join
saja; itu bukan identitas peserta. NETWORK_ERROR, provider failure, respons
rusak, dan write ambigu tetap mempertahankan pending. SESSION_ENDED,
INVALID_SESSION, dan SERVER_CHANGED tetap membatalkan sesi sesuai layer lobby.

Polling sequential ~10 detik, backoff 20/40/60, fokus/online/visibility refresh,
revision/identity/selection guards, serta unmount tetap berlaku. Tidak ada
keputusan client berdasarkan menghitung ready. Snapshot phase game merender
placeholder berbahasa Indonesia dengan heading yang accessible, ID game dan
nama peserta tetap melalui textContent. Tidak ada kartu palsu atau janji
permainan sudah playable. Tombol ready/not-ready/leave tersembunyi dan
dinonaktifkan, serta handler-nya dihambat saat snapshot game sudah diketahui.
Form nama/join juga tersembunyi untuk peserta tersimpan maupun snapshot game
yang dibaca melalui initialize tanpa identitas; name.required dimatikan agar
input tersembunyi tidak menghalangi validasi browser. Resume/sync tetap
tersedia; refresh memuat sesi yang sama. Respons lobby lama tidak mengganti
game baru. Aset tetap relatif untuk `/lite-board-game/`.

UX registrasi sederhana dari parent lobby memakai satu semantic submit
entry-form (preventDefault, tanpa listener click join). `run('join')` untuk
identitas tersimpan diarahkan ke resume, termasuk game; bukan pendaftaran
pemain kedua. Endpoint/init tetap dalam details#setup yang tertutup.
session-recovery hanya muncul bila identitas tersimpan belum terkonfirmasi,
termasuk setelah error ambigu atau GAME_STARTED sebelum sync. Ready/leave tidak
terlihat saat busy/error dan tidak pernah muncul kembali untuk fase game.
Input/change pilihan server membatalkan generasi respons/roster/timer tanpa
request jaringan; memilih ulang server game tersimpan hanya menunjukkan
pemulihan, sedangkan refresh halaman tetap auto-resume.

## Verifikasi dan blocker deployment

Jalankan `npm run check`, `npm test`, `npm run build:apps-script`, dan
`git diff --check`. Tes deterministik mencakup 2/3/4 pemain, pencegahan start,
lock contention dan kedua urutan membership/final-ready, leave-triggered start,
timeout reset, replay/eviction, reconnect lama, late join, corrupt metadata
tanpa overwrite, artifact VM, lost final-ready response, terminal pending
rejection/storage failure, auto-switch UI/fokus/refresh, disabled controls,
dan respons lobby stale.

Fake Google/DOM/transport dan artifact VM **bukan** bukti integrasi Google/CORS.
Koordinator akan menjalankan harness browser multi-client terisolasi; layer ini
tidak menambah dependency Playwright. Belum tersedia endpoint `/exec`, otorisasi
akun khusus game, atau spreadsheet disposable yang dibagikan. Smoke test Google
live tetap **BLOCKED**. Tidak ada merge/deploy produksi/perubahan hosting.

Sesudah prasyarat tersedia, lakukan smoke test registrasi lalu 2-4 profil:
semua ready harus menerima gameId/participantIds sama melalui mutasi atau poll;
refresh/offline >60 detik harus memulihkan game yang sama; pemain kelima ditolak;
perintah leave/ready yang tertunda tidak menghapus identitas peserta. Putuskan
response final-ready setelah commit, ulangi, dan pastikan gameId tidak berubah.
