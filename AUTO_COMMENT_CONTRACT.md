# Kontrak Auto Komen Menfess

Status: terkunci untuk DEV-006 (domain contract)

Dokumen ini mendefinisikan perilaku produk Auto Komen Menfess sebelum schema, API,
bot callback, dan Telegram engine dibuat. Istilah dan state di sini menjadi acuan
untuk unit berikutnya.

## Istilah

- **Divisi**: konfigurasi milik user pada satu akun Userbot. Memiliki nama,
  keyword, satu atau lebih template komentar, dan mode kerja.
- **Channel target**: channel yang dipantau untuk Divisi tersebut. Discussion
  target harus tersedia sebelum komentar dapat direncanakan.
- **Kandidat menfess**: snapshot sebuah post yang match dengan Divisi, keyword
  yang match, dan template komentar yang terpilih pada saat itu.
- **Tepat**: keputusan user bahwa kandidat relevan dan boleh dikomentari.
- **OOT**: keputusan user bahwa kandidat tidak relevan dan tidak boleh dikomentari.

Keyword adalah dasar deteksi; template komentar adalah isi reply. Template tidak
dipakai sebagai dasar match.

## Mode Divisi

| Mode | Default | Setelah post match |
|---|---:|---|
| `APPROVAL_REQUIRED` | Ya | Buat kandidat `PENDING_REVIEW`, kirim notifikasi bot Tepat/OOT, tanpa command Telegram. |
| `AUTO_SEND` | Tidak | Buat kandidat `COMMENT_QUEUED` dan satu command outbox untuk engine akun user. |

Mode `AUTO_SEND` tetap memakai deduplikasi, lease akun, outbox, dan error state
yang sama. Ia bukan jalur bypass Telegram engine.

## Preparation channel dan grup diskusi

Sebelum monitoring dimulai, engine harus resolve channel target beserta linked
discussion dan memastikan akun Userbot sudah menjadi member grup diskusinya.
Jika Telegram meminta persetujuan admin, target masuk `WAITING_APPROVAL` dan
tidak dianggap gagal. Pemeriksaan membership berikutnya tidak boleh mengirim
request join baru; setelah disetujui target otomatis menjadi `READY`.

Matcher hanya boleh membuat kandidat dari target aktif berstatus `READY`.
Outbox komentar juga wajib menahan command jika target dinonaktifkan, kembali
memerlukan validasi, menunggu persetujuan, atau sudah berpindah ke akun lain.

## State kandidat

```text
APPROVAL_REQUIRED:
  PENDING_REVIEW --Tepat--> APPROVED (audit keputusan) --> COMMENT_QUEUED
  PENDING_REVIEW --OOT----> OOT

AUTO_SEND:
  COMMENT_QUEUED --> COMMENT_SENT | COMMENT_FAILED | SIDE_EFFECT_UNCERTAIN

Setelah Tepat:
  COMMENT_QUEUED --> COMMENT_SENT | COMMENT_FAILED | SIDE_EFFECT_UNCERTAIN
```

`APPROVED` adalah audit decision yang ditulis atomik bersama perubahan ke
`COMMENT_QUEUED` dan penciptaan command outbox; tidak ada celah proses yang
memungkinkan kandidat approved tanpa command atau command tanpa approval.

## Invarian wajib

1. `APPROVAL_REQUIRED` tidak boleh membuat command sebelum Tepat.
2. OOT tidak boleh membuat command dan tidak boleh memicu retry pengiriman.
3. Callback Tepat/OOT hanya sah sekali. Callback ulang menghasilkan
   `ALREADY_DECIDED` tanpa command kedua.
4. Satu kandidat unik untuk `(division, akun, channel, post)`.
5. Command komentar unik untuk satu kandidat dan memakai idempotency key yang
   sama sepanjang retry/restart.
6. Snapshot template, keyword match, channel, dan post tidak ikut berubah saat
   Divisi diedit sesudah kandidat dibuat.
7. Bot hanya mencatat keputusan. Hanya engine yang memegang session akun user
   yang dapat mengirim komentar Telegram.
8. `SIDE_EFFECT_UNCERTAIN` tidak boleh di-retry otomatis.

## Batas unit ini

DEV-006 hanya mengunci domain contract dan test. Pemilihan template ketika satu
Divisi punya beberapa template belum diasumsikan: pipeline deteksi berikutnya
harus memasok template yang sudah dipilih lalu contract menyimpannya sebagai
snapshot. Pilihan produk untuk strategi pemilihan (default, acak, atau giliran)
akan dibuat eksplisit sebelum DEV-009.
