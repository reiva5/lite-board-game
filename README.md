# Spreadsheet state library

Library JavaScript ESM tanpa dependency untuk baca/tulis spreadsheet dan menyimpan
state JSON. Google Sheets adalah adapter pertama; kode inti tidak bergantung pada
provider atau aturan game Nana. Membutuhkan Node.js 22+ (atau bundler/browser dengan
ES modules dan Fetch API).

## Mulai dengan Google Sheets

Aktifkan Google Sheets API pada Google Cloud project, buat spreadsheet dan tab
`State`, lalu dapatkan OAuth access token dengan scope
`https://www.googleapis.com/auth/spreadsheets`. Akun pemilik token harus memiliki
akses edit spreadsheet. Autentikasi, consent, dan refresh token dikelola aplikasi,
bukan library ini. Jangan commit token, memasukkan service-account private key
ke frontend, atau memakai library server ini untuk membagikan token ke pemain.

```js
import {
  createGoogleSheetsAdapter,
  createSpreadsheet,
  createStateStore,
} from '@reiva5/spreadsheet-state';

const spreadsheet = createSpreadsheet(createGoogleSheetsAdapter({
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  accessToken: async () => process.env.GOOGLE_ACCESS_TOKEN,
}));

await spreadsheet.write("'Players'!A1:B2", [
  ['id', 'name'],
  ['p1', 'Alice'],
]);
const rows = await spreadsheet.read("'Players'!A1:B2");
await spreadsheet.append("'Players'!A:B", [['p2', 'Bob']]);
await spreadsheet.clear("'Players'!A2:B3");

const store = createStateStore({ spreadsheet, sheetName: 'State', cell: 'A1' });
await store.initialize({ turn: 0, players: [] });
await store.set('players', [{ id: 'p1', hand: [1, 2, 3] }]);
await store.update('turn', turn => (turn ?? 0) + 1);
console.log(await store.get('turn')); // 1
console.log(await store.getState());
await store.delete('players');
```

Contoh import di atas menggunakan nama paket yang dideklarasikan di `package.json`;
paket belum dipublikasikan ke npm. Dari checkout, gunakan `./src/index.js`,
atau jalankan `npm pack` lalu install tarball yang dihasilkan pada aplikasi lain.
Tab target harus sudah ada; library tidak membuat spreadsheet/tab dan tidak
mengubah format atau struktur kolom.

## API spreadsheet

| Metode | Perilaku |
| --- | --- |
| `read(range)` | Membaca A1 range sebagai array baris; range kosong menghasilkan `[]`. Google Sheets dapat menghilangkan baris/kolom kosong di ujung. |
| `write(range, values)` | Menimpa sel yang dipasok, bukan menghapus seluruh range. |
| `append(range, values)` | Menambah baris setelah tabel logis dalam range. |
| `clear(range)` | Mengosongkan nilai sel tanpa menghapus format. |

`values` harus array dua dimensi persegi panjang, tidak kosong, berisi string,
boolean, atau angka finite. Gunakan `''` untuk mengosongkan satu sel; `null` dan
`undefined` ditolak agar tidak diam-diam melewati sel. Penulisan memakai `RAW`:
`'=SUM(A1:A2)'` tetap teks, identifier seperti `'001'` tidak berubah menjadi angka.
Read memakai `UNFORMATTED_VALUE`; formula yang sudah ada dibaca sebagai hasilnya.
Write/append/clear mengembalikan response JSON dari provider.

Provider lain dapat dipasang melalui `createSpreadsheet(adapter)` dengan empat
metode async `read(range)`, `write(range, values)`, `append(range, values)`, dan
`clear(range)`. Error provider diteruskan ke pemanggil.

## API state

State disimpan sebagai **satu objek JSON dalam satu sel**, bukan satu key per baris.
Sel default adalah `'State'!A1`; nama tab yang mengandung apostrof di-escape.

| Metode | Hasil |
| --- | --- |
| `initialize(initialState = {})` | Mengisi sel hanya jika kosong; mengembalikan state tersimpan. |
| `getState()` | Snapshot seluruh state; sel kosong menghasilkan `{}` tanpa menulis. |
| `setState(object)` | Mengganti seluruh state. |
| `get(key)` / `has(key)` | Membaca nilai / memeriksa keberadaan own key; key hilang menghasilkan `undefined` / `false`. |
| `set(key, value)` | Membuat atau mengganti satu key. |
| `update(key, updater)` | Read-modify-write dengan callback sync/async; key hilang menerima `undefined`. |
| `delete(key)` | Menghapus key, menghasilkan boolean apakah key ditemukan. |
| `clear()` | Menulis `{}` hanya ke sel state. |

Semua mutasi selain `delete` mengembalikan snapshot state sesudah disimpan. Objek
input `set`, `setState`, dan `initialize` disalin saat pemanggilan. Nilai yang
didukung adalah JSON murni: string, boolean, angka finite, `null`, array rapat,
dan plain object. `undefined`, fungsi, BigInt, Date, Map, symbol, accessor, siklus,
dan properti non-JSON ditolak. Root harus objek, key harus string tidak kosong.
Payload maksimum 50.000 UTF-16 code units; tidak ada pemotongan otomatis.

Setiap operasi membaca state terbaru dari spreadsheet, tanpa cache. Antrean
menjamin urutan **hanya dalam satu instance store**, termasuk `Promise.all`.
Jangan memanggil kembali store yang sama dari callback `update` karena callback
tersebut sedang memegang antreannya. Gunakan satu instance pada satu backend
penulis. Banyak instance/proses/pemain yang menulis langsung atau edit manual
bersamaan dapat menyebabkan lost update; ini bukan database transaksional.
Untuk multiplayer, rute-kan mutasi melalui satu backend atau tambahkan locking
eksternal. State ini juga tidak menyembunyikan kartu dari pengguna yang punya
akses ke spreadsheet.

Error jaringan, autentikasi, quota, JSON rusak, dan write gagal tidak diubah
menjadi state kosong. HTTP gagal menghasilkan `SpreadsheetApiError` dengan
`status`; response body tidak dimasukkan ke pesan error untuk menghindari
kebocoran isi spreadsheet. Input tidak valid bisa throw sinkron; kegagalan
operasi async menolak Promise. Kegagalan tidak memblokir operasi berikutnya.
Tidak ada retry otomatis (terutama append yang tidak idempotent).
Penulisan lewat API tidak menjalankan trigger `onEdit` Google Apps Script.

## Pengembangan

```sh
npm test
npm run test:coverage
npm run check
```

Test memakai Node test runner dan fake Fetch/adapter, tanpa credential atau akses
jaringan. `test:coverage` melaporkan coverage kode library, aplikasi, entry point,
dan tooling dengan ambang 100% line dan branch coverage yang juga dijalankan di CI. File test
dan artifact hasil build tidak dihitung sebagai kode produksi. Pemetaan seluruh
file JavaScript ke suite pengujian ada di
[dokumentasi registrasi](docs/registration.md#cakupan-unit-test-javascript).
Integrasi dengan akun Google sungguhan memerlukan token dan spreadsheet uji
sendiri; tidak disertakan atau diasumsikan tersedia.

## Aplikasi Kartu 100 (satu ronde)

Selain library yang API-nya tetap sama, repo ini menyediakan frontend statis
`web/` untuk GitHub Pages dan backend standalone Google Apps Script di
`apps-script/`, dengan domain bersama di `game100/`. Petunjuk setup akun game,
sharing spreadsheet, build/deploy, kontrak API untuk layer lobby, batas keamanan,
dan prasyarat smoke test live ada di
[dokumentasi registrasi](https://github.com/reiva5/lite-board-game/blob/main/docs/registration.md).
Versi placeholder sebelumnya telah dicoba dengan backend Google dan Pages asli;
versi gameplay ini memerlukan deployment baru dan belum diverifikasi live.
[Dokumentasi lobby](./docs/lobby.md) menjelaskan ready/not-ready,
heartbeat/sync sequential dan timeout lobby 60 detik.
[Dokumentasi gameplay](./docs/gameplay.md) menjelaskan auto-start untuk 2-6
pemain, dek 52 kartu, tangan privat 3 kartu, skor meja, giliran, eliminasi,
reshuffle, dan pemenang terakhir yang aktif. Tidak ada skor lintas ronde/rematch.
Game placeholder lama tetap read-only; gunakan spreadsheet baru untuk ronde baru.
