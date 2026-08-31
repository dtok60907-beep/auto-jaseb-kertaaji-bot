# Kertaaji Mini App

Frontend production untuk lifecycle akun Telegram Userbot.

## Menjalankan

```bash
npm ci
npm run dev
```

`VITE_API_BASE_URL` dapat menunjuk ke API Kertaaji saat development. Untuk image
production, `API_BASE_URL` diinjeksikan saat container mulai sehingga satu image
tetap dapat dipromosikan antar-environment. Saat dibuka dari Telegram, Mini App
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
docker build -t kertaaji-web .
docker run -e API_BASE_URL=https://kertaaji-api-production.up.railway.app -p 8080:80 kertaaji-web
```

Container hanya menyajikan hasil build dan endpoint `/health` untuk probe. API
tetap menjadi pemilik auth, account lifecycle, dan seluruh business rule.
