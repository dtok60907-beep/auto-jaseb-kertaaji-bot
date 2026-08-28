# Kontrak Materi Jasa Sebar

Status: terkunci untuk DEV-007 (domain contract)

## Pilihan materi

User mengatur Grup LPM tujuan dan memilih satu atau lebih materi sebar:

| Jenis | Input user | Cara engine mengirim |
|---|---|---|
| `TEXT` | Wording manual | Mengirim teks persis dari snapshot materi. |
| `FORWARD` | Link post dari channel Telegram publik | Meneruskan post sumber dari channel ke Grup LPM. |

Link forward hanya menerima bentuk post channel publik:
`https://t.me/nama_channel/123`. Link private, invite link, dan link tanpa nomor
post ditolak sebelum disimpan.

## Attribution sumber dan identitas pengirim

Forward memiliki toggle `sourceAttribution`:

- `SHOW_SOURCE`: engine meminta Telegram menampilkan asal channel/post pada forward.
- `HIDE_SOURCE`: engine meminta Telegram menyembunyikan attribution sumber.

Toggle ini berlaku sama pada pengiriman dari akun Userbot maupun akun worker admin.
Ia **tidak mengubah identitas akun pengirim**: Telegram tetap menampilkan akun yang
benar-benar melakukan pengiriman. Sistem tidak boleh meniru identitas akun lain.

## Invarian wajib

1. Materi hanya salah satu dari `TEXT` atau `FORWARD`; tidak ada payload campuran.
2. Materi forward menyimpan referensi sumber yang telah dinormalisasi, bukan link
   mentah yang tidak tervalidasi.
3. Sebelum command forward dibuat, engine pengirim yang terpilih harus preflight
   bahwa ia dapat membuka sumber publik, membaca post, dan meneruskannya.
4. Untuk source post yang merupakan album, engine harus resolve semua item album
   terkait lalu forward sebagai satu batch agar caption/media tidak hilang.
5. Setiap command menyimpan snapshot materi dan attribution yang dipilih saat
   command dibuat. Edit materi berikutnya hanya memengaruhi command berikutnya.
6. Penolakan Telegram terhadap forward atau attribution disimpan sebagai error
   per target. Tidak ada fallback diam-diam menjadi teks atau mode attribution lain.
7. `SIDE_EFFECT_UNCERTAIN` tidak boleh diulang otomatis.

## Batas unit ini

DEV-007 belum menghubungkan Telegram atau menyimpan data ke PostgreSQL. Preflight
sumber, snapshot persisten, pemilihan template, dan pengiriman forward dibuat
pada unit database dan engine berikutnya.
