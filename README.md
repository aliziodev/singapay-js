# SingaPay JS

[![Tests](https://github.com/aliziodev/singapay-js/actions/workflows/tests.yml/badge.svg)](https://github.com/aliziodev/singapay-js/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/@aliziodev/singapay)](https://www.npmjs.com/package/@aliziodev/singapay)
[![downloads](https://img.shields.io/npm/dm/@aliziodev/singapay)](https://www.npmjs.com/package/@aliziodev/singapay)
[![license](https://img.shields.io/github/license/aliziodev/singapay-js)](LICENSE)

SDK **tidak resmi** untuk payment gateway [SingaPay](https://singapay.id) (PT Abadi Singapay Indonesia, PJP1 berizin Bank Indonesia). Repo ini tidak berafiliasi dengan PT Abadi Singapay Indonesia.

SingaPay tidak menyediakan SDK resmi untuk bahasa apa pun. Setiap integrator harus mengimplementasikan sendiri beberapa skema tanda tangan HMAC yang berbeda, normalisasi JSON yang presisi byte-per-byte, manajemen token, dan verifikasi webhook. Paket ini mengerjakan semuanya.

Satu paket, framework-agnostic, tanpa dependency runtime. Berjalan di Node 20+, Bun, Deno, dan edge runtime — seluruh kriptografi memakai Web Crypto API (`crypto.subtle`).

- [Instalasi](#instalasi)
- [Pakai](#pakai)
- [⚠️ Baca dulu sebelum produksi](#baca-dulu-sebelum-produksi)
- [Konfigurasi](#konfigurasi)
- [Endpoint](#endpoint)
- [Money-out](#money-out)
- [Webhook](#webhook)
- [Deploy di platform serverless](#deploy-di-platform-serverless)
- [Nominal](#nominal)
- [Error](#error)
- [Kenapa server-only](#kenapa-server-only)
- [Cakupan](#cakupan)
- [Kanonikalisasi & signature vectors](#kanonikalisasi--signature-vectors)
- [Pengembangan](#pengembangan)
- [Lisensi](#lisensi)

## Instalasi

Pilih salah satu sesuai package manager Anda.

**npm**

```bash
npm install @aliziodev/singapay
```

**pnpm**

```bash
pnpm add @aliziodev/singapay
```

**yarn**

```bash
yarn add @aliziodev/singapay
```

**bun**

```bash
bun add @aliziodev/singapay
```

**Deno**

```bash
deno add npm:@aliziodev/singapay
```

Tanpa dependency runtime, jadi tidak ada apa pun yang ikut terpasang.

Tidak ada paket terpisah untuk Next.js, Nuxt, Express, atau lainnya. Semuanya dilayani paket ini — lihat [resep webhook per framework](#resep-per-framework).

## Pakai

```ts
import { SingaPay } from '@aliziodev/singapay';

const singapay = new SingaPay({
  environment: 'sandbox',
  clientId: process.env.SINGAPAY_CLIENT_ID!,
  clientSecret: process.env.SINGAPAY_CLIENT_SECRET!,
  apiKey: process.env.SINGAPAY_API_KEY!,
  accountId: process.env.SINGAPAY_ACCOUNT_ID!,
});

const link = await singapay.paymentLinks.create({
  reff_no: 'INV-1001',
  payment_link_type: 'total',
  total_amount: 150_000,
});

console.log(link.data.payment_url);
```

## ⚠️ Baca dulu sebelum produksi

1. **IP whitelist wajib.** SingaPay menolak request dari IP yang tidak terdaftar (`SP017`). Vercel, Netlify, dan Cloudflare Workers memakai IP egress dinamis dan **tidak bisa** di-whitelist — ini kendala arsitektur, bukan masalah konfigurasi. Lihat [Deploy di platform serverless](#deploy-di-platform-serverless).
2. **Server-only secara desain.** Setiap request ditandatangani dengan `client_secret`. Paket ini menolak dimuat di browser — lihat [Kenapa server-only](#kenapa-server-only).
3. **Money-out mati secara default.** Semua operasi yang memindahkan uang melempar `MoneyOutDisabledError` sampai Anda menyetel `moneyOut: { enabled: true }`.
4. **Jangan pernah retry money-out secara buta.** Setelah `SP001`/`SP005`/timeout, panggil `inquireStatus()` dengan reference yang sama sebelum melakukan apa pun. Retry buta bisa menduplikasi transfer uang sungguhan. SDK ini hanya me-retry otomatis untuk GET.
5. **Endpoint Card = ruang lingkup PCI-DSS.** Gunakan Payment Link kecuali Anda benar-benar paham konsekuensinya.
6. **Jadwal settlement & rolling reserve tidak terdokumentasi** oleh SingaPay — tanyakan langsung sebelum go-live.

## Konfigurasi

```ts
export const singapay = new SingaPay({
  environment: 'sandbox',            // default 'sandbox'
  clientId: process.env.SINGAPAY_CLIENT_ID!,
  clientSecret: process.env.SINGAPAY_CLIENT_SECRET!,
  apiKey: process.env.SINGAPAY_API_KEY!,
  accountId: process.env.SINGAPAY_ACCOUNT_ID!,   // ULID akun default
  authVersion: '1.1',                // '1.1' (HMAC) atau '1.0' (Basic)
  timeoutMs: 30_000,
  retry: { times: 2, delayMs: 200 }, // hanya berlaku untuk GET
  moneyOut: { enabled: false },      // wajib true untuk operasi yang memindahkan uang
  webhooks: {
    toleranceSeconds: 300,
    secrets: [process.env.SINGAPAY_HMAC_KEY!], // HMAC Validation Key dari dashboard
  },
});
```

Ada juga `optionsFromEnv()` yang membaca variabel `SINGAPAY_*`:

```ts
import { optionsFromEnv, SingaPay } from '@aliziodev/singapay';

const singapay = new SingaPay(optionsFromEnv({ moneyOut: { enabled: true } }));
```

### Dari dashboard ke konfigurasi

Halaman **Credential Details** di dashboard SingaPay memakai nama yang berbeda dari header protokolnya. Paket ini mengikuti nama di dashboard, karena di situlah Anda menyalinnya:

| Field di dashboard | Opsi di paket ini | Variabel env | Dipakai untuk |
|---|---|---|---|
| Client ID | `clientId` | `SINGAPAY_CLIENT_ID` | Identitas klien di semua skema auth |
| Client Secret | `clientSecret` | `SINGAPAY_CLIENT_SECRET` | Kunci HMAC tanda tangan **keluar**. Tidak pernah dikirim |
| **API Key** | **`apiKey`** | `SINGAPAY_API_KEY` | Dikirim sebagai header **`X-PARTNER-ID`** di setiap request |
| HMAC Validation Key | `webhooks.secrets` | `SINGAPAY_HMAC_KEY` | Verifikasi tanda tangan webhook **masuk**. Satu per credential — lihat di bawah |

> **API Key dan Client Secret paling sering tertukar.** API Key adalah *identitas* yang dikirim di header; Client Secret adalah *kunci tanda tangan* yang tidak pernah meninggalkan server Anda. Tertukar berarti token exchange gagal dengan error autentikasi yang tidak menyebut sebabnya.

Kalau Anda menelusuri header request atau membaca dokumentasi API SingaPay, `apiKey` inilah yang muncul sebagai `X-PARTNER-ID`. `SINGAPAY_PARTNER_ID` tetap diterima sebagai nama variabel env, jadi konfigurasi lama tidak perlu diubah.

### Multiple credentials

Satu merchant bisa memegang beberapa credential dashboard: satu **Default** milik merchant, plus **Specific** yang terikat ke sub-akun tertentu. Ini bukan pilihan desain — `SP403` menolak credential Default untuk akun yang sudah punya credential sendiri.

Credential top-level adalah connection bernama `default`. Sisanya didaftarkan di `connections`:

```ts
const singapay = new SingaPay({
  environment: 'production',
  clientId: process.env.SINGAPAY_CLIENT_ID!,
  clientSecret: process.env.SINGAPAY_CLIENT_SECRET!,
  apiKey: process.env.SINGAPAY_API_KEY!,
  moneyOut: { enabled: true },
  connections: {
    payouts: {
      clientId: process.env.SINGAPAY_PAYOUTS_CLIENT_ID!,
      clientSecret: process.env.SINGAPAY_PAYOUTS_CLIENT_SECRET!,
      apiKey: process.env.SINGAPAY_PAYOUTS_API_KEY!,
      accountId: '01J0PAYOUTSACCOUNT',
    },
  },
});

await singapay.paymentLinks.create({ ... });                        // default
await singapay.connection('payouts').disbursement.transfer({ ... });
```

**Hanya credential yang per-connection** — `clientId`, `clientSecret`, `apiKey`, `accountId`, `authVersion`. Environment, base URL, guard money-out, timeout, retry, toleransi webhook, dan logger adalah kebijakan aplikasi dan tetap dibagi bersama.

Instance connection di-memo dan murah. Semuanya berbagi `tokenStore` yang sama, dan token di-cache per client id, jadi satu connection tidak pernah memakai token milik yang lain.

`singapay.connectionNames` memuat semua nama yang terkonfigurasi, `default` di urutan pertama. `optionsFromEnv()` hanya mengisi connection `default` — daftarkan sisanya di kode.

### Token store

Token di-cache di memori proses secara default, dan itu tidak berguna di serverless — tiap invocation bisa mendapat instance baru dan mengambil token lagi. Sediakan store Anda sendiri:

```ts
const singapay = new SingaPay({
  ...credentials,
  tokenStore: {
    get: (key) => redis.get(key),
    set: (key, token, ttl) => redis.set(key, token, 'EX', ttl),
    delete: (key) => redis.del(key),
  },
});
```

## Endpoint

Setiap grup mengembalikan `SingaPayResponse` yang seragam: `{ status, code, message, data, items, raw, successful }`, apa pun generasi envelope yang dipakai gateway.

`data` selalu objek — dipakai untuk pembacaan satu record seperti `response.data.payment_url`. Endpoint yang mengembalikan daftar (`list()`, `paymentMethods()`, dan sejenisnya) menaruh barisnya di **`items`**, bukan di `data`:

```ts
const accounts = await singapay.accounts.list();

for (const row of accounts.items ?? []) {
  // ...
}
```

`items` bernilai `null` untuk respons satu record, dan array kosong untuk daftar yang memang kosong — jadi keduanya bisa dibedakan. `raw` selalu memuat body apa adanya.

**Money in**

| Properti | Isi |
|---|---|
| `paymentLinks` | `list` `paymentMethods` `create` `find` `update` `delete` |
| `paymentLinkHistories` | `list` `find` |
| `virtualAccounts` | `list` `create` `find` `update` `delete` |
| `vaTransactions` | `list` `find` `listByVaNumber` |
| `qris` | `generate` `list` `find` |
| `ewallet` | `createCheckout` `createOrder` `listTransactions` `findTransaction` `inquireStatus` |
| `card` | `payment` `cancel` `inquireStatus` |
| `directDebit` | `bindCard` `bindingStatus` `unbindCard` `charge` `verifyOtp` `findTransaction` |
| `subscriptions` | `createPlan` `findPlan` `updatePlan` `cancelPlan` |

**Money out** — semuanya di belakang guard `moneyOut`

| Properti | Isi |
|---|---|
| `disbursement` | `list` `find` `checkFee` `checkBeneficiary` `transfer` `inquireStatus` |
| `ewalletMoneyOut` | `inquireAccount` `triggerTopup` `inquireStatus` |
| `qrisMoneyOut` | `inquireMerchant` `triggerPaymentCredit` `inquireStatus` |
| `accountTransfer` | `list` `find` `transfer` |
| `cardlessWithdrawal` | `create` `list` `find` `cancel` |

**Akun**

| Properti | Isi |
|---|---|
| `accounts` | `list` `create` `find` `update` `updateStatus` `delete` |
| `balance` | `merchant` `account` |
| `statements` | `list` `find` |

Endpoint yang belum dibungkus bisa dipanggil lewat `singapay.request()`, dengan auth, tanda tangan, retry, dan penanganan envelope yang sama.

## Money-out

Setiap operasi yang memindahkan uang melempar `MoneyOutDisabledError` sampai guard-nya dinyalakan:

```ts
const singapay = new SingaPay({ ...credentials, moneyOut: { enabled: true } });

try {
  await singapay.disbursement.transfer({
    reference_number: 'PO-2026-0001',
    amount: 1_500_000,
    bank_account_number: '1234567890',
    bank_code: '014', // tiga digit atau SWIFT
  });
} catch (error) {
  if (error instanceof IndeterminateOutcomeError) {
    // SP001 / SP005 — hasilnya BELUM tentu gagal. Jangan retry.
    const status = await singapay.disbursement.inquireStatus('PO-2026-0001');
  }
}
```

Perhatikan kosakata field-nya berbeda antara transfer dan pengecekan, dan gateway menolak kalau tertukar:

| Panggilan | Field bank | Field rekening |
|---|---|---|
| `transfer()` | `bank_code` — tiga digit atau SWIFT | `bank_account_number` |
| `checkFee()` `checkBeneficiary()` | `bank_swift_code` — hanya SWIFT | `bank_account_number` |

Mengirim `bank_swift_code` ke `transfer()` ditolak `SP018`, dan `bank_code` ke pengecekan ditolak `422`.

**Jangan percaya tabel bank yang dipublikasikan SingaPay.** Tabelnya memuat 100+ bank, tapi API menerima lebih sedikit — dari 20 yang disampel, 6 ditolak `422`, termasuk setiap entri syariah yang berbagi `bank_code` dengan induk konvensionalnya. Tidak ada endpoint yang memberi daftar sebenarnya, jadi validasi tujuan dengan `checkBeneficiary()` sebelum menjanjikan apa pun ke pelanggan.

## Webhook

Verifikasi butuh tiga hal: body sebagai string, header request, dan path callback persis seperti yang terdaftar di dashboard — termasuk query string, karena ikut ditandatangani.

```ts
const verified = await singapay.verifyWebhook(rawBody, request.headers, '/api/webhooks/singapay');

if (verified.type === 'va-transaction') {
  await markPaid(verified.payload);
}
```

Yang diperiksa: perbandingan constant-time, toleransi timestamp untuk mencegah replay, dan beberapa kandidat secret sekaligus (client secret plus HMAC Validation Key).

**Setiap credential punya HMAC Validation Key sendiri, dan Anda butuh semuanya.** Dashboard menampilkan satu di tab Default dan satu lagi di tiap tab Specific. Daftarkan semua:

```ts
webhooks: { secrets: [hmacKeySpecific, hmacKeyDefault] }
```

Lewat environment, `SINGAPAY_HMAC_KEY` menerima daftar yang dipisah koma — kunci hex tidak pernah mengandung koma, jadi pemisahannya tidak ambigu:

```
SINGAPAY_HMAC_KEY=kunci-specific,kunci-default
```

Kalau Anda memakai [beberapa credential](#multiple-credentials), verifikasi otomatis mencoba client secret **semua** connection, dan connection mana yang dipakai untuk memanggil tidak berpengaruh. Ini bukan kemewahan: satu callback URL menerima delivery yang ditandatangani credential yang berbeda-beda. Diverifikasi di sandbox — disbursement yang dibuat dengan credential Specific ternyata dinotifikasi oleh credential **Default** merchant, dan ditandatangani dengan secret milik Default. Kalau secret itu tidak ikut dicoba, notifikasi money-out ditolak diam-diam di produksi.

Tanpa client, pakai primitifnya langsung:

```ts
import { verifyWebhook } from '@aliziodev/singapay';

const verified = await verifyWebhook({
  rawBody,
  headers,
  endpoint: '/api/webhooks/singapay',
  secrets: [process.env.SINGAPAY_CLIENT_SECRET!],
});
```

### Soal raw body

Hash dihitung atas **bentuk kanonik** payload lebih dulu, baru byte mentah. Artinya body yang sempat di-parse lalu di-serialisasi ulang **biasanya tetap lolos** — urutan key dan whitespace diserap normalisasi. Ini disengaja: delivery tidak ditolak hanya karena framework Anda sempat menyentuh body-nya.

Yang tidak bisa dipulihkan normalisasi adalah informasi yang hilang waktu parse — integer di atas `Number.MAX_SAFE_INTEGER` kembali sudah dibulatkan, dan jalur verifikasi byte-verbatim ikut hilang. Jadi tetap baca raw body kalau bisa; ongkosnya nol.

`readWebhookBody()` mengerjakannya dengan satu panggilan di semua runtime:

```ts
import { readWebhookBody } from '@aliziodev/singapay';

const rawBody = await readWebhookBody(source);
```

`source` boleh web `Request`, Node `IncomingMessage`, atau event h3 v1/v2 — dikenali secara struktural, tanpa peer dependency ke framework mana pun. Ia melempar `WebhookVerificationError` bila body sudah kosong, yang berarti ada body parser yang menghabiskan stream lebih dulu.

### Resep per framework

**Next.js App Router**

```ts
// app/api/webhooks/singapay/route.ts
import { readWebhookBody } from '@aliziodev/singapay';
import { singapay } from '@/lib/singapay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const verified = await singapay.verifyWebhook(
      await readWebhookBody(request),
      request.headers,
      '/api/webhooks/singapay',
    );

    if (verified.type === 'va-transaction') {
      await markInvoicePaid(verified.payload);
    }
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Balas cepat. SingaPay mengirim ulang bila jawabannya bukan 2xx, jadi
  // pekerjaan berat sebaiknya masuk queue, bukan dikerjakan di sini.
  return Response.json({ received: true });
}
```

**Nuxt / Nitro**

```ts
// server/api/webhooks/singapay.post.ts
import { readWebhookBody } from '@aliziodev/singapay';
import { singapay } from '~/server/utils/singapay';

export default defineEventHandler(async (event) => {
  let verified;

  try {
    verified = await singapay.verifyWebhook(
      await readWebhookBody(event),
      getRequestHeaders(event),
      '/api/webhooks/singapay',
    );
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid SingaPay signature' });
  }

  if (verified.type === 'va-transaction') {
    await markInvoicePaid(verified.payload);
  }

  return { received: true };
});
```

h3 punya `readRawBody(event)` sendiri yang auto-import di Nitro dan mengerjakan hal yang sama. Pakai mana pun yang lebih enak dibaca — `readWebhookBody()` ada supaya baris yang sama jalan di semua runtime.

**Express**

```ts
import express from 'express';
import { readWebhookBody } from '@aliziodev/singapay';

const app = express();

// Jangan pasang express.json() sebelum route ini — ia menghabiskan stream.
app.post('/api/webhooks/singapay', async (req, res) => {
  try {
    const verified = await singapay.verifyWebhook(
      await readWebhookBody(req),
      req.headers,
      '/api/webhooks/singapay',
    );

    if (verified.type === 'va-transaction') {
      await markInvoicePaid(verified.payload);
    }
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.json({ received: true });
});
```

Hono, SvelteKit, Remix, Astro, Bun, dan Deno semuanya memberikan web `Request` — polanya sama persis dengan resep Next.js di atas.

### Membaca payload delivery

Dua bentuk yang tidak bisa ditebak dan gagal secara diam-diam, keduanya diverifikasi lewat delivery sungguhan:

**`payment_method_additional` adalah string JSON, bukan objek.** Akses titik mengembalikan `undefined` tanpa error:

```ts
const extra = JSON.parse(String(history.payment_method_additional));

extra.retail_code;   // "ALFAMART" — kode gerai untuk ditunjukkan pelanggan
extra.partner_reff;  // referensi di sisi gerai
```

**Payment link yang sudah dibayar tidak pernah menyebut cara pembayarannya.** `data.payment.method` selalu literal `payment_link`. Channel sebenarnya — gerai retail, kartu, VA — hanya muncul di delivery `payment-link-inquiry` yang datang lebih dulu. Gabungkan keduanya lewat `reff_no`.

**Nominal datang bertipe tidak konsisten antar event.** Diverifikasi dari delivery sungguhan pada hari yang sama:

```
va-transaction              amount: { value: "125000.00" }   <- string desimal
ewallet-native-transaction  amount: { value: 55000 }         <- number
qris-acquirer-transaction   amount: { value: 75000 }         <- number
```

Jangan pernah membandingkan atau menjumlahkannya langsung. Selalu lewat `Amount.from()`, yang menerima kedua bentuk dan selalu mengembalikan integer:

```ts
Amount.from('125000.00').value; // 125000
Amount.from(55000).value;       // 55000
```

**`transaction-expiration` adalah batch, bukan satu transaksi.** Payload-nya berisi tiga ember array sekaligus, dan bisa kosong:

```ts
const { payment_link_histories, virtual_account_transactions, qris_histories } = verified.payload.data;
```

Sapuannya berkala, bukan timer per-transaksi — jedanya bervariasi beberapa menit. **E-wallet tidak ikut tersapu sama sekali**; kegagalan atau kedaluwarsa e-wallet hanya bisa ditemukan lewat `inquireStatus()`.

**Bentuk info tambahan juga berbeda antar event** — nama field-nya berbeda, dan tipenya berbeda. Yang satu string JSON, yang lain objek biasa:

| Event | Field | Tipe |
|---|---|---|
| `payment-link-inquiry` | `payment_method_additional` | string JSON |
| `ewallet-native-transaction` | `payment.additional_info` | objek |

Periksa tipenya sebelum membaca, jangan berasumsi dari satu event ke event lain.

## Deploy di platform serverless

SingaPay mewajibkan IP server terdaftar di dashboard dan menolak semua request dari IP lain dengan `SP017`. Vercel, Netlify, dan Cloudflare Workers memakai IP egress dinamis, jadi tidak ada yang bisa didaftarkan. Pilihannya:

1. **Deploy di VPS ber-IP statis** (Coolify, Docker, Fly.io dengan dedicated IP). Paling sederhana.
2. **Rutekan panggilan API lewat proxy ber-IP statis.** App tetap di Vercel; panggilan ke SingaPay lewat satu hop ber-IP tetap:

   ```ts
   const singapay = new SingaPay({
     ...credentials,
     baseUrls: { payment: { production: 'https://singapay-proxy.perusahaan-anda.id' } },
   });
   ```

   Proxy-nya cukup meneruskan path, header, dan body **tanpa mengubah satu byte pun**.
3. **Vercel Secure Compute** — berbayar, tingkat enterprise.

Webhook masuk tidak terpengaruh: yang perlu di-whitelist adalah IP *keluar*, sementara webhook datang dari SingaPay ke Anda.

## Nominal

Nominal wajib integer. Float ditolak sebelum ditandatangani, karena float bulat ter-serialisasi berbeda antar runtime (`100000.0` vs `100000`) dan merusak tanda tangan secara diam-diam.

```ts
import { Amount } from '@aliziodev/singapay';

Amount.rupiah(150_000).value;   // 150000
Amount.from('150000.00').value; // 150000
Amount.from('150000.50');       // InvalidAmountError
```

## Error

Semua turunan `SingaPayError`:

| Kelas | Kapan |
|---|---|
| `IpNotWhitelistedError` | SP017 — IP server tidak terdaftar |
| `IndeterminateOutcomeError` | SP001 / SP005 — hasil tidak diketahui, wajib `inquireStatus()`. **Di endpoint kartu, SP001 juga dipakai untuk penolakan pasti** (`card_expiry` salah format, kuota harian habis) — baca pesannya sebelum memperlakukannya sebagai hasil ambigu |
| `InsufficientBalanceError` | SP003 |
| `DuplicateReferenceError` | SP004 |
| `AccountCredentialRequiredError` | SP403 — panggil dengan kredensial pemilik akun |
| `MoneyOutDisabledError` | Guard money-out masih mati |
| `WebhookVerificationError` | Header kurang, timestamp basi, body kosong, atau tanda tangan tidak cocok |
| `AuthenticationError` | Token exchange ditolak |
| `ConnectionError` | Gateway tidak terjangkau |
| `ApiError` | Kegagalan gateway lainnya |

## Kenapa server-only

Setiap request memerlukan `client_secret` untuk menandatangani. Begitu secret itu masuk bundle browser, siapa pun dapat membacanya lewat DevTools dan melakukan disbursement dari saldo merchant. Ini bukan hal yang bisa "diperbaiki" dengan memindahkan penandatanganan ke klien — itu justru menghancurkan seluruh model keamanannya.

Arsitektur yang benar untuk SPA React/Vue:

```
React/Vue (browser) → backend Anda → @aliziodev/singapay → SingaPay
```

Yang dikirim ke browser hanya artefak publik: `payment_url`, `qr_string`, `checkout_url`, `virtual_account_no`. Tidak pernah kredensial, tidak pernah tanda tangan.

Penegakannya berlapis: export condition `browser` menunjuk ke modul yang langsung `throw`, dan konstruktor `SingaPay` melempar `BrowserUsageError` bila menemukan `window`. Di Next.js, tambahkan `import 'server-only'` di modul yang membuat client-nya bila ingin build gagal lebih awal.

## Cakupan

| Area | Status |
|---|---|
| Payment gateway API (money in & money out) | ✅ |
| Verifikasi webhook + diskriminasi 13 event | ✅ |
| Access token v1.1 (HMAC) & v1.0 (Basic) | ✅ |
| Multiple credentials (*connections*) | ✅ |
| Biller | ❌ belum |
| Identity / KYC | ❌ belum |

Biller dan Identity tidak ikut di v1 karena akun produksi yang tersedia tidak punya akses ke keduanya — kodenya tidak akan pernah bisa diverifikasi end-to-end, dan merilis kode yang tidak bisa dibuktikan jalan lebih buruk daripada tidak merilisnya. Keduanya menyusul di rilis minor berikutnya, di paket yang sama, tanpa breaking change.

Tiga seam sudah disiapkan supaya penambahannya nanti bersifat aditif, bukan breaking: `TokenProvider` adalah interface, `ServiceHost` sudah mencakup `biller` dan `identity` lengkap dengan base URL-nya, dan tidak ada satu pun `baseUrl` tunggal di mana pun.

## Kanonikalisasi & signature vectors

SingaPay tidak menerbitkan spesifikasi bagaimana body request diserialisasi sebelum ditandatangani. Aturannya harus disimpulkan dari perilaku gateway dan sampel resminya — key diurutkan **byte order** bukan UTF-16, objek kosong menjadi `[]`, unicode dan slash tidak di-escape, float ditolak. Salah satu saja, dan gateway menolak tanda tangannya tanpa memberi tahu alasannya.

`test/fixtures/signature-vectors.json` mengunci semuanya: 18 vector, masing-masing menyimpan payload, JSON kanoniknya, hash SHA-256-nya, dan tanda tangan HMAC yang diharapkan untuk secret uji tetap. `pnpm test` menjalankan ketiga assertion itu untuk setiap vector.

Fixture ini **tidak boleh diedit tangan.** Kalau sebuah vector gagal, yang salah adalah normalizer-nya. Melonggarkan fixture supaya hijau hanya mengubah tanda tangan yang akan ditolak gateway menjadi test suite yang bilang semuanya beres.

Menambah vector baru boleh dan dianjurkan ketika ada bentuk payload yang belum tercakup — hitung nilainya dari perilaku gateway, jangan dari output normalizer ini, karena vector yang diturunkan dari implementasi yang sedang diuji tidak membuktikan apa pun.

## Pengembangan

```bash
pnpm install
pnpm test         # vitest
pnpm typecheck    # tsc -b
pnpm lint         # biome
pnpm build        # tsdown
```

Paket ini **berjalan** di Node 20+, tapi **membangunnya** butuh Node 22+ — tsdown memakai `Promise.withResolvers`, yang baru ada di Node 22. CI memisahkan keduanya: test dijalankan di Node 20, 22, dan 24, sementara build dilakukan sekali lalu hasilnya dimuat ulang di Node 20 untuk membuktikan klaim `engines`.

Ada juga `pnpm test:e2e` yang memanggil sandbox SingaPay sungguhan. Suite itu skip sendiri tanpa kredensial dan tidak pernah dijalankan CI — lihat `.env.example`.

## Lisensi

MIT © Alizio
