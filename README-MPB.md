# MPB.com (en-eu) → Google Sheets — monitor cen konkurencji

Autonomiczny scraper uruchamiany **w chmurze GitHub Actions** (niezależnie od Twojego
komputera). Co kilka godzin pobiera ze sklepu **mpb.com** (rynek `en-eu`) używany sprzęt
i zapisuje do arkusza **„MPB"**:

| Kolumna | Skąd pochodzi (`__NEXT_DATA__ → props.pageProps.productInfo`) |
|---|---|
| URL | `https://www.mpb.com` + `pageProps.url` |
| Nazwa | `productInfo.name` |
| Cena | `productInfo.listPrice` |
| SKU | `productInfo.sku` |
| Cosmetic condition | `productInfo.condition` (`WELL_USED` → „Well used") |
| Notes | `observations[].tierDescription` (lista, bullety „- …") |
| What's included | „Standard 12 month warranty" + `priceModifiers` z `present:true` |
| *Ostatnia aktualizacja* (opcj.) | znacznik czasu przebiegu |
| *Status* (opcj.) | `OK` / `SOLD` |

> **To osobny projekt — NIE rusza monitoringu fotoforma.pl.** Tamto to Google Apps Script
> w arkuszu; to jest Node + Playwright w GitHub Actions. Działają niezależnie, piszą do
> różnych zakładek tego samego arkusza.

---

## Dlaczego to nie jest (tak jak Fotoforma) Apps Script?

MPB jest znacznie lepiej zabezpieczone:

1. **Cloudflare „Managed Challenge"** na stronach pojedynczych egzemplarzy
   (`/product/.../sku-<id>`) — klient bez JavaScriptu dostaje HTTP 403. Trzeba prawdziwej
   przeglądarki (Chromium), która wykona JS i przejdzie challenge.
2. **Lista egzemplarzy ładuje się tylko przez wewnętrzne API aplikacji** (`search-service`,
   Solr). Tego API **nie da się wywołać spoza działającej aplikacji** (zwraca błąd / wisi),
   więc discovery musi działać w runtime strony.

Dlatego silnikiem jest **headless Chromium (Playwright)**: wchodzi na strony modeli, czyta
listę egzemplarzy (klikając „See more"), a potem na każdej stronie SKU czyta osadzony JSON
`__NEXT_DATA__`. Cała logika danych jest pewna i maszynowa (nie zależy od wyglądu HTML).

---

## Jak to działa

- **Discovery** — pobiera listę WSZYSTKICH modeli z `…/model-page-sitemap.xml` (**12 647**
  modeli; pobierana przez kontekst przeglądarki, bo Cloudflare bywa dynamiczny), wchodzi na
  kolejne strony modeli (kursor `discoverCursor`), przechwytuje listę egzemplarzy z `search-service`
  + DOM, a dla **nowych** SKU dopisuje pełne dane.
- **Refresh** — odświeża istniejące wiersze (kursor `refreshCursor`): aktualizuje cenę/stan,
  a egzemplarze sprzedane/zniknione (`isSold` / 404) oznacza `SOLD` lub usuwa.
- **Enrichment MASOWY** — 7 pól z każdej strony SKU czytane jest **równoległym `fetch` w kontekście
  strony** (to samo origin + rozgrzane `__cf_bm` = prawdziwy HTML, bez challenge), paczkami po
  `MPB_BULK_CONCURRENCY`. To wielokrotnie szybsze niż nawigacja per-strona (zmierzone ~3 strony/2,5 s).
- **Kursory i stan** w zakładce **`_mpb_state`** (GitHub Actions nie ma trwałego dysku), więc każdy
  przebieg kontynuuje pracę. Po przejściu całej listy modeli kursor wraca na początek (re-crawl).
- Tryb `cycle` (domyślny) robi w jednym przebiegu pół czasu na refresh, pół na discovery.

> **Skala / czas.** Katalog to **~12,6 tys. modeli** i dziesiątki tysięcy egzemplarzy (sztuki
> używane, mocno „churny"). Przy cronie **godzinowym** i ~300 modelach/przebieg pierwszy pełny
> przelot katalogu zajmuje **ok. 1–2 dni**, potem `refresh` utrzymuje dane na bieżąco. To normalne,
> że arkusz zapełnia się stopniowo — kursor pilnuje, by nic nie pominąć. Tempo regulujesz zmiennymi.

---

## Wdrożenie — krok po kroku

### 1. Repozytorium GitHub
Utwórz nowe repo, którego **korzeniem** jest zawartość folderu `mpb-monitor/`
(czyli `package.json`, `scrape-mpb.js`, `sheets.js` i katalog `.github/` leżą bezpośrednio
w korzeniu repo). Wypchnij pliki.

> **Public czy private?** Publiczne repo = **nieograniczone darmowe minuty** Actions
> (zalecane — w kodzie nie ma żadnych sekretów). Prywatne = 2000 min/mc na darmowym planie;
> przy częstym cronie może nie wystarczyć. Sekret z kluczem i tak jest szyfrowany niezależnie
> od widoczności repo.

### 2. Konto serwisowe Google (dostęp do arkusza)
1. Wejdź na <https://console.cloud.google.com> → utwórz/wybierz projekt.
2. **APIs & Services → Enable APIs** → włącz **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account** → utwórz konto.
4. Wejdź w konto → zakładka **Keys → Add key → JSON** → pobierz plik klucza.
5. Skopiuj adres **`client_email`** z tego pliku (np. `mpb-bot@projekt.iam.gserviceaccount.com`).

### 3. Udostępnij arkusz kontu serwisowemu
Otwórz arkusz
<https://docs.google.com/spreadsheets/d/1L31Kl8kop7Zq2fhUI-Is65MPckAo2JLWPC6yl3aoawI/edit>
→ **Udostępnij** → wklej `client_email` → rola **Edytor** → Wyślij.
(Upewnij się, że istnieje zakładka **„MPB"**. Zakładka `_mpb_state` utworzy się sama.)

### 4. Sekret + (opcjonalnie) zmienna w GitHub
Repo → **Settings → Secrets and variables → Actions**:
- **New repository secret**: nazwa `GOOGLE_SERVICE_ACCOUNT_JSON`, wartość = **cała zawartość**
  pobranego pliku JSON (od `{` do `}`).
- *(opcjonalnie)* zakładka **Variables → New variable**: `MPB_SHEET_ID` = ID arkusza
  (domyślne ID jest już w kodzie, więc to tylko gdy zmienisz arkusz).

### 5. Test
Repo → **Actions → „MPB monitor" → Run workflow** → tryb **`selftest`** → uruchom.
W logach zobaczysz pobrany przykładowy produkt (Canon EF 70-300mm) z kompletem 7 pól.
- Jeśli widać poprawne dane → wszystko gra, włącz normalną pracę.
- Jeśli w logach „challenge"/403 → patrz *Rozwiązywanie problemów*.

### 6. Praca automatyczna
Cron jest już ustawiony (co 3 h). Pierwsze pełne zapełnienie katalogu potrwa — możesz
przyspieszyć ręcznymi uruchomieniami w trybie `discover`.

---

## Strojenie (zmienne środowiskowe — w pliku workflow lub jako repo Variables)

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `MPB_MODE` | `cycle` | `cycle` / `refresh` / `discover` / `selftest` |
| `MPB_MAX_RUNTIME_MIN` | `45` | twardy limit czasu przebiegu (job ma `timeout-minutes: 55`) |
| `MPB_MODELS_PER_RUN` | `300` | ile modeli przerobić w discovery na przebieg |
| `MPB_REFRESH_PER_RUN` | `800` | ile istniejących wierszy odświeżyć na przebieg (enrichment masowy) |
| `MPB_BULK_CONCURRENCY` | `10` | ile stron SKU pobierać równolegle (`fetch` w kontekście strony) |
| `MPB_DELAY_MS` | `300` | pauza między modelami w discovery (grzeczność wobec serwera) |
| `MPB_SHEET_ID` | (w kodzie) | ID arkusza docelowego |

Szybsze tempo → zwiększ `MODELS_PER_RUN` / `REFRESH_PER_RUN` / `BULK_CONCURRENCY`, zagęść cron.
Repo **public** = nielimitowane minuty Actions (zalecane). Zbyt duże `BULK_CONCURRENCY` zwiększa
ryzyko blokad Cloudflare — `10` to bezpieczny punkt startowy.

---

## Rozwiązywanie problemów

- **„Brak GOOGLE_SERVICE_ACCOUNT_JSON"** — nie ustawiony sekret (krok 4).
- **403 / The caller does not have permission** — arkusz nie udostępniony na `client_email`
  (krok 3) albo nie włączone Sheets API (krok 2).
- **W logach „challenge" / „Security check"** — Cloudflare zablokował IP runnera. Headless
  Chromium zwykle przechodzi, ale jeśli nie:
  - dodaj pakiet `playwright-extra` + `puppeteer-extra-plugin-stealth` (albo `playwright-stealth`)
    i podłącz w `launch()`, lub
  - przepuść ruch przez proxy rezydencjalne (zmienna proxy w `chromium.launch`/`newContext`).
- **Mało nowych egzemplarzy** — discovery przechodzi katalog porcjami; daj mu kilka–kilkanaście
  przebiegów albo zwiększ `MPB_MODELS_PER_RUN`.

---

## Uwagi

- Egzemplarze MPB to **sztuki używane** — sprzedają się i znikają. Monitoring na poziomie
  pojedynczego SKU jest z natury „churny": skrypt oznacza `SOLD` i usuwa zniknięte wiersze.
- Skrypt czyta wyłącznie **publiczne** strony produktów, w wolnym tempie (pauzy między
  stronami) — to standardowy monitoring cen.
