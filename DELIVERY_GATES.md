# Delivery Gates

Dokumen ini mencegah pekerjaan besar terlihat selesai hanya karena code banyak atau build berhasil.

## Unit kerja

Satu unit kerja harus:

- mempunyai satu outcome yang dapat diuji;
- mempunyai acceptance criteria sebelum code;
- mempunyai blast radius file yang terbatas;
- dapat di-review tanpa memahami seluruh project;
- tidak menggabungkan schema, engine, billing, dan UI sekaligus.

Jika unit tidak dapat dijelaskan beserta test-nya dalam satu halaman, unit harus dipecah lagi.

## Gate per unit

1. Contract/spec tercatat.
2. Test happy path dan negative path ditulis.
3. Implementasi minimum dibuat.
4. Static check/lint/typecheck lulus.
5. Unit/integration test lulus.
6. Race, retry, timeout, dan crash point relevan diuji.
7. Security boundary direview.
8. Resource impact diukur bila menyentuh hot path.
9. Error dan observability tersedia.
10. Diff direview terhadap tujuan awal.

Status yang dipakai:

- `NOT_STARTED`
- `IN_PROGRESS`
- `IMPLEMENTED_UNVERIFIED`
- `VERIFIED`
- `BLOCKED`

Hanya `VERIFIED` yang boleh ditampilkan sebagai selesai.

## Gate milestone production

- Semua unit scope berstatus `VERIFIED`.
- Fresh install reproducible.
- Upgrade migration rehearsal berhasil.
- E2E utama lulus.
- Concurrency dan crash recovery lulus.
- Dependency audit tidak mempunyai critical/high exploitable tanpa exception tertulis dan deadline.
- 24-hour soak lulus.
- Backup/restore lulus.
- Monitoring, alert, runbook, dan rollback tersedia.
- Staging deployment sama bentuknya dengan production.

## Aturan perubahan scope

Fitur baru tidak disisipkan ke unit aktif. Fitur masuk backlog, dinilai dampaknya terhadap tujuan akhir, lalu mendapat spec dan gate sendiri. Dengan ini perubahan satu fitur tidak diam-diam merusak modul yang sudah diverifikasi.
