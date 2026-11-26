# PHASE 69 — GOLD-API.COM DEEP AUDIT, OHLC CAPABILITIES & XAUUSD DATA QUALITY

**Status:** AUDIT AND TEST ONLY — production o'zgarmagan (gold-api feed, recorder, RTDB shemalar, chart, SEO, Vercel limitlar).
**Sana:** 2026-11-26 · **Metod:** kod auditi (haqiqiy HEAD `3812974`, P67 = `26b60cf` + hotfix `4e0ab15`), rasmiy hujjatlar (faqs/pricing/terms/docs/llms.txt), real HTTP testlar.

---

## 0. EXECUTIVE SUMMARY

**Tavsiya: KEEP FREE PLAN.**

gold-api.com'ning `/ohlc` endpointi **shamlar seriyasi EMAS** — u bitta vaqt oralig'i uchun bitta `{open, high, low, close}` obyekti qaytaradi; `/history` esa har davr uchun faqat bitta agregatsion narx (`max_price`/`min_price`/`avg_price`) beradi (minute/hour grouping faqat Premium'da, va baribir O/C yo'q). Ya'ni **hech qanday reja (Premium ham) gold-api'dan M1 OHLC SERIES bermaydi** — bu endpoint shu uchun yaratilmagan. InspireTrade'ning Phase 16/67 self-recording M1'ining sifati allaqachon shu provider'ning publish kadeесiga bog'liq bo'lgan limitga yaqin (o'lchandi: bir daqiqada o'rtacha **2.94** xil narx darajasi — provider ~30s da bir yangilanadi).

Premium $10/mo live chartni **umuman tezlashtirmaydi** (narx har 30 sekundda yangilanadi — FAQ rasmiy jumla, barcha rejalarda bir xil); faqat keyed endpoint'lar byudjetini ochadi. Material yaxshilanishning yagona nomi — provider'ning ichki minut H/L aniqligi bizning 1s namunalarimizdan yaxshimi yo'qmi, va **buni BEPUL kalit bilan 10 so'rovda hal qilish mumkin** (10 ta /ohlc minut-so'rovi = 10 daqiqa solishtirish). U test o'tsa — Premium o'sha payt ko'riladi.

---

## 1. CURRENT INTEGRATION AUDIT (haqiqiy kod asosida)

### 1.1 Live XAUUSD narxi — gold-api'dan TO'G'RIDAN-TO'G'RI
| Yo'l | Kod | Detal |
|---|---|---|
| Browser 1s poll | `client/src/lib/market-data.ts:1143` | `GET https://api.gold-api.com/price/XAU` — CORS *, kalitsiz; bir aloqa per metal (spotTickerOn) |
| Server overlay | `api/_src/quotes.ts:204` | xuddi shu endpoint, `SPOT_TTL_MS=30000` cache + 10 daqiqadan eski stamp = bozor yopuq (paint yo'q) |
| Quote panels | `useServerQuote` (P67 MEDIUM-4) | refcounted 3s poller `/api/quotes?action=quotes` → ichida 30s spot cache |

### 1.2 updatedAt — provider stamp'i
- Client: `recordSpot`/`mergeSpotTail` provider stamp'ni qabul qiladi (P67 §5) — foydalanuvchi soati noto'g'ri bo'lsa ham M1 grid to'g'ri; kechikkan namunalar sanaladi va tashlanadi.
- Server: `providerMinuteBucket()` — stamp mahalliy soatdan ±120s ichida bo'lsa provider soati, aks holda lokal soat; bitgan daqiqaga kechikkan namuna **tashlanadi** (retroaktiv yozuv yo'q).

### 1.3 Recorderlar
- **Client (Phase 16):** har 1s kuzatilgan narx minut shamlariga fold qilinadi (`o=birinchi, h=max, l=min, c=oxirgi, s=namunalar, cap 60`), ±2% glitch guard (30 daqiqa anchor), market-hours gate; bitgan minutlar localStorage (3 kun cap) → har ~20s da `POST spot-record` (≤4 record × ≤40 sham).
- **Server (Phase 67):** `api/_src/lib/spot-recorder.ts` — trading-cron self-continuing chain'ga qo'shilgan (browser yo'q bo'lsa ham yozadi): har hop'da bitta namuna per kod, RTDB-transaction claim ≥15s (dubl-yozuv imkonsiz), sessiya gate, 2% glitch guard, late-drop, idempotent fold (`shared/spot-recorder-core.ts` — client bilan BIR semantika), diagnostics `diag/spotRecorder/{code}`.

### 1.4 RTDB va tarixiy shamlar
- Store: `spotTicks/{XAU|XAG}/{minute} = {o,h,l,c,s}`; serve: tf=60 → oxirgi **65 kun**; tf>60 → to'liq store fold, ≤4000 bar.
- Sifat qatlamlari: yozishda (align, envelope, price-band, closed-session gate, s∈[1,60]) + o'qishda (`filterClosedCandles` → `validateBars` → `aggregateBars` → `repairOutlierExtremes`).
- Tarixiy manbalar: **TwelveData provider M1 (s=0)** backfill (P28: s=0 provider bar 1-2 namunalik recorded dot bilan "degrade" bo'lmaydi — faqat envelope kengayadi), Dukascopy BID day-shards chuqur tarix, stooq daily. Duka-BID↔spot offset **o'lchanadi, hech qachon narxga qo'llanilmaydi** (`computeBidSpotOffset`, ≥8 overlap, faqat disclosure).
- Live qatlam: `mergeSpotTail` gap'larni FLAT bar bilan ko'priklaydi (o=h=l=c=prev close, volume 0, haqiqiy timestamp) — faqat ekranda, store'ga yozilmaydi.

### 1.5 OHLC endpointlarning hozirgi ishlatilishi va rate-limit
- `/ohlc` va `/history` kodda **0 ta havola** (grep isbot) — hozir umuman ishlatilmaydi.
- Rate-limit handler: /price uchun kerak emas (cheksiz, 0 fail P67'da ham bugun ham); TD uchun kunlik RTDB counter bor (8 req/min byudjet).

### 1.6 Qayerdan nima keladi (javob §1.7)
| Ma'lumot | Manba |
|---|---|
| Live narx + stamp | gold-api.com /price — to'g'ridan-to'g'ri |
| M1 shamlar | **Ichki konstruktsiya** — 1s namunalardan fold (client+server) |
| Tarixiy M1 bo'shliqlari | TwelveData provider bars (s=0) — boshqa provider |
| Chuqur tarix (kunlik) | Dukascopy BID shards + stooq — boshqa manba |
| HTF (M5…D) | Ichki aggregateBars fold |
| Live-tail flat ko'priklar | Ichki (mergeSpotTail) |

---

## 2. OFFICIAL OHLC CAPABILITY (rasmiy llms.txt + docs + faqs — ochildi)

### 2.1 Aniq endpointlar (asosiy URL `https://api.gold-api.com`)
1. **GET /price/{symbol}[/{currency}]** — FREE, kalitsiz, cheksiz; cache-control header keyingi yangilanish sekundini bildiradi; **narx har 30 sekundda yangilanadi** (rasmiy FAQ).
2. **GET /symbols** — FREE, kalitsiz.
3. **GET /history** — **x-api-key MAJBURIY**; paramlar: `symbol`, `startTimestamp`, `endTimestamp` (unix sec), `groupBy` = year|month|week|**day (free)**, **hour|minute (PREMIUM ONLY)**, `aggregation` = max|min|avg, `orderBy` = asc|desc. **Javob: har davr uchun BITTA narx** (`{"day":"2026-07-01","max_price":4200.5}`) — **OHLC EMAS**.
4. **GET /ohlc/{symbol}** — **x-api-key MAJBURIY**; `startTimestamp`/`endTimestamp` (default: 1800-yil → hozir). **Javob: BITTA obyekt** `{open, high, low, close, highLowChangePercent, openCloseChangePercent, startTimestamp, endTimestamp}` — **BITTA ORALIQ = BITTA SHAM, series yo'q**.

### 2.2 Granularlik bo'yicha real imkoniyat
| TF | /ohlc yechimi | /history yechimi | Free 10 req/h'da amaliy? |
|---|---|---|---|
| M1 | 1 so'rov / daqiqa (doimiy 1 req/min) | groupBy=minute (Premium) **lekin faqat max/min/avg — O/C yo'q** | Yo'q |
| M5/M15/M30 | har sham uchun 1 so'rov | yo'q (hour grouping Premium'da ham bitta agregat) | Yo'q |
| H1/H4 | har sham uchun 1 so'rov | yo'q | Yo'q |
| **D** | **1 so'rov / kun** (`start=day_start&end=day_end`) | groupBy=day (free!) — faqat bitta agregat | **Ha — 65 kun = bir soatda 8-9 so'rov** |

### 2.3 Credentials holati (haqiqiy javoblar, ixtiro yo'q)
- Repo/env/RTDB'da gold-api key **yo'q** (env faqat DATABASE_URL; kodda gold-api key nomi ham yo'q).
- Real probe (2026-11-26): `GET /ohlc/XAU` va `GET /history` key'siz → **HTTP 401 `{"error": "No x-api-key header."}`** (har ikkisi) — auth talabi isbotlangan.
- Kerak: bepul akkount (karta yo'q) → Dashboard → API Keys → key → Vercel secure env `GOLD_API_KEY` (faqat server-side; llms.txt rasmiy ogohlantirish: "Never put an API key in frontend code").

---

## 3. DATA QUALITY COMPARISON (haqiqiy o'lchovlar)

### 3.1 Provider live spot — bugungi test (30 namuna × 5s, ~2.5 min)
| Metrika | Natija |
|---|---|
| HTTP xatolar | **0/30** |
| Stamp yangilanish kadeесi | **anjir 30.0s** (min=max=30.0, 6 xil stamp, 5 narx o'zgarishi) |
| cache-control header | `public, max-age=10..18` — keyingi yangilanishgacha hisob-kitob, FAQ da'vosini tasdiqlaydi |
| RTT (sandbox) | ~555ms |
| **Provider stamp kechikishi** | **mean 101.2s, p50 93.2s, max 183.2s** — sandbox soati server Date header bilan sekund-aniq bir xil tekshirildi (14:59:15Z = 14:59:15Z) |

**Kritik topilma:** stamp lag barqaror emas — P67 (2026-11-19): mean 15.1s / max 30s; P68 bench (bugun 06:14 UTC): 2-30s; **bugun 14:55-14:58 UTC: 93-183s**. Ya'ni "live" narx ba'zi soatlarda devorga nisbatan ~3 daqiqa orqada. Bizning health badge (live ≤15s, delayed ≤90s, stale >90s) o'sha daqiqada **STALE** ko'rsatardi — to'g'ri ishladi. Bu P67'dagi DELAYED/STALE chegaralarini tasdiqlaydi va "provider update frequency premium'da tezlashadi" degan taxmingni yanada shubhalilashtiradi (lag upstream'da).

### 3.2 Ichki recorded M1 sifati (P67 harness artefaktlari — terminal-identical semantika)
`download/xauusd_m1_monitor/` (2026-11-19, 30.2 min session): 31/31 sham, minut-aligned UTC, dublikat yo'q, open-session minut yo'qolmagan, envelope to'g'ri, **avg 49.7 namuna/sham**, 1 ta close-only dot (yozuv boshlanishi), recompute mismatch 0, GC=F bilan faqat basis disclosure (-1.83 — boshqa instrument).

Yangi statistika (shu artefaktlardan hisoblandi):
| Metrika | Qiymat |
|---|---|
| Bir daqiqadagi xil provider narxlari | **mean 2.94 (min 1, max 3)** — 30/31 daqiqada aynan 3 daraja |
| Minut H-L diapazoni | mean **$4.93 (0.14%)**, median $4.80, max $11.75 |
| Bitgan minut tarkibi | namunalar 30s-kadeес bo'yicha 2-3 "qadam"dan iborat |

**Xulosa:** 1s poll'ning o'zi minut ichida ~2 ta REAL narx o'zgarishini tutadi (provider har 30s da yangilaydi) — bizning M1 H/L aniqligi **provider publish kadeесining tabiiy chegarasida**. Provider OHLC bu chegaradan faqat o'z ichki manbasi yuqori chastotali bo'lsa yaxshi bo'lishi mumkin — kalit'siz tekshirib bo'lmaydi (§5'da bepul test reja).

### 3.3 Production recorded store
`https://inspiretrade.vercel.app/api/quotes?action=spot-history` → **HTTP 401** (auth-gated — kutilgan holat, terminal login talab qiladi). Tashqi audit store'ni anonim o'qiy olmaydi — sifat isbotlari P67 harness'idan (ayni semantika).

### 3.4 OHLC endpointlar vs recorded
Kalit yo'qligi uchun solishtirish o'tkazilmadi (401 isbot §2.3); javoblar hech qanday shaklda ixtiro qilinmagan. Solishtirish framework'i §4.3'da (bepul, 10 so'rovli "decisive test").

---

## 4. FREE PLAN OPTIMIZATION DIZAYNI (10 req/h shared — faqat dizayn, kod yo'q)

### 4.1 Tamoyillar
1. **Yagona server requester** — keyed endpoint'larga faqat server chaqiradi (mavjud trading-cron chain / quotes route), kalit faqat Vercel env; frontend'da yo'q (llms.txt rasmiy talabi ham shu).
2. **Single-flight + 30s+ TTL cache** — paralel foydalanuvchilar bitta javobni bo'lishadi; /price uchun cache-control `max-age` hurmat qilinadi (bugungi header 10-18s — hozirgi 1s client poll ~29/30 redundancy).
3. **RTDB dedupe** — natija kalit-hash bilan yoziladi, takroriy so'rov bir xil natijani beradi.
4. **10 req/h byudjet jadvali (tavsiya etilgan taqsimot):**
   - **7 so'rov/soat:** kunlik OHLC backfill rotatsiyasi — bir soatda 7 kun (`/ohlc/XAU?start={d0}&end={d1}`), 65 kunlik oyna ~9 soatda to'ldiriladi, keyin har soatda faqat yangi kun (aslında 1/kun kifoya — qolgan byudjet zaxira);
   - **2 so'rov/soat:** bo'sh kunlarni qayta tekshirish (TD gap-fill bilan solishtirish);
   - **1 so'rov/soat:** zaxira (xato qayta urinishi).
5. **/history free'da ishlatilmaydi** — free'da u ham kunlik agregat (bitta narx), Duka/stooq kunlik OHLС allaqachon yaxshiroq; 10/h byudjeti to'liq /ohlc'ga.

### 4.2 Free'da MUMKIN bo'lgan aniq yaxshilanishlar
- **Kunlik OHLС aniqligi:** hozir daily barlar Duka BID/stooq'dan — gold-api /ohlc kunlik OHLС'ni (spot tomonda) anchor/tekshiruv sifatida qo'shish mumkin (s=0 konventsiyasi kabi source-belgi bilan).
- **Redundant poll kamayishi:** server fetchSpot cache-control max-age'ga qarshi (hozir qattiq 30s TTL — aslida yaxshi, lekin client 1s poll + P67'dan beri hech qanday "provider said cache me" ishlash yo'q).
- **Feed-statusga OHLC nazorati:** kunlik provider OHLС vs store fold — kunlik yopilish farqi % sifatida diag'ga (honest disclosure).

### 4.3 Bepul "DECISIVE TEST" (Premium qaroriga asos) — 10 so'rovda
Bepul kalit olingach: o'tgan soatning **10 ta tanlangan daqiqasi** uchun `/ohlc/XAU?start={m}&end={m+60}` → 10 so'rov (butun soatlik byudjet). Har natijani o'sha daqiqa recorded M1 bilan solishtiring:
- Agar provider H/L ≈ recorded H/L (±0.05%) → **provider minut ichida biznikidan finkor emas** → Premium M1 uchun bema'ni → KEEP FREE yakunlanadi.
- Agar provider H/L barqaror kengroq bo'lsa → provider ichki manbasi yuqori-chastotali → Premium minut OHLC uchun ko'riladi (lekin series API baribir yo'q — integration shakli: 1 req/min /ohlc cron → alohida source-tag store, alohida phase).

---

## 5. PREMIUM $10/MONTH BAHOLASH

| Da'vo | Haqiqat |
|---|---|
| Unlimited OHLC/history | ✓ ha — lekin /ohlc series beravermaydi: minut seriya uchun doimiy 1 req/min kerak (FAQ anti-spam: "/history and /ohlc… never send many requests per second, on any plan including Premium" — 1 req/min munosib, ammo bu "unlimited" cheklovi emas) |
| Minute/hour aggregations | ✓ faqat /history'da — **bitta agregat narx per minut (max/min/avg), OHLC yo'q**; chart M1 shamlari sifatida to'g'ridan-to'g'ri ishlatib bo'lmaydi |
| Live update tezligi yaxshilanadimi? | **YO'Q** — rasmiy FAQ: "Prices only change every 30 seconds" (barcha rejalarda); Premium request byudjetini ochadi, data freshness'ni emas |
| Live latency yaxshilanadimi? | **YO'Q** — stamp lag upstream'da (bugun 93-183s o'lchandi; P67'da 15-30s) — reja bilan bog'liq emas |
| Tarixiy chuqurlik | minut tarix chuqurligi hujjatda ko'rsatilmagan — kalit bilan tekshirish kerak; kunlik "back to 1800" (default start) |
| Komersiya cheklovlari | Terms: kommersiya ishlatish ruxsat etilgan; spam ban (IP/akkount) xavfi; /ohlc doimiy 1 req/min Premium'da ham "space out requests" talabiga mos |
| Narx/jasorat | $10/mo — arzon, **lekin bugungi holatda material foyda isbotlanmagan** |

**Xulosa:** Premium'ning yagona material potensiali — minut ichki H/L sifati (§4.3 test) va /history minut aggregatining chuqurligi. Ikkalasi ham kalit'siz isbotlanmagan. Hozircha **Premium byudjeti muammoni hal qilmaydi**: bizning live tail allaqachon 1s namunalar bilan provider'ning publish chegarasida, tarix esa TD (s=0) + Duka bilan to'ldirilgan.

---

## 6. SERVER RECORDER MOSLIGI (provider OHLC integratsiya qilinsa)

| Xavf | Mavjud mudofaa (P67) | Provider-OHLC holati |
|---|---|---|
| Dublikat sham | `foldSample` idempotent RTDB transaction; claim ≥15s | /ohlc har so'rov bitta oraliq — minut kaliti bilan idempotent yozish mos |
| Noto'g'ri overwrite | stored open qoladi, incoming close yutadi; s=0 provider bar himoyasi | provider OHLС **butun shamni** beradi — merge qoidasi yangi talab: s=0 style "provider-butun" bar sifatida yozilishi kerak, recorded s≥3 faqat envelope kengaytiradi (hozirgi qoidaga to'g'ridan-to'g'ri mos) |
| Historical/live konflikt | Duka BID ↔ spot offset faqat disclosure | provider kunlik OHLС (spot tomoni) Duka BID kunlari bilan farq qiladi — source-tag + disclosure shart; aralashtirish taqiqlangan |
| False volume | s = namunalar soni (cap 60) — volume EMAS | gold-api'da volume umuman yo'q — s-semantika saqlanadi, volume ixtiro qilinmaydi |
| Sessiya nomuvofiqlik | closed-session gate yozuvda ham, o'qishda ham | /ohlc kunlik so'rovida session-interval bilan kesish tekshiruvi qo'shiladi (juma→dushanba gap o'z-o'zidan to'g'ri) |
| Timestamp | provider stamp bucketing (±120s guard) | /ohlc startTimestamp unix sec UTC — minut gridimiz bilan bir xil; "open = start DAQIQASIDAGI birinchi narxmi yoki keyingi tickmi" aniqlanishi kalit bilan testda |

**Honest gaps saqlanadi:** provider ma'lumot yo'q joyga hech narsa yozilmaydi; feed-status'da source bo'yicha coverage ko'rsatiladi. **Diqqat:** butun shamni yozuvchi yangi manba hozirgi `{o,h,l,c,s}` shemasiga yangi s-konventsiya talab qiladi — bu **RTDB schema o'zgarishi** bo'lib, alohida phase'da va aniq rozilik bilan qilinadi.

---

## 7. FINAL RECOMMENDATION

1. **Joriy gold-api live data mosmi?** Ha — kalitsiz, bepul, CORS, provider stamp; bugun 0/30 xato, kadeес aniq 30s; lag ba'zan 90-183s → health badge to'g'ri DELAYED/STALE ko'rsatadi (ro'yxatdan o'tgan xatti-harakat).
2. **OHLC endpoint M1'ni yaxshilaydimi?** Series sifatida — **yo'q** (bitta oraliq = bitta sham); minut ichki H/L fineness imkoni bor — isboti bepul testda (§4.3).
3. **Free 10 req/h yetadimi?** Kunlik OHLC sifat uzgarishiga — **ha** (1 so'rov/kun, backfill 7/soat); M1/H1 series'ga — yo'q.
4. **Premium $10/mo materialmi?** Hozircha — **yo'q**: live cadence 30s (barcha rejalarda), /history minut bitta agregat (O/C yo'q), stamp lag upstream. Faqat §4.3 test "provider finkor" desa ko'riladi.
5. **Eng yaxshi arxitektura:** live tail = mavjud self-recording (client 1s + server cron 15-30s, provider-stamped); tarix = TD s=0 + Duka/stooq; keyed gold-api faqat server-side kunlik OHLC anchor + diag; cache-control + single-flight + RTDB dedupe.
6. **Aniq mumkin bo'lgan yaxshilanishlar (free):** (a) cache-control max-age hurmati (redundant 1s poll kamayadi); (b) bepul kalit bilan kunlik OHLС anchor (7/soat backfill); (c) feed-status'ga kunlik farq disclosure; (d) §4.3 decisive test.
7. **Qolgan cheklovlar:** bid/ask umuman yo'q; 30s publish kadeесi inherent; minut OHLC series yo'q (Premium ham); stamp lag ~3 daqiqagacha (upstream); production store auth-gated; s-semantikaga yangi manba = schema o'zgarishi (kelajak phase).

### **YAKUNIY TAVSIYA: KEEP FREE PLAN**
Bepul kalit ochish (0 so'm) + §4.3 decisive test → natijaga qaragina Premium savoli qayta ochiladi. Production bu phase'da o'zgarmagan.

---

## 8. EVIDENCE & SOURCES

- **Ochildi/iqtibos:** gold-api.com/faqs ("history and OHLC… free for up to 10 requests per hour, shared"; "Prices only change every 30 seconds, so cache each response for 30 seconds"; "updatedAt… the time we last fetched the price"), /pricing (Free 10/h vs Premium $10: unlimited history + minute/hour aggregations + unlimited OHLC), /terms (kommersiya ruxsat, spam ban), /docs, **/llms.txt** (to'liq endpoint spesifikatsiyasi: /ohlc single-object javob misoli bilan, /history groupBy minute/hour "premium only", "Never put an API key in frontend code", "Commercial use: Always permitted").
- **Real HTTP testlar (2026-11-26):** /price/XAU 30/30 200 (cache-control 10-18s), stamp interval aniq 30.0s, stamp lag p50 93s/max 183s (soat server Date header bilan tekshirilgan); /ohlc + /history key'siz → 401 `{"error": "No x-api-key header."}` (2/2); production spot-history → 401 (auth-gated).
- **Artefaktlar:** `download/p69_probes/` (probe JSON + headerlar + cadence-now.json + p67-candle-stats.json), `download/xauusd_m1_monitor/` (P67 harness), `download/P67_goldapi_measurement.json` (120 namuna: lag mean 16s/p90 28.3s, cadence 26-30s).
- **Skriptlar:** `scripts/p69-probes.sh`, `scripts/p69-cadence.py`.
- **Kod havolalari:** client/src/lib/market-data.ts:1143 (1s poll), spot-tail.ts:62-80 (recorder kontrakt), api/_src/quotes.ts:204 (server spot, 30s TTL), 420-520 (spot-history/record), api/_src/lib/spot-recorder.ts (server recorder), shared/spot-recorder-core.ts (foldSample/health/offset).
- Fabricatsiya yo'q: kalit talab qiladigan endpoint javoblari olinmagan holatlarda "bloklangan — kalit kerak" deb yozildi.
