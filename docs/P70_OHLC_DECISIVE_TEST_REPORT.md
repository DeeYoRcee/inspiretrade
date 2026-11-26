# PHASE 70 — GOLD-API FREE OHLC DECISIVE TEST (10 REQUESTS)

**Status:** READ-ONLY INVESTIGATION — production to'liq o'zgarmagan (live feed, recorderlar, RTDB shema, tarix pipeline, chart, konfiguratsiya). Premium sotib olinmagan. Hech qanday deploy yo'q.
**Sana:** 2026-11-26 · **Repo HEAD:** P69 (`95d0a10`) ustiga qo'shilgan faqat hisobot + test skriptlari.

---

## 0. EXECUTIVE SUMMARY

Test **key yo'qligi sababli bloklangan** va bu ochiq aytildi: gold-api `/ohlc` key'siz **HTTP 401** qaytaradi (yangi isbot §2.3), sandbox'da hech qanday GOLD_API_KEY yo'q (§1), foydalanuvchidan kalit chatga yozishi yoki GitHubga commit qilishi so'ralmadi (§1'da faqat xavfsiz Vercel yo'riqnomasi).

**Ammo test TO'LIQ TAYYOR:** yangi recorded dataset (bugun, 806 namuna, 0 xato, 10 tanlangan minut), fail-closed harness (key yo'q = 0 so'rov — o'z-o'zini tekshiruvdan o'tdi) va taqqoslash mashinasi ishlab qilingan. Kalit qo'silishi bilan test **~90 sekundda, aynan 10 so'rov** bilan bajariladi.

Bu jarayonda o'lchangan **mustaqil qimmatli fakt**: ikki mustaqil sessiyada (P67: 2026-11-19, P70: bugun) recorded M1 minut hech qachon **3 tadan ko'p xil narx darajasini** tutmadi (P67: mean 2.94; bugun: aynan 3.00 — 9/9 daqiqa) chunki provider **anjir har 30.0s** da yangilanadi (bugun 27/27 interval = 30.0s). Recorded H/L allaqachon provider'ning publish kadeесi chegarasida.

**Yakuniy tavsiya: KEEP CURRENT RECORDER** — hech narsa hozir o'zgartirishni talab qilmaydi; kalit qo'silgach test natijasiga qarab bu klassifikatsiya "OHLC HISTORICAL ENHANCEMENT WORTH TESTING" ga yangilanadi (§4.6).

---

## 1. API KEY HOLATI

### 1.1 Qayerda qidirildi (qiymatlar chop etilmagan — faqat nomlar)
| Joy | Natija |
|---|---|
| Sandbox env o'zgaruvchilari | `env | grep -ic gold` = **0** |
| `.env` (repo ildizi) | faqat `DATABASE_URL` (ismlar ro'yxati bilan tekshirildi, `cut -d= -f1`) |
| `.env.local` / `.env.production` | mavjud emas |
| Vercel CLI / `.vercel` link | **o'rnatilmagan / yo'q** — secure env'larni ko'rish imkoni yo'q |
| Repo kodi (ts/tsx/js/json) | `GOLD_API_KEY` / `x-api-key` havolalari **0** |

**Xulosa:** kalit mavjud emas (va Vercel secure env holatini sandbox tekshira olmaydi — agar siz u yerda qo'shgan bo'lsangiz, bu sandbox bilmaydi; pastdagi 401 isboti hozirgi holatni ko'rsatadi).

### 1.2 Kalitni xavfsiz qo'shish (chatga/GitHubga yozmasdan)
1. **https://gold-api.com** da bepul akkount oching (karta kerak emas) → Dashboard → **API Keys** → key yarating.
2. **Vercel → project → Settings → Environment Variables**:
   - `Name = GOLD_API_KEY`, `Value = <kalit>`, Environments = Production + Preview.
   - **Client bundle'ga expose qilmang** (rasmiy qoida: "Never put an API key in frontend code").
3. Env kuchga kirishi uchun **redeploy**.
4. Bu sandbox'da test uchun: `export GOLD_API_KEY=...` → pastdagi harness'ni ishga tushiring. Kalit hech qanday log/commit/reportga yozilmaydi (harness uni faqat headerda ishlatadi).

### 1.3 "Unauthenticated so'rov — soxta success" qoidasi
Bajarilmadi: key'siz faqat **holat-isbot** sifatida bitta probe qilindi va u **401** deb ochiq yozildi (§2.3). Hech qanday javob ixtiro qilinmagan.

---

## 2. TEST HOLATI (≤10 SO'ROV)

### 2.1 Endpoint spec (rasmiy llms.txt qayta yuklandi — 5856B, P69 bilan bir xil)
`GET /ohlc/XAU?startTimestamp=<unix>&endTimestamp=<unix>` + header `x-api-key: <key>` → **bitta oraliq uchun bitta** `{open, high, low, close, highLowChangePercent, openCloseChangePercent, startTimestamp, endTimestamp}`. **Aniq 1 daqiqalik interval supportlanadi** (start/end paramlar har qanday oraliqni oladi — "endpoint aniq minutni qo'llab-quvvatlamaydi" degan to'xtash sharti ishga tashlanmadi; blok faqat kalit).
Free kvota: **10 so'rov/soat**, `/history` bilan bo'lishiladi — harness bu byudjetdan ko'pmaydi.

### 2.2 Yangi isbot — key'siz holat (2026-11-26)
```
GET https://api.gold-api.com/ohlc/XAU?startTimestamp=...&endTimestamp=...   → HTTP 401
{"error": "No x-api-key header."}
```
Fayl: `download/p70_ohlc/probe-ohlc-nokey.json`. **Xulosa: /ohlc keyed — test shu holatda bajarilmaydi va javoblar ixtiro qilinmagan.**

### 2.3 Production recorded store ham tashqaridan yopiq (yangi isbot)
```
GET https://inspiretrade.vercel.app/api/quotes?action=spot-history&code=XAU&from=... → HTTP 401
{"error":"MISSING_TOKEN","message":"Missing Authorization bearer token"}
```
RTDB to'g'ridan-to'g'ri o'qish ham imkonsiz: `FIREBASE_DATABASE_URL`/`VITE_FIREBASE_DATABASE_URL` repo'da yo'q (faqat env-placeholder), service-account creds sandbox'da yo'q.

---

## 3. RECORDED SIDE — FRESH DATASET (haqiqiy o'lchovlar)

Production store o'qilmagani uchun (§2.3) taqqoslash uchun **yangi recorded dataset** yozildi: `p70-sample.py` — **aynan Phase 67 fold semantikasi** (`shared/spot-recorder-core.ts` foldSample + providerMinuteBucket 1:1 mirror), 1s poll (production client xuddi shu kadeес), XAU spot.

### 3.1 Session statistikasi (2026-11-26 15:33:28Z → 15:46:58Z, 13.5 min)
| Metrika | Qiymat |
|---|---|
| Namunalar / xatolar | **806 / 0** |
| Bitgan shamlar | 13 (barchasi s=60 — minut cap) |
| Late/glitch/bad drop | **0 / 0 / 0** |
| **Provider stamp interval** | **27/27 = aniq 30.0s** |
| Provider stamp delay | mean **15.2s**, p50 15.2s, max 29.8s (ertalab 14:55 UTC'da 93-183s edi — lag soatga qarab o'zgaradi, P69 xulosasi yana tasdiqlandi) |
| Minutdagi xil narx darajalari | **mean 3.00 (9/9 daqiqa = aynan 3)** — P67: mean 2.94, max 3 |
| Mean minut H-L | $1.53 (bugun tinch bozor; P67'da $4.93) |
| RTT | ~575ms |

### 3.2 Tanlangan 10 minut (testning recorded tomoni — TO'LIQ MAVJUD)
`download/p70_ohlc/selection.json` — so'nggi 10 completed minut (s≥60):
| Minute UTC | O | H | L | C | s |
|---|---|---|---|---|---|
| 15:36 | 3573.3000 | 3573.3000 | 3573.1001 | 3573.1001 | 60 |
| 15:37 | 3571.2000 | 3573.3000 | 3571.2000 | 3573.3000 | 60 |
| 15:38 | 3571.1499 | 3573.3000 | 3571.1499 | 3573.3000 | 60 |
| 15:39 | 3570.5000 | 3572.8000 | 3570.5000 | 3572.8000 | 60 |
| 15:40 | 3571.5000 | 3572.3999 | 3571.5000 | 3572.3999 | 60 |
| 15:41 | 3572.3999 | 3572.3999 | 3572.3999 | 3572.3999 | 60 |
| 15:42 | 3571.1001 | 3571.1001 | 3569.8000 | 3569.8000 | 60 |
| 15:43 | 3572.7000 | 3572.7000 | 3571.0000 | 3571.0000 | 60 |
| 15:44 | 3571.0000 | 3572.6001 | 3571.0000 | 3572.6001 | 60 |
| 15:45 | 3570.7000 | 3573.1001 | 3570.7000 | 3573.1001 | 60 |

Har minut uchun provider so'rovi: `GET /ohlc/XAU?startTimestamp={t}&endTimestamp={t+60}` — selection.json'da yozilgan.

### 3.3 PROVIDER SIDE — BLOKLANGAN
`/ohlc` 10 ta javobi olinmagan (401, §2.2). Taqqoslash jadvalining provider ustunlari **soxta to'ldirilmagan**; `p70-compare.py` mavjud ma'lumot bilan jadvalni avtomatik quradi (missing → "MISSING", offset/normalizatsiya taqiqlangan).

---

## 4. QAROR JAVOBLARI

1. **Provider OHLC minut ichida aniqroq H/L beradimi?** — **Javoblanmagan (kalit kerak).** Mavjud isbotlar ikki tomonlama: (a) bizning recorded H/L allaqachon provider publish kadeесi chegarasida (3 daraja/minut, 2 sessiya); (b) provider /ohlc o'z ICHKI manbasidan hisoblanadi va ichki chastotasi yuqoriroq bo'lishi mumkin — bu yagona ochiq savol va 10 so'rovli test aynan shuni hal qiladi.
2. **1s recorder o'tkazib yuborgan harakatlarni tutadimi?** — **Javoblanmagan (kalit kerak).** Nazariy jihatdan mumkin: bizning minut ichida faqat provider publish qilgan ~3 daraja bor; provider ichki tick'da shu 30s oralig'ida tebranish bo'lsa, uning H kengroq / L chuqurroq bo'lardi.
3. **Tarixiy M1'ni yaxshilashga yetarli darajada barqarormi?** — **Javoblanmagan (kalit kerak).** Barqarorlikni ham test ko'rsatadi (10 minut ichida echo-interval + H/L mantiqiy konsistentligi avtomatik tekshiriladi).
4. **Kelajakdagi integratsiyani oqlaydimi?** — **Hozircha yo'q.** Hozir hech qanday real dalil integratsiyani oqlamaydi; recorder ishlaydi (0 xato ikki sessiyada), sifat cheklovi provider kadeесidan. Agar test provider H/L ni sezilarli finkor desa — integratsiya shakli P69 §6'da tayyor (idempotent fold, s=0-style source belgi, schema o'zgarishi alohida phase).
5. **Premium qo'shimcha material foyda beradimi?** — **Yo'q (live uchun aniq):** bugun 27/27 interval = 30.0s, delay mean 15.2s — provider "har 30s yangilanadi" (FAQ, barcha rejalarda); Premium faqat so'rov byudjetini ochadi. Minut H/L finkorligi isbotlangan bo'lsa Premium faqat shu payt qayta ko'riladi.

### 4.6 YAKUNIY TAVSIYA

## **KEEP CURRENT RECORDER**

Recorder ikki mustaqil sessiyada 0 xato, honest gaps, provider-stamp bucketing — va uning aniqligi allaqachon provider'ning 30s publish kadeесi chegarasida. Hech qanday dalil uni almashtirishni/yaxshilashni talab qilmaydi. **Shartli yangilanish:** `GOLD_API_KEY` qo'silib `p70-ohlc-test.sh` ishga tushgach, agar provider /ohlc H/L barqaror kengroq chiqsa — tavsiya "OHLC HISTORICAL ENHANCEMENT WORTH TESTING" ga yangilanadi; agardaymasa — "OHLC NOT USEFUL" bilan yakunlanadi.

---

## 5. STRICT PROTECTION — BAJARILGAN HOLAT
- Production'ga **0 ta** yozuv: faqat 2 ta GET probe (ikkalasi 401) + cheksiz /price GET (provider qoidalari bo'yicha 1 req/s ≤, P67-measured xatti-harakat).
- Live feed, client/server recorder, RTDB shema, tarix pipeline, chart, konfiguratsiya — **o'zgarmagan**. Premium **sotib olinmagan**, deploy **yo'q**.
- Repo'ga qo'shilgan yagona narsa: bu hisobot + audit/test SKRIPTLARI (production kod emas).

## 6. TEST QAYTA ISHGA TUSHIRISH (kalit qo'silgach, ~90s)
```bash
export GOLD_API_KEY=<key>          # chatga/GitHubga yozmasdan
bash scripts/p70-ohlc-test.sh      # ≤10 so'rov, 7s oralikda, 401/429'da avto-STOP
# → download/p70_ohlc/provider/*.json (raw javoblar) + comparison.json + jadval
```
Alternative recorded manbalar: production spot-history eksporti (autentifikatsiyalangan terminal sessiyasidan) yoki brauzer localStorage `it_spot_rec_XAU` (3 kunlik oyna) — xuddi shu satr formatida `p70-ohlc-test.sh <candles.jsonl>` ga beriladi.

## 7. CHEKLOVLAR
1. Provider javoblari yo'q — 1-3 savollar ochiq (bu hisobotda ixtiro qilinmagan).
2. Recorded dataset production RTDB emas — sandbox'da xuddi shu fold semantikasi bilan yozilgan (kod mirror 1:1; production o'qish auth-gated). Production asosidagi qayta test §6'dagi eksport varianti bilan mumkin.
3. Sandbox'da Vercel secure env ko'rinmaydi — agar kalit allaqachon qo'shilgan bo'lsa, 401 probe yangilanishi kerak.
4. Test bir soatlik 10-so'rovlik kvotadan katta emas; 429 bo'lsa harness avto-STOP qiladi.
5. Sandbox recycle xavfi: artefaktlar `download/p70_ohlc/` da saqlangan; session skriptlari repo `scripts/`da.

## 8. EVIDENCE
- **Artefaktlar:** `download/p70_ohlc/` — probe-ohlc-nokey.json (401), probe-spot-history.json (401), recorded-session.jsonl (13 sham), recorded-session-samples.jsonl (806 qator), recorded-session-summary.json, selection.json (10 minut).
- **Skriptlar:** `scripts/p70-sample.py`, `scripts/p70-select.py`, `scripts/p70-ohlc-test.sh` (fail-closed self-test: key yo'q → 0 so'rov, exit 1 — o'tkazildi), `scripts/p70-compare.py`.
- **Havolalar:** llms.txt (spec, 5856B), P69 hisoboti (endpoint shape + 10 req/h + 30s cadence), P67 commit (`26b60cf` fold semantikasi), `shared/spot-recorder-core.ts` (mirror manba).
