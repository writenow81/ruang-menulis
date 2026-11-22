# Ruang Menulis

Ruang menulis peribadi berasaskan web. AI memberi cadangan, tetapi penulis tetap mengawal naskhah. Pengguna mendaftar dengan aplikasi ini sendiri, jadi mereka tidak memerlukan akaun Claude.

## Struktur

Projek penulisan → Bab → tulisan dalam setiap bab.

| Bahagian | Lokasi |
|---|---|
| Pendaftaran dan log masuk | `#/daftar`, `#/masuk` |
| Senarai projek | `#/projek` |
| Senarai Bab, Zon Kenal Pembaca dan Analisis Projek, Tong Sampah, Google Drive | `#/projek/:id` |
| Zon Menulis (Ulas Perenggan, Semakan, Carian Fakta, Sambung Menulis, Rakam Suara) | `#/bab/:id` |
| Panel admin | `#/admin` (hanya untuk akaun admin) |

Kod: `server.js` (API), `src/ai.js` (arahan AI), `src/exporter.js` (DOCX/TXT), `src/drive.js` (Google Drive), `src/db.js` (SQLite), `public/` (antara muka).

## Pemasangan

Anda perlukan Node.js 22.13 atau lebih baharu (untuk SQLite terbina dalam).

```bash
npm install
cp .env.example .env   # kemudian isi RM_ANTHROPIC_API_KEY dan ADMIN_PASSWORD
npm start
```

Kemudian buka http://localhost:3000.

- **Admin:** log masuk dengan `kreatifkursus@gmail.com` dan `ADMIN_PASSWORD`. Akaun ini dicipta semasa pelayan dimulakan buat kali pertama. Jika `ADMIN_PASSWORD` kosong, kata laluan sementara dicetak dalam log pelayan. Tukar kata laluan di Panel admin → *Tukar kata laluan saya*.
- **Data:** disimpan dalam `data/ruang-menulis.db`. Sandarkan fail ini.

## Google Drive (pilihan)

1. Dalam Google Cloud Console, aktifkan **Google Drive API**.
2. Konfigurasikan *OAuth consent screen* dan tambah skop `.../auth/drive.file`.
3. Cipta *OAuth client ID* jenis **Web application**, dengan *Authorized redirect URI* `APP_URL/api/google/callback`.
4. Isi `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` dalam `.env`.

Skop `drive.file` hanya memberi akses kepada fail yang dicipta atau dibuka oleh aplikasi ini (folder "Ruang Menulis" dalam Drive pengguna). Kebenaran ini diminta berasingan daripada log masuk aplikasi.

## Pengeluaran

- Jalankan di belakang HTTPS (contoh: Nginx/Caddy, atau Render/Railway/Fly.io dengan cakera kekal untuk `data/`). Tetapkan `NODE_ENV=production` supaya kuki sesi menjadi `Secure`.
- Rakaman suara menggunakan pengecaman suara pelayar (Chrome, Edge, Safari). HTTPS diperlukan untuk akses mikrofon.
