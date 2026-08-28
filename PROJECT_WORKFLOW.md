# Project Operating Workflow

Status: binding
Owner: project implementation
Scope: seluruh development, verification, deployment, dan maintenance sistem Jaseb Client

Dokumen ini mengatur cara kerja proyek. Jika kecepatan bertentangan dengan workflow ini, pekerjaan diperlambat atau dipecah; gate tidak dilewati.

## 1. Aturan utama

1. Tujuan akhir produk di `FOUNDATION_SPEC.md` adalah sumber kebenaran tertinggi.
2. Tidak ada feature code sebelum outcome, acceptance criteria, dan non-goal unit tercatat.
3. Hanya satu unit implementasi yang boleh berstatus `IN_PROGRESS`.
4. Code banyak, UI terlihat jadi, build sukses, dan demo berjalan bukan bukti selesai.
5. Hanya status `VERIFIED` yang boleh dilaporkan sebagai selesai.
6. Keputusan teknis penting harus berasal dari measurement, test, atau sumber primer yang dapat diperiksa.
7. Temuan yang bertentangan dengan asumsi awal harus mengubah keputusan; keputusan tidak dipertahankan demi konsistensi ego.
8. Kegagalan test tidak ditutupi dengan menghapus assertion, memperlebar tolerance tanpa bukti, atau menandai test skip.
9. Scope baru tidak disisipkan ke task aktif.
10. Security, idempotency, migration, rollback, dan observability adalah bagian feature, bukan pekerjaan akhir.

## 2. Hierarki pekerjaan

```text
Product Objective
  └── Milestone
       └── Vertical Slice
            └── Verification Unit
                 └── Task
```

### Product Objective

Hanya satu: sistem Jaseb Worker dan Userbot production-first sesuai `FOUNDATION_SPEC.md`.

### Milestone

Hasil besar yang masih dapat dirilis atau diverifikasi secara independen, misalnya engine selection, identity/auth, package system, worker Jaseb, atau Userbot lifecycle.

### Vertical Slice

Satu perilaku user dari contract sampai persistence/error, tetapi tidak menggabungkan beberapa domain. Contoh: “admin membuat PlanVersion” atau “user meminta join satu target”.

### Verification Unit

Bagian terkecil yang dapat memperoleh bukti sendiri. Contoh: state transition validator, atomic job claim, atau benchmark summarizer.

### Task

Aktivitas konkret seperti menulis migration, satu adapter, satu test suite, atau satu endpoint.

## 3. Batas ukuran unit

Unit wajib dipecah bila mempunyai lebih dari satu kondisi berikut:

- lebih dari satu outcome user;
- menyentuh lebih dari satu external side effect;
- mengubah schema, billing, engine, dan UI sekaligus;
- membutuhkan pemahaman lebih dari satu domain utama untuk review;
- acceptance criteria tidak dapat diuji dalam satu suite fokus;
- rollback tidak dapat dijelaskan dengan ringkas;
- diff diperkirakan melebar ke banyak file yang tidak satu alasan perubahan.

Angka pemicu review ukuran, bukan target yang harus dihabiskan:

- lebih dari sekitar 8 production files;
- lebih dari sekitar 400 net line production code;
- lebih dari satu migration domain;
- lebih dari satu integration eksternal;
- lebih dari dua sesi implementasi tanpa menghasilkan bukti baru.

Jika melewati pemicu, task berhenti dan dipecah sebelum code berikutnya dibuat.

## 4. State pekerjaan

```text
BACKLOG
  → SPEC_READY
  → IN_PROGRESS
  → IMPLEMENTED_UNVERIFIED
  → VERIFYING
  → VERIFIED
```

Cabang lain:

- `BLOCKED`: tidak dapat maju tanpa authority, credential, keputusan produk, atau perubahan external state.
- `REJECTED`: solusi tidak memenuhi gate dan tidak dilanjutkan.
- `SUPERSEDED`: diganti oleh keputusan baru dengan alasan tercatat.

### Larangan status

- Task dengan test gagal tidak boleh `VERIFIED`.
- Task tanpa negative-path test tidak boleh `VERIFIED` jika menerima input atau external failure.
- Task database tanpa fresh/upgrade migration test tidak boleh `VERIFIED`.
- Task external side effect tanpa retry/idempotency test tidak boleh `VERIFIED`.
- UI tanpa error/loading/empty state relevan tidak boleh `VERIFIED`.

## 5. Task contract wajib

Sebelum `IN_PROGRESS`, ledger harus memuat:

- ID stabil;
- parent objective/milestone;
- outcome tunggal;
- alasan task diperlukan untuk tujuan akhir;
- acceptance criteria yang observable;
- non-goal;
- dependency;
- risiko dan failure mode utama;
- test plan;
- rollback/recovery plan;
- file/domain yang diperkirakan berubah;
- bukti yang harus dihasilkan.

Template:

```markdown
### TASK-ID — Judul

- Status: SPEC_READY
- Parent: MILESTONE-ID
- Outcome:
- Goal trace:
- Acceptance criteria:
  - [ ] ...
- Non-goal:
- Dependencies:
- Risks/failure modes:
- Test plan:
- Rollback/recovery:
- Expected touch points:
- Required evidence:
```

## 6. Siklus satu unit

### Tahap A — Trace tujuan

1. Baca kembali bagian foundation yang relevan.
2. Nyatakan hubungan task dengan outcome produk.
3. Pastikan task bukan optimasi atau abstraksi spekulatif.
4. Catat apa yang sengaja tidak dikerjakan.

Output: task contract `SPEC_READY`.

### Tahap B — Discovery terbatas

1. Inspeksi source dan test yang relevan.
2. Cari invariant, caller, consumer, persistence, dan error path.
3. Verifikasi dependency/API yang temporally unstable lewat sumber primer.
4. Catat asumsi dan cara membuktikannya.
5. Jangan mengubah code pada fase ini kecuali membuat reproduction/measurement yang terisolasi.

Output: evidence awal dan daftar risiko.

### Tahap C — Desain minimum

1. Pilih desain terkecil yang memenuhi acceptance criteria.
2. Definisikan input, output, state transition, error, timeout, retry, dan idempotency.
3. Untuk concurrency: definisikan owner, lease, lock/claim, fencing, dan crash point.
4. Untuk data: definisikan constraint database, transaction boundary, migration, dan rollback.
5. Untuk dependency penting: buat ADR jika pilihan sulit dibalik.
6. Jangan membuat abstraction untuk use case yang belum ada.

Output: design note atau ADR ringkas.

### Tahap D — Test design sebelum implementasi

Minimal tentukan:

- happy path;
- input invalid;
- authorization/ownership failure;
- dependency timeout/error;
- retry;
- duplicate request;
- restart/crash point bila stateful;
- concurrency bila shared resource;
- observability assertion bila operasi async.

Test boleh ditulis dahulu atau bersamaan dengan implementation, tetapi acceptance criteria tidak boleh dibuat setelah melihat implementation.

Output: test cases yang dapat menggagalkan solusi salah.

### Tahap E — Implementasi minimum

1. Ubah hanya file yang diperlukan.
2. Pertahankan perubahan user yang tidak terkait.
3. Gunakan runtime validation pada boundary.
4. Simpan invariant penting di database bila lintas process.
5. Jangan menelan error tanpa state/log yang disengaja.
6. Jangan memasukkan raw secret/session ke log.
7. Jangan menambahkan dependency jika standard library atau dependency yang ada cukup.
8. Pin dependency runtime sesuai policy repository.

Output: `IMPLEMENTED_UNVERIFIED`.

### Tahap F — Verification ladder

Jalankan dari termurah ke termahal:

1. Format dan static analysis.
2. Typecheck.
3. Unit test fokus.
4. Seluruh unit test package.
5. Integration test dependency/database.
6. Migration test.
7. Contract test.
8. Concurrency/crash/retry test.
9. E2E flow relevan.
10. Resource benchmark/soak bila menyentuh hot path atau long-lived process.

Test yang gagal mengembalikan status ke `IN_PROGRESS`. Root cause dicatat; bukan hanya output error terakhir.

### Tahap G — Adversarial review

Review ulang seolah implementation dibuat orang lain:

- Apakah acceptance criteria benar-benar dibuktikan?
- Apakah test hanya meniru implementation?
- Apa yang terjadi di setiap `await` jika process mati?
- Apa yang terjadi bila request dikirim dua kali?
- Apa yang terjadi bila dua instance aktif?
- Apakah tenant A dapat menyentuh data tenant B?
- Apakah error user jelas dan error admin cukup diagnostik?
- Apakah timeout membatalkan operasi atau hanya berhenti menunggu?
- Apakah migration aman untuk data existing?
- Apakah rollback benar-benar mungkin?
- Apakah ada resource yang tidak dilepas?
- Apakah ada dependency/version assumption yang belum dibuktikan?

Output: review note dan perubahan bila ada.

### Tahap H — Close dengan bukti

Task hanya berubah ke `VERIFIED` setelah ledger memuat:

- commit/diff reference;
- command test dan hasil;
- artifact benchmark bila relevan;
- acceptance criteria tercentang;
- risk tersisa;
- rollback note;
- follow-up yang sengaja dipisah.

## 7. Aturan khusus per domain

### Database dan migration

- Database constraint menjadi penjaga invariant lintas process.
- Setiap perubahan schema mempunyai migration explicit.
- Test minimal: fresh database, upgrade dari fixture sebelumnya, dan Prisma/schema drift atau ekuivalennya.
- Migration destructive memakai expand → migrate/backfill → switch → contract.
- Column/table lama tidak dihapus pada release yang sama dengan perpindahan reader/writer kecuali terbukti aman dan rollback tidak diperlukan.
- Backfill harus resumable dan observable.
- Transaction tidak boleh memegang external network call.

### Payment dan entitlement

- Provider callback tidak dipercaya tanpa signature/verifikasi provider.
- Order, payment settlement, dan entitlement mempunyai idempotency key.
- State payment dan grant tidak boleh memiliki crash window permanen.
- Test menyisipkan kegagalan setelah setiap persistence step.
- Amount, plan version, benefit, dan user disimpan sebagai checkout snapshot.
- Rekonsiliasi payment tersedia; webhook bukan satu-satunya jalan recovery.

### Telegram session dan engine

- Satu session hanya mempunyai satu runtime owner.
- Lease selalu mempunyai fencing token/generation.
- Operasi yang selesai terlambat wajib memeriksa generation sebelum persistence/side effect berikutnya.
- Queue sequential per session; concurrency hanya antar-session.
- Forced Telegram wait dihormati dan dicatat sebagai state.
- Artificial delay hanya berasal dari konfigurasi user/paket yang eksplisit.
- Graceful shutdown berhenti menerima job, menguras/mengembalikan job, disconnect, lalu melepas lease.
- Session revoked, duplicated, banned, forbidden, approval required, dan target missing mempunyai error code berbeda.

### Job, retry, dan idempotency

- Job claim atomic.
- Job mempunyai attempts, nextAttemptAt, lease owner/until, idempotency key, dan terminal state.
- Retry hanya untuk error yang diklasifikasikan retryable.
- Backoff bounded dan observable.
- Side effect eksternal tidak dianggap atomic bersama transaction database.
- Gunakan intent/outbox + reconciliation untuk menutup crash window.

### API dan security

- Runtime schema validation untuk body, params, query, header relevan, dan response penting.
- Authentication dan authorization/ownership diuji terpisah.
- Error publik tidak membocorkan stack, secret, query, atau raw provider payload.
- Endpoint internal memakai credential terpisah, rotatable, dan least privilege.
- Rate control menjaga resource tanpa menyamarkan error Telegram.
- Dependency audit dijalankan pada lockfile final.

### Frontend

- Mobile Telegram viewport adalah baseline.
- Business rule paket tetap di server; frontend merender contract.
- Setiap async state mempunyai loading, success, empty, dan error yang relevan.
- Mutation mencegah double submit dan memakai idempotency key bila berdampak finansial/eksternal.
- Error code dipetakan ke pesan sederhana; tidak ada copywriting panjang yang menutupi masalah.
- Accessibility dasar: focus, label, contrast, keyboard, reduced motion bila relevan.
- E2E menguji flow dan error, bukan screenshot happy path saja.

### Observability

- Structured log dengan correlation ID dan operation ID.
- Metric minimum: operation latency, success/error by code, queue depth/age, active session, reconnect, flood wait, duplicate prevented, lease conflict, DB pool saturation.
- Log retention dan redaction diuji.
- Alert harus actionable dan mempunyai runbook.
- Metric tanpa owner atau action tidak ditambahkan.

## 8. Technology decision workflow

Keputusan framework/library/runtime yang sulit dibalik memakai proses:

1. Definisikan capability dan hard gate.
2. Pilih kandidat yang benar-benar memenuhi use case.
3. Pin versi dan catat dependency health.
4. Buat adapter dengan contract sama.
5. Jalankan test/workload sama pada lingkungan sama.
6. Simpan raw result.
7. Buat summary reproducible.
8. Gugurkan kandidat yang gagal correctness.
9. Bandingkan resource hanya di antara kandidat yang lolos.
10. Tulis ADR: context, data, decision, downside, rollback/exit strategy.

Benchmark internet hanya menjadi konteks. Keputusan produk memakai workload proyek sendiri.

## 9. Deployment workflow

### Pre-deploy

- commit bersih dan traceable;
- seluruh gate relevan hijau;
- dependency audit direview;
- migration plan dan rollback tersedia;
- backup current state tersedia untuk perubahan data berisiko;
- release notes menyebut perubahan state/error/operation;
- staging memakai bentuk topology yang sama dengan production.

### Deploy

1. Jalankan backward-compatible migration.
2. Deploy API/engine dengan readiness gate.
3. Lease/fencing mencegah overlap runner.
4. Jalankan smoke test read dan write terkontrol.
5. Pantau error rate, queue age, DB pool, active session, reconnect, dan memory.
6. Lanjutkan rollout hanya jika metric dalam boundary.

### Post-deploy

- verifikasi operation baru dan recovery;
- periksa log redaction;
- rekonsiliasi job/payment tertunda;
- catat hasil deploy pada evidence ledger;
- rollback jika exit condition terpenuhi, bukan menunggu user mengeluh.

## 10. Incident dan defect workflow

1. Lindungi user/data: hentikan feature atau isolate runner bila perlu.
2. Simpan evidence dan timeline; jangan mengubah log untuk menyesuaikan teori.
3. Buat reproduction atau failing test.
4. Tentukan root cause dan blast radius.
5. Implementasikan fix terkecil.
6. Tambahkan regression test yang gagal pada code lama.
7. Jalankan gate domain terkait.
8. Deploy terkontrol dan monitor.
9. Catat prevention: invariant, alert, runbook, atau desain yang diperbaiki.

Hotfix tidak dibebaskan dari test; scope test dipersempit agar cepat tetapi tetap membuktikan defect.

## 11. Stop conditions

Pekerjaan harus berhenti dan meminta keputusan/authority jika:

- requirement produk mempunyai dua interpretasi dengan dampak berbeda;
- aksi memerlukan credential/account/uang/production mutation yang belum diberi;
- target destructive belum teridentifikasi persis;
- dependency utama tidak mempunyai jalur maintenance yang layak;
- test tidak dapat dibuat karena architecture tidak observable;
- evidence bertentangan dengan acceptance criteria;
- perubahan user yang existing akan tertimpa;
- task melebar melewati batas ukuran;
- tiga percobaan mengulang blocker yang sama tanpa evidence baru.

Berhenti bukan gagal. Melanjutkan dengan asumsi berisiko adalah pelanggaran workflow.

## 12. Pelaporan progres

Update kerja harus menyebut:

- unit aktif;
- outcome yang sedang dibuktikan;
- evidence terbaru;
- failure atau perubahan asumsi;
- langkah berikutnya.

Laporan akhir unit wajib membedakan:

- apa yang `VERIFIED`;
- apa yang baru `IMPLEMENTED_UNVERIFIED`;
- apa yang belum dikerjakan;
- risiko tersisa;
- test/command yang dijalankan.

Tidak memakai kata “selesai”, “aman”, “production-ready”, atau “hemat” tanpa scope dan bukti yang menyertainya.

## 13. Maintenance debt policy

- Tidak menerima TODO pada correctness, security, billing, migration, lease, idempotency, atau data isolation.
- Workaround wajib mempunyai owner, alasan, exit condition, dan batas waktu.
- Dependency upgrade dilakukan terjadwal dengan test, bukan otomatis langsung production.
- Dead code dan feature yang keluar scope dihapus sebelum baseline production.
- Abstraction debt dan duplicate contract tidak dibiarkan tumbuh lintas milestone.
- Setiap milestone menyisihkan review untuk dependency, schema drift, flaky test, slow query, dan runbook.

Targetnya bukan “nol perubahan selamanya”, melainkan tidak meninggalkan risiko tersembunyi yang dibayar user atau operator nanti.

## 14. Urutan milestone saat ini

1. Foundation contract dan audit NEXO — verified.
2. Benchmark harness — verified.
3. Telethon adapter spike.
4. Teleproto adapter spike.
5. Benchmark dan soak.
6. Runtime ADR.
7. Production repository baseline.
8. Auth and identity vertical slice.
9. Plan/version/subscription vertical slice.
10. Operation/job/lease vertical slice.
11. Jaseb Worker vertical slices.
12. Userbot lifecycle vertical slices.
13. Auto Komentar vertical slices.
14. Billing vertical slices.
15. Frontend flow per vertical slice.
16. System integration, security, soak, restore, staging, dan production rehearsal.

Milestone berikutnya tidak dimulai hanya karena tanggal. Gate milestone sebelumnya harus mempunyai evidence yang dibutuhkan oleh milestone berikutnya.
