# Telegram Engine Benchmark Protocol

Status: protocol v1
Tujuan: memilih Telegram engine berdasarkan correctness, reliability, resource, dan maintenance evidence—bukan preferensi bahasa.

## 1. Kandidat

- Python + Telethon stable yang dipin exact.
- TypeScript + Teleproto stable yang dipin exact.

GramJS tidak menjadi kandidat produk baru karena package upstream telah ditandai deprecated. NEXO tetap menjadi referensi behavior dan efisiensi, bukan dependency baseline.

## 2. Aturan benchmark

- Kedua adapter menjalankan skenario dan payload yang sama.
- Mesin, network, akun uji, target, durasi, dan urutan skenario sama.
- Tidak ada optimization khusus satu kandidat sebelum baseline keduanya tercatat.
- Warm-up dipisahkan dari sample pengukuran.
- Raw result disimpan sebagai JSONL dan summary dihasilkan oleh script, bukan disalin manual.
- Versi OS, runtime, dependency, commit, dan konfigurasi dicatat.
- Credential dan session tidak boleh masuk result atau repository.

## 3. Hard gate

Kandidat langsung gugur jika salah satu terjadi:

- controlled event loss lebih dari 0;
- duplicate send lebih dari 0;
- session lain ikut mati ketika satu session gagal;
- gagal graceful shutdown dan recovery;
- gagal mempertahankan lease/fencing contract;
- dependency tidak mempunyai jalur security update yang layak;
- API penting untuk Jaseb/Auto Komentar tidak tersedia atau tidak stabil.

Resource score hanya dibandingkan setelah hard gate lulus.

## 4. Skenario behavior

Setiap kandidat wajib menjalankan:

1. Login OTP tanpa 2FA.
2. Login OTP dengan 2FA.
3. Simpan, tutup, dan buka kembali session.
4. Connect 1, 10, dan 50 session.
5. Receive new-message event terurut.
6. Catch-up pesan setelah reconnect.
7. Resolve channel dan supergroup publik.
8. Join target publik.
9. Join target yang memerlukan approval.
10. Send text.
11. Forward dengan dan tanpa attribution bila didukung Telegram.
12. Comment/reply ke channel discussion.
13. Session revoked.
14. `AUTH_KEY_DUPLICATED` atau collision simulation.
15. FloodWait pendek dan panjang melalui controlled stub.
16. Network disconnect dan reconnect.
17. Timeout operasi yang kemudian selesai terlambat.
18. Graceful shutdown saat idle.
19. Graceful shutdown saat ada queue.
20. Process kill lalu recovery dari durable job.

## 5. Metric

Untuk 1, 10, dan 50 session:

- RSS baseline dan steady-state;
- tambahan RSS per session;
- CPU idle;
- CPU selama burst receive/send;
- event-loop lag atau asyncio loop lag p50/p95/p99;
- connect duration p50/p95/p99;
- reconnect duration p50/p95/p99;
- send acknowledgement p50/p95/p99;
- throughput event dan send;
- database/internal API calls per akun per menit;
- jumlah reconnect tidak diminta;
- jumlah event hilang;
- jumlah side effect ganda;
- error rate per skenario;
- pertumbuhan RSS pada soak 1 jam dan 24 jam.

## 6. Skor keputusan

Setelah dua kandidat melewati hard gate:

- reliability dan recovery: 35%;
- memory: 20%;
- CPU/loop latency: 15%;
- behavior/API completeness: 15%;
- dependency health dan upgrade path: 10%;
- complexity deployment: 5%.

Skor resource dinormalisasi dari hasil aktual, bukan benchmark internet. Bila total skor berbeda kurang dari 5%, pilihan jatuh ke kandidat dengan reliability lebih tinggi. Jika reliability sama, pilihan jatuh ke kandidat yang mengurangi jumlah runtime/deployment.

## 7. Soak test

- Tahap awal: 1 jam untuk mendeteksi kegagalan cepat.
- Kandidat yang lolos: 24 jam.
- Beban berisi event idle, burst, reconnect terjadwal, satu session revoked, dan satu network interruption.
- Heap/RSS diambil periodik.
- Selesai soak, seluruh session harus masih dapat menjalankan health action.

## 8. Bukti keputusan

Keputusan runtime baru sah jika repository mempunyai:

- adapter kedua kandidat;
- manifest dependency exact;
- raw benchmark result;
- summary yang dapat direproduksi;
- daftar skenario lulus/gagal;
- resource graph/table;
- ADR yang menghubungkan angka dengan pilihan.

Sebelum bukti tersebut ada, label keputusan adalah `PROVISIONAL`, bukan `DONE`.
