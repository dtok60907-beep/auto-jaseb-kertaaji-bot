# Kertaaji Mini App

Frontend production untuk lifecycle akun Telegram Userbot.

## Menjalankan

```bash
npm ci
npm run dev
```

`VITE_API_BASE_URL` menunjuk ke API Kertaaji. Saat dibuka dari Telegram, Mini App
mengambil `initData` dari Telegram WebApp lalu menukarnya sekali menjadi bearer
session backend. Token hanya berada di `sessionStorage` dan tidak pernah ditulis
ke URL atau local storage.

## Verifikasi

```bash
npm test
npm run build
```

## Container

Build production membutuhkan API base URL saat build image:

```bash
docker build --build-arg VITE_API_BASE_URL=https://kertaaji-api-production.up.railway.app -t kertaaji-web .
```

Container hanya menyajikan hasil build dan endpoint `/health` untuk probe. API
tetap menjadi pemilik auth, account lifecycle, dan seluruh business rule.
