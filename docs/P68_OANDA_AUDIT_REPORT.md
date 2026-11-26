# PHASE 68 — OANDA XAUUSD API FEASIBILITY, LIVE DATA TEST & PROVIDER COMPARISON

**Status:** AUDIT AND TEST ONLY — production'ga hech qanday o'zgarish kiritilmagan.
**Sana:** 2026-11-26 · **Holat:** credentials yo'q → real API test o'tkazilmadi; barcha natijalar rasmiy hujjatlar va ochiq endpointlar bilan tasdiqlangan.

---

## 0. EXECUTIVE SUMMARY — YAKUNIY JAVOB

**Tavsiya: NOT RECOMMENDED** (InspireTrade platformasi uchun ma'lumot manbasi sifatida).

Hal qiluvchi sabab texnik emas, **huquqiy**: OANDA Corporation API License Agreement (2026-yil avgust versiyasi) §3.2 litsenziatdan aniq talab qiladi — *"not transmit, publish, disseminate, duplicate, **display**, disclose, offer, or otherwise provide, in any form whatsoever, the OANDA Trading System Rates to any third party"* va foydalanish faqat **Internal Use** bilan cheklangan. InspireTrade esa aynan narxlarni o'z foydalanuvchilariga (uchinchi shaxslar) ko'rsatadigan mahsulot — ya'ni hozirgi gold-api.com o'rniga OANDA'ni "primary/secondary provider" qilish shartnomani buzadi. OANDA o'zining API narxlarini partnyor ma'lumot-licensing kelishuvisiz ommaviy displeyga bermaydi.

Texnik tomondan esa API kuchli: XAU_USD mavjud, M1…D granularlar, mid/bid/ask shamoylar, 5000 sham/request, "2005-yildan chuqur tarix" (marketing) va rasmiy rate-limitlar (REST 120 req/s per IP, streaming 20 ulanish/IP, 4 narx/sekund/instrument, 5s heartbeat). Lekin bu "agar litsenziya bo'lsa" sifatida qoladi.

Foydali qolgan yagona yo'l: **BYO (bring-your-own) OANDA akkaunt** — foydalanuvchi o'z practice/live tokenini o'zi ulaydi va ilova faqat o'sha foydalanuvchiga, o'z savdosi uchun narxni qaytaradi (License §3.1(a) "creating custom interfaces to the OANDA Trading System"). Bu alohida funksiya bo'lib, "data provider almashtirish" bilan bog'liq emas va alohida qarorga muhtoj.

---

## 1. CREDENTIAL CHECK (P68-1)

| Manba | Natija |
|---|---|
| Process environment `OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID` / `OANDA_ENVIRONMENT` | **YO'Q** |
| Repo `.env*` fayllari | Yagona `/home/z/my-project/.env` — faqat `DATABASE_URL` kaliti bor (qiymat o'qilmadi va chop etilmadi); OANDA kalitlari yo'q |
| Vercel CLI | Autentifikatsiyalanmagan (`vercel login` talab qiladi) → remote Vercel environment variablelarini sanash mumkin bo'lmadi |
| Repo ichida OANDA ma'lumotlari | Faqat `client/src/lib/spot-tail.ts:71` kommentida eslatma ("TwelveData/OANDA/Polygon need API keys") |

**Xulosa:** real API test (§§3–4) bajaringan emas. Hech qanday javob yoki shamlar ixtiro qilinmagan; quyidagi barcha faktlar rasmiy hujjatlardan.

Keyingi test uchun kerak (faqat Vercel secure env'larida, frontend'da hech qachon emas):
1. https://www.oanda.com — fxTrade **Practice** akkaunt ochish (bepul, KYC'dan o'tish);
2. My Account → Manage API Access → **Generate Personal Access Token** (practice uchun);
3. `GET /v3/accounts` orqali **accountID** olish (token bilan);
4. Vercel: `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENVIRONMENT=practice` — serverless env sifatida.

---

## 2. OFFICIAL API AUDIT (P68-2) — rasmiy hujjatlar asosida

### 2.1 Muhitlar va autentifikatsiya
- **Practice (demo):** REST `https://api-fxpractice.oanda.com`, stream `https://stream-fxpractice.oanda.com` — "A stable environment; recommended for testing with your fxTrade Practice account".
- **Live:** REST `https://api-fxtrade.oanda.com`, stream `https://stream-fxtrade.oanda.com`.
- Auth: Bearer token (Personal Access Token), barcha so'rovlar auth talab qiladi. v20 REST API faqat **v20 trading account** bilan ishlaydi.

### 2.2 XAU_USD instrumenti
- OANDA goldni `XAU_USD` sifatida xizmat qiladi (oanda.com instrument sahifalari: "Trade Gold — XAU_USD"; 1 lot = XAU ounslarda, FX-uslubidagi spot kotirovka, GC=F futerlar EMAS).
- **Diqqat:** instrument ro'yxati akkauntga bog'liq — aniq tasdiqlash faqat `GET /v3/accounts/{id}/instruments` bilan (token kerak). Hujjatlarda XAU_USD'ning barcha akkaunt turlarida garantishtalanganligi haqida qat'iy bayon topilmadi → bu "verify actual account requirements" bo'limi: keyingi real testda birinchi navbatda tekshiriladi.

### 2.3 Shamoylar (candles)
- Endpoint: `GET /v3/instruments/{instrument}/candles`.
- **Granularlar:** S5, S10, S15, S30, M1, M2, M4, M5, M10, M15, M30, H1, H2, H3, H4, H6, H8, H12, D, W, M — ya'ni InspireTrade'ning **M1, M5, M15, M30, H1, H4, D** to'liq qoplanadi (M3'ning o'zi yo'q, lekin uni ishlatmaymiz).
- **Narx komponentlari:** `mid`, `bid`, `ask` — har biri alohida so'raladi (`price=MBA`); har sham `o,h,l,c` + `volume` ("number of prices created in the range") + `complete` bayrog'i ("ending time is not in the future").
- **Limit:** request boshiga maksimum **5000 sham** (v20 wrapper hujjatlari tasdiqlaydi: "the OANDA limit of count records"; rasmiy endpoint sahifasi JS-render bo'lgani uchun bu raqam ikkilamchi manbadan) — `from/to` bilan sahifalash mumkin.

### 2.4 Tarix chuqurligi
- OANDA'ning ozi marketingda aytladi: "real-time ticks and **deep historical data back to 2005**" (oanda.com au-en REST API sahifasi — FX juftliklari uchun).
- **XAU_USD M1'ning amaliy chuqurligi hujjatlarda keltirilmagan** — akkaunt bo'lmaganda tekshirib bo'lmadi. S5/M1 granularlar uchun chuqurlik proactively sinovda aniqlanishi kerak (`from=2005` so'rovi amalda qancha qaytarishini ko'rish).

### 2.5 Real-time
- **REST poll:** `GET /v3/accounts/{id}/pricing?instruments=XAU_USD&since=…` — `since` kursori + javobdagi `time` ("The DateTime value to use for the 'since' parameter in the next poll request") polling loop uchun tayyor.
- **Stream:** `GET /v3/accounts/{id}/pricing/stream?instruments=XAU_USD` — chunked transfer, har chunk alohida JSON qator: `Price` (type `PRICE`, `time` RFC3339 nanosecond, `bids[]`/`asks[]` liquidity+price, `closeoutBid/Ask`, `status: tradeable`) va `PricingHeartbeat` (type `HEARTBEAT`).
- **Chastota:** "at most **4 prices per second** (every 250 milliseconds) for each instrument"; 250ms oynada agregatsiya — oxirgi narx yuboriladi; **heartbeat har 5 sekund**; connect'da `snapshot=true` default.

### 2.6 Rate limits (rasmiy, Development Guide)
| Cheklov | Qiymat |
|---|---|
| REST | **120 request/sekund**, ortiqchasi **HTTP 429** |
| Qo'llash doirasi | **IP manzil bo'yicha** (Vercel serverless'da chiqish IP havzasi umumiy — ko'p funksiya bitta limitni bo'lishadi) |
| Streaming | Maksimum **20 aktiv stream** per IP |
| Yangi ulanishlar | Maksimum **2 ta yangi connection/sekund** |

1 sekundlik poll = 86,400 req/kun ≈ 1 req/s — limitlardan uzoq; streaming esa bitta uzun jonli ulanish (20 stream limiti muammo emas), **lekin Vercel serverless'da persistent ulanish saqlab bo'lmaydi** (funksiya timeout).

### 2.7 Demo pricing ≠ Live pricing
- Hujjatlar practice'ni "testing environment" deb tavsiflaydi va demo kotirovkalarning live narxlar bilan bir xilligini **hech qanday garantia bermaydi** (spreadlar simulyatsiya qilinishi ma'lum).
- Phase talabiga muvofiq: demo pricing **hech qachon** InspireTrade'da "live market pricing" sifatida ko'rsatilmaydi; agar BYO-integratsiya qilinsa, UI'da "OANDA Practice (demo)" belgisi majburiy.

### 2.8 Geografik holat — O'zbekiston
- OANDA'ning rasmiy Partners Help Centre javobi ("Which countries does OANDA accept traffic from?") ro'yxatida **Uzbekiston bor** (…Israel | Uzbekistan | Kazakhstan… Kenya | Vietnam…).
- **Muhiym ogohlantirish:** bu "traffic" ro'yxati — akkount ochish huquqi xizmat qiluvchi yuridik shaxs (OANDA Corporation US / Europe / Global Markets BVI) va KYC'ga bog'liq. O'zbekiston rezidenti uchun qaysi entity ochadi va shartlari qanday — rasmiy hujjatlardan aniq o'qilmadi; akkaunt ochishda sinov talab qilinadi. Litsenziya shartnomasi esa `OANDA Corporation` (US) versiyasi — boshqa entitylarda farq bo'lishi mumkin.

---

## 3. PRACTICAL TEST — HOLATI (P68-3/P68-4)

**Real OANDA connection test O'TKAZILMADI** — credentials yo'q (§1). Quyidagilar bajarildi:

### 3.1 gold-api.com baseline benchmark (production o'zgarmagan, public read)
Script: `scripts/p68-goldapi-bench.sh` — 12 namuna, 1s oralıqda, 2026-11-26 ~06:14 UTC:

| Metrika | Qiymat |
|---|---|
| HTTP status | **12/12 × 200** (0 fail) |
| To'liq RTT (sandbox → api.gold-api.com) | **0.46–0.58s** (o'rtacha ≈ 0.53s; sandbox lokatsiyasi Vercel'dan farq qilishi mumkin) |
| Provider stamp (`updatedAt`) | Har **~30 sekundda** yangilanadi (06:14:17 → 06:14:47) |
| Provider-side delay (stamp orqada qolishi) | **2.1s–30.5s** oralig'ida — stamp yangilanishidan oldin ~30s gacha "eski" stamp |
| Narx | 3569.0 USD (barqaror, haqiqiy spot) |

Bu InspireTrade'ning mavjud feed'i uchun "status-quo" o'lchovi: gold-api **be**, KYC yo'q, kalit yo'q, browser'dan to'g'ridan-to'g'ri ishlaydi, narxi spot — lekin **bid/ask yo'q** va stamp kadeеnсisi ~30s (delayed klass).

### 3.2 OANDA live candles/stream testlari — BLOKLANGAN
`§3` va `§4` talab qilingan M1…D shamlar, 100+ stream yangilanishi, latency P90, reconnect o'lchovlari — **token bo'lmagani uchun bajarilmagan**. Ixtiro qilingan javoblar yo'q. Test reja (token olganda tayyor):
1. `GET /v3/accounts` → accountID → `GET /v3/accounts/{id}/instruments` → XAU_USD bor/yo'qligini rasmiy tasdiqlash;
2. Candles: har granularity uchun `count=5000&price=MBA` so'rovi; OHLC sanitar tekshiruvi (h≥max(o,c), l≤min(o,c)), UTC align (OANDA time RFC3339 UTC), `complete=false` oxirgi shamni tashlash, M1'dagi session gaplar (juma 22:00 UTC → yakshanba 22:00 UTC bo'sh bo'lishi KERAK — spot gold ham shu session);
3. Stream: `stream-fxpractice` → 100+ PRICE obyekt; har bir uchun `providerTime` vs `localReceiptTime` (latency), `bid/ask` spread, `HEARTBEAT` 5s tekshiruvi; 60s davomida disconnectlar; mean/P90/max latency;
4. Rate-limit: 5s oralıqli 10 REST so'rov + 429 yo'qligini tasdiqlash.

---

## 4. OANDA vs gold-api — COMPARISON FRAMEWORK (P68-5)

Live parallel comparison token bo'lmagani uchun o'tkazilmadi. Framework tayyor (token bilan ishga tushadi):

| Metrik | Usul |
|---|---|
| Price difference | OANDA mid = (bid+ask)/2 vs gold-api price — bitta UTC sekund ichidagi juftliklar |
| Percentage difference | (mid − goldapi)/goldapi × 100% |
| Bid/ask spread | gold-api'da **bid/ask umuman yo'q** (faqat mid) — bu fundamental farq: InspireTrade'ning quote engine bid/ask'dan foydalanadi; gold-api'da hozir simulyatsiya qilinadi |
| Timestamp difference | OANDA `time` (ns, trade stamp) vs gold-api `updatedAt` (~30s kadeеси) |
| Update frequency | OANDA stream ≤4/s/instrument vs gold-api ~30s/stamp |
| Candle diff | M1 `mid` shamoylar ustma-ust qo'yilib, OHLC farq %, missing/gap ro'yxati |
| Qoidalar | **spot vs spot faqat** (GC=F solishtirilmaydi); **hech qanday offset qo'yilmaydi** — farqlar tushuntiriladi (provider pricing, bid/ask tomoni, sham konstruksiyasi: gold-api tick-fold vs OANDA provider OHLC) |

Mavjud o'lchov: gold-api stamp kadeесisi ~30s (§3.1). OANDA stream'da nominal delay sub-second bo'lishi kutiladi, **lekin bu token bilan o'lchanmaguncha da'vo emas**.

---

## 5. ARCHITECTURE COMPATIBILITY (P68-6) — mavjud InspireTrade arxitekturasi bilan

Mavjud pipeline (production, o'zgarmagan):
- **Browser:** 1s gold-api poll (`client/src/lib/spot-tail.ts` — `spotTickerOn`), recorder (`shared/spot-recorder-core.ts`), live-tail merge (`mergeSpotTail`), feed-health (`healthFromDelay` — LIVE/DELAYED/STALE/PROVIDER ERROR);
- **Server:** `/api/quotes` proxy (`api/_src/quotes.ts`, 14 action: quotes/hist-range/spot-history/backfill-spot/backfill-metals/feed-status…), gold-api fetch (satr 204, 30s TTL), TwelveData backfill, Duka/stooq day-shards;
- **Storage:** RTDB `spotTicks/{code}/{minute}` (65 kun), shamlar serverda fold qilinadi;
- **Infra:** Vercel Hobby — serverless, 12-funksiya limiti, persistent ulanish yo'q.

OANDA integratsiya nuqtalari (faqat tahlil — amalga oshirilmagan):

| Komponent | Moslik | Izoh |
|---|---|---|
| Quote provider arxitekturasi | ⚠ server-side only | Token frontend'ga chiqmaydi; `/api/quotes`'da yangi action yoki o'rniga. `spot-recorder-core` semantikasi (minute bucket, envelope) OANDA M1 shamlar bilan mos — `s=0` provider bar yo'li allaqachon bor |
| M1 recorder | ✔ mos | OANDA bid/ask/mid shamoylari recorder'ga to'g'ridan-to'g'ri qo'shiladi; `providerMinuteBucket` ishlatilmaydi (sham allaqachon minute-aligned) |
| Server-side recorder | ⚠ serverless cheklovi | 1s poll serverda = 86,400 req/kun — limit OK, **lekin** Vercel Hobby'da cron 1-s davomiylikni bermaydi; stream umuman imkonsiz. Hokey yechim: browser-poll qoladi yoki cron 1min |
| RTDB candle storage | ✔ mos | XAU_USD M1 → mavjud `spotTicks` shemasi (t,o,h,l,c,s) to'g'ridan-to'g'ri; `s=0` sifatida yozish mavjud konventsiya |
| Historical loading | ✔ texnik, ✗ huquqiy | 5000/page pagination mavjud `hist-range` day-shard konventsiyasiga ko'chiriladi |
| HTF aggregation | ✔ mos | Serverda `aggregateBars` (shared/terminal.ts) allaqachon M1→M5…D fold qiladi |
| Feed health | ✔ mos | `healthFromDelay` OANDA `time` stamp bilan to'g'ridan-to'g'ri; stream heartbeat 5s STALE-detektori uchun ideal |
| LIVE/DELAYED/STALE statuslari | ✔ mos | OANDA `status: tradeable/non-tradeable` → PROVIDER-ERROR holatining haqiqiy manbasi |
| TradingView chart | ✔ mos | Bar shakli standart OHLC — o'zgarish shart emas |

**Ro'l bo'yicha xulosalar:**
- **A. Primary live provider — YO'Q.** (1) License §3.2 foydalanuvchilarga display taqiqlaydi; (2) demo ≠ live; (3) Vercel serverless stream ushlab turolmaydi; (4) 1s REST poll serverda Hobby'da cron chegarasi bilan faqat 1min kadeесiga mos.
- **B. Primary historical provider — YO'Q** (xuddi shu litsenziya; XAU_USD M1 chuqurligi o'lchanmagan).
- **C. Ikkalasi — YO'Q.**
- **D. Secondary/fallback — SHARTLI YO'Q** foydalanuvchi ko'radigan har qanday ma'lumot uchun (huquqiy taqiq). Server ichida, foydalanuvchiga ko'rsatilmaydigan **diagnostik/taqqoslash** maqsadida (Internal Use) — huquqiy jihatdan mudofaalanadigan yagona variant. Haqiqiy integratsiya yo'li — **BYO OANDA akkaunt** funksiyasi (har foydalanuvchining o'z tokeni, o'z savdosi uchun; §3.1(a) "custom interface" doirasi) — bu alohida phase va alohida qaror.

---

## 6. COST & FREE ACCESS (P68-7)

| Band | Holat |
|---|---|
| Practice (demo) akkaunt | **Bepul** (fxTrade Practice — rasmiy demo sahifalar; odatda $100k virtual mablag' bilan — ro'yxatdan o'tishda aniqlashtiriladi) |
| API access (practice) | **Bepul, to'liq** (practice REST+stream xuddi shu v20 API) |
| API access (live) | Alohide API subscription **yo'q** — token faqat trading akkaunt talab qiladi |
| Akkount funding | Live uchun: depozit kerak (eng kichik summa entityga bog'liq); Practice uchun **mablag' kerak emas** |
| Monthly subscription | API uchun yo'q; Litsenziyada "License Fees" ta'rifi bor — standart trading-akkaunt API'sida amaliy to'lov ko'rinmadi, lekin kommersiya ma'lumot-licensing (foydalanuvchilarga ko'rsatish) alohida kelishuv + narx |
| Geografik | O'zbekiston rasmiy "accepted traffic" ro'yxatida (§2.8); akkaunt ochish KYC/entityga bog'liq — garantia yo'q |
| Kommersiya | **§3.2: foydalanuvchilarga display/redistribution TAQIQ** — alohida kelishuvsiz InspireTrade'da ko'rsatish huquqan mumkin emas |
| Demo pricing | Hech qachon live sifatida ko'rsatilmaydi (§2.7) |

---

## 7. SECURITY (P68-8) — kelajakdagi har qanday integratsiya uchun majburiy qoidalar

- Token **faqat** Vercel secure environment variablelari (`OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENVIRONMENT`); frontend bundle'da hech qachon yo'q;
- GitHub'ga secret tushmaydi (bu hisobotda ham hech qanday secret yo'q — ular umuman mavjud emas);
- Barcha OANDA so'rovlari **server-side** (`/api/quotes` ichida yoki alohida funksiya) — browser to'g'ridan-to'g'ri OANDA'ga ulanmaydi;
- Vercel Hobby: 12-funksiya limiti — yangi funksiya ochish o'rniga mavjud `quotes.ts` action'iga qo'shish; stream uchun Hobby umuman mos emas;
- Rate-limit: 120 req/s **per IP** — Vercel'da chiqish IP havzasi umumiy; barcha funksiyalar bitta limitni bo'lishadi (1s poll 1 req/s — xavfsiz).

---

## 8. TESTING & EVIDENCE (P68-9)

Rasmiy manbalar (ochilgan, iqtibos keltirilgan):
1. developer.oanda.com/rest-live-v20/development-guide — rate limits (120 req/s, 429, 20 stream, 2 conn/s), practice/live URL'lar;
2. developer.oanda.com/rest-live-v20/introduction — v20 account talabi;
3. developer.oanda.com/rest-live-v20/pricing-ep — stream semantikasi (4 narx/s/instrument, 250ms oyna, heartbeat 5s, `since` polling, snapshot);
4. developer.oanda.com/rest-live-v20/pricing-df — ClientPrice schema (bids/asks/closeout/time RFC3339);
5. developer.oanda.com/rest-live-v20/instrument-df — granularlar (S5…M), mid/bid/ask, `complete` flag;
6. legal.oanda.com/oc/api_license_agreement_oc/en — API License Agreement (2026-08, 11 bet): §3.1 grant, §3.2 Internal Use + third-party display taqiq, 1 kunning ishbilarmonlik ogohlantirishi bilan terminate;
7. oanda.com/eu-en/partners-global/…/which-countries-does-oanda-accept-traffic — **Uzbekiston** ro'yxatda;
8. oanda.com/au-en/trading/platforms/rest-api — "deep historical data back to 2005" (marketing);
9. oanda.com/bvi-en/cfds/instruments/xau-usd — XAU_USD instrument sahifasi;
10. oanda-api-v20.readthedocs.io (wrapper) — 5000/page limit (ikkilamchi manba);
11. gold-api.com/price/XAU — 12 namuna real o'lchov (§3.1).

O'lchov skriptlari: `scripts/p68-goldapi-bench.sh`, `scripts/p68-search.sh`. Fabricatsiya yo'q: OANDA javoblari bo'lmagan bo'limlar aniq "bloklangan — token kerak" deb belgilandi.

---

## 9. FINAL REPORT — 10 JAVOB

1. **OANDA XAU_USD beradimi?** Ha — API'da XAU_USD (spot FX-uslub, ounslarda) mavjud; aniq akkaunt darajasidagi tasdiqlash token bilan `instruments` endpoint orqali.
2. **Free practice/demo ishlaydimi?** Ha — fxTrade Practice bepul va practice REST+stream to'liq API beradi (URL'lar §2.1); demo ≠ live pricing.
3. **M1 tarix beradimi?** Granularity M1 mavjud, 5000/request pagination bilan; **XAU_USD M1 amaliy chuqurligi o'lchanmagan** (token kerak).
4. **Live streaming?** Ha — rasmiy pricing stream: ≤4 narx/s/instrument, 5s heartbeat, RFC3339 ns timestamp, bid/ask liquidity bilan; **Vercel serverless'da persistent stream mumkin emas**.
5. **Measured latency?** O'lchanmagan (token yo'q). gold-api baseline: RTT ~0.53s, stamp delay 2–30s. OANDA nominal delay sub-second kutiladi — da'vo emas, o'lchov kerak.
6. **gold-api bilan taqqos?** Live taqqos bloklangan; framework §4. Strukturaviy farq: OANDA bid/ask + 4 upd/s vs gold-api faqat mid + ~30s stamp.
7. **InspireTrade uchun mosmi?** Texnik: ha. **Huquqiy: yo'q** — §3.2 foydalanuvchilarga ko'rsatishni taqiqlaydi; demo pricing live sifatida ko'rsatilmaydi; serverless stream ushlab turolmaydi.
8. **Xarajat/cheklovlar?** Practice+API bepul; live uchun trading akkaunt; kommersiya display uchun alohida licensing kelishuvi kerak; O'zbekiston "accepted traffic"da (akkaunt ochish KYC'ga bog'liq).
9. **Nima kerak?** Practice akkaunt ochish + Personal Access Token + accountID → Vercel secure env'larga; so'ng §3.2 reja bo'yicha real candles/stream o'lchovlari va §4 taqqoslash.
10. **Qaysi ro'l?** Platform data-provider sifatida — tavsiya etilmaydi. Yagona mantiqiy yo'l: foydalanuvchining o'z OANDA akkaunti (BYO token) uchun savdo-ruhsatnoma funksiyasi — alohida qaror bilan.

## YAKUNIY TAVSIYA

### **NOT RECOMMENDED** — InspireTrade platformasining XAUUSD data-provider sifatida.
Sabab: API License Agreement §3.2 (third-party display taqiq) — bu gold-api.com'ning bepul, ochiq kotirovka modeliga qaraganda mahsulotimiz uchun hal qiluvchi cheklov; demo≠live va serverless stream cheklovi qo'shimcha. Integratsiya faqat foydalanuvchi o'z akkauntini ulash varianti sifatida, alohida phase'da va foydalanuvning aniq roziligidan keyin ko'rib chiqiladi.

---
*Phase 68 production'ga hech qanday o'zgarish kiritmadi: gold-api.com, recorder, RTDB shemalar, chart rendering, provider prioritetlar va SEO hammasi o'zgarmagan.*
