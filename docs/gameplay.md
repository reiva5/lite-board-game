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

Command gameplay mengikat gameId dan nomor giliran yang diharapkan. Request
ulang yang masih tercatat mengembalikan snapshot saat ini, bukan memainkan kartu
dua kali. Setelah history retry ter-evict, nomor giliran lama tetap ditolak.
Seluruh transisi tetap berada dalam read/modify/write/flush script lock yang sama.
