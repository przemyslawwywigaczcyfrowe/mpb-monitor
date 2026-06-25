/**
 * ============================================================================
 *  MPB.com (en-eu)  →  GOOGLE SHEETS  (monitor cen konkurencji) — PEŁNA OFERTA
 * ============================================================================
 *
 *  Headless browser (Playwright/Chromium) uruchamiany cyklicznie w GitHub Actions.
 *  Zapisuje do arkusza "MPB": URL · Nazwa · Cena · SKU · Cosmetic condition ·
 *  Notes · What's included (+ opcjonalnie: Ostatnia aktualizacja, Status).
 *
 *  DLACZEGO PRZEGLĄDARKA, A NIE ZWYKŁY HTTP / APPS SCRIPT:
 *   - Cały serwis jest za Cloudflare; strony bez rozgrzanego ciasteczka __cf_bm
 *     dostają "Managed Challenge" (HTTP 403, HTML "MPB - Security check").
 *     Prawdziwy Chromium wykonuje JS i przechodzi; potem to samo ciasteczko
 *     działa dla zwykłych żądań fetch z kontekstu strony (to samo origin).
 *   - Lista egzemplarzy ładuje się tylko przez wewnętrzne API (search-service,
 *     Solr) — z zewnątrz zwraca 500/404, więc discovery robimy w runtime strony
 *     (wejście na stronę modelu → przechwycenie odpowiedzi search-service + DOM).
 *
 *  WYDAJNOŚĆ (klucz do "pełnej oferty" = ~12,6 tys. modeli, dziesiątki tys. SKU):
 *   - ENRICHMENT (czytanie 7 pól z każdej strony SKU) robimy NIE przez nawigację
 *     per-strona, lecz RÓWNOLEGŁYM `fetch` w kontekście strony (to samo origin,
 *     rozgrzane ciasteczko) + parsowanie osadzonego JSON `__NEXT_DATA__`.
 *     Zmierzone: ~3 strony / 2,5 s; z paczkami po BULK_CONCURRENCY wielokrotnie
 *     szybciej niż goto-per-URL.
 *   - DISCOVERY (lista SKU modelu) wymaga nawigacji na stronę modelu (search-service
 *     działa tylko z runtime aplikacji). Kursor w arkuszu rozkłada 12,6 tys. modeli
 *     na wiele przebiegów (re-crawl wyłapuje nowości).
 *
 *  ŹRÓDŁO DANYCH (pewne, maszynowe): <script id="__NEXT_DATA__"> →
 *     props.pageProps.productInfo: name, listPrice, sku/fullSku, condition
 *     (enum WELL_USED → "Well used"), observations[].tierDescription (= Notes),
 *     priceModifiers[present].name (= What's included + stała "Standard 12 month
 *     warranty"), pageProps.url, isSold.
 *
 *  KONFIGURACJA — zmienne środowiskowe (sekrety/vars GitHub Actions):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  (wymagane) — klucz konta serwisowego (cały JSON)
 *   MPB_SHEET_ID                 (opcj.)    — ID arkusza (domyślnie poniżej)
 *   MPB_MODE                     (opcj.)    — selftest | refresh | discover | cycle (domyślnie)
 *   MPB_MAX_RUNTIME_MIN / MPB_MODELS_PER_RUN / MPB_REFRESH_PER_RUN /
 *   MPB_BULK_CONCURRENCY / MPB_DELAY_MS (opcj.)
 * ============================================================================
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());                       // headless mniej wykrywalny dla Cloudflare
const { SheetClient, normalizeUrl } = require('./sheets');

const BASE = 'https://www.mpb.com';
const LOCALE = 'en-eu';

const CONFIG = {
  SPREADSHEET_ID: process.env.MPB_SHEET_ID || '1L31Kl8kop7Zq2fhUI-Is65MPckAo2JLWPC6yl3aoawI',
  SHEET: 'MPB',
  MODEL_SITEMAP: `${BASE}/${LOCALE}/model-page-sitemap.xml`,
  EXAMPLE_SKU: `${BASE}/${LOCALE}/product/canon-ef-70-300mm-f-4-5-6-is-usm/sku-3943035`,

  MAX_RUNTIME_MS: (parseInt(process.env.MPB_MAX_RUNTIME_MIN || '45', 10)) * 60 * 1000,
  MODELS_PER_RUN: parseInt(process.env.MPB_MODELS_PER_RUN || '300', 10),    // ile modeli w discovery / przebieg
  REFRESH_PER_RUN: parseInt(process.env.MPB_REFRESH_PER_RUN || '800', 10),  // ile istniejących wierszy odświeżyć / przebieg
  BULK_CONCURRENCY: parseInt(process.env.MPB_BULK_CONCURRENCY || '10', 10), // równoległe fetch-e w kontekście strony
  EVAL_BATCH: 30,                                                           // ile URL-i na jedno page.evaluate
  DELAY_MS: parseInt(process.env.MPB_DELAY_MS || '300', 10),               // pauza między modelami w discovery
  NAV_TIMEOUT: 45000,
  SEE_MORE_GUARD: 80,                                                       // limit klików "See more" na model
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* --------------------------------------------------------------------------
 *  MAPOWANIE PÓL
 * ------------------------------------------------------------------------ */
function conditionDisplay(enumVal) {
  if (!enumVal) return '';
  const s = String(enumVal).toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);           // WELL_USED → "Well used"
}
function toPrice(listPrice) {
  if (listPrice == null) return '';
  const s = String(listPrice).replace(/[^\d.,]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : String(listPrice);
}
function mapProduct(detail) {
  const pi = detail.productInfo;
  const notes = (pi.observations || []).filter(Boolean).map((s) => '- ' + s).join('\n');
  const included = ['- Standard 12 month warranty']
    .concat((pi.priceModifiers || []).map((n) => '- ' + n)).join('\n');
  return {
    url: detail.urlPath ? BASE + detail.urlPath : detail.requestedUrl,
    name: pi.name || '',
    price: toPrice(pi.listPrice),
    sku: String(pi.sku || ''),
    condition: conditionDisplay(pi.condition),
    notes,
    included,
    updated: new Date().toISOString().slice(0, 19).replace('T', ' '),
    status: pi.isSold ? 'SOLD' : 'OK',
    isSold: !!pi.isSold,
  };
}

/* --------------------------------------------------------------------------
 *  PRZEGLĄDARKA
 * ------------------------------------------------------------------------ */
async function launch() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: CONFIG.USER_AGENT,
    locale: 'en-GB',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(CONFIG.NAV_TIMEOUT);
  return { browser, context, page };
}

// Wejście na stronę nie-chronioną → Cloudflare ustawia/odświeża cookie __cf_bm w kontekście.
// __cf_bm żyje ~30 min, więc rozgrzewamy na starcie i ponawiamy, gdy fetch-e zaczną dostawać challenge.
// Cloudflare pokazuje różne tytuły challenge: "Just a moment..." (standard) i "MPB - Security check"
// (managed). Oba rozwiązują się SAME po wykonaniu JS przez prawdziwą przeglądarkę — trzeba poczekać.
const CHALLENGE_RE = /just a moment|security check|attention required|checking your browser|enable javascript and cookies/i;
const isChallengeTitle = (t) => CHALLENGE_RE.test(t || '');

// Rozgrzewka: wejście na stronę nie-chronioną; ponawia aż Cloudflare przepuści i ustawi cf_clearance.
// KLUCZOWE: dopiero po realnym przejściu challenge'a (pełną nawigacją) działają potem szybkie `fetch`.
async function warmUp(page) {
  for (let i = 1; i <= 5; i++) {
    await gotoSafe(page, `${BASE}/${LOCALE}`, { waitSelector: '#__NEXT_DATA__' });
    const hasData = await page.$('#__NEXT_DATA__').catch(() => null);
    const title = await page.title().catch(() => '');
    if (hasData && !isChallengeTitle(title)) { log('warm-up OK (homepage):', title); return true; }
    log(`warm-up próba ${i}: nadal Cloudflare ("${title}") — czekam i ponawiam.`);
    await page.waitForTimeout(5000);
  }
  log('warm-up: NIE udało się przejść Cloudflare po 5 próbach.');
  return false;
}

// Nawigacja odporna na challenge: czeka aż JS-challenge sam się rozwiąże i pojawi się __NEXT_DATA__
// (raz w trakcie próbuje reload, gdyby challenge się zaciął).
async function gotoSafe(page, url, { waitSelector = '#__NEXT_DATA__', maxWaitMs = 45000 } = {}) {
  let lastStatus = 0;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (resp) lastStatus = resp.status();
  const start = Date.now();
  let reloaded = false;
  while (Date.now() - start < maxWaitMs) {
    if (await page.$(waitSelector).catch(() => null)) return lastStatus;      // sukces: dane są
    const title = await page.title().catch(() => '');
    if (isChallengeTitle(title)) {
      await page.waitForTimeout(3000);                                        // daj JS-challenge czas
      if (!reloaded && Date.now() - start > maxWaitMs / 2) { reloaded = true; await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
      continue;
    }
    await page.waitForTimeout(1500);                                          // nie-challenge → poczekaj na render
  }
  return lastStatus;
}

/* --------------------------------------------------------------------------
 *  ENRICHMENT MASOWY — równoległy fetch w kontekście strony (to samo origin).
 *  Zwraca [{ ok, urlPath, productInfo } | { gone } | { challenge } | { notProduct }]
 * ------------------------------------------------------------------------ */
// Funkcja wykonywana W PRZEGLĄDARCE: pobiera paczkę URL-i równolegle i parsuje __NEXT_DATA__.
function inPageFetchParse({ urls, conc, base }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function parse(html, requestedUrl) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { requestedUrl, challenge: /Security check/i.test(html) || /challenge-platform/.test(html) };
    let nd; try { nd = JSON.parse(m[1]); } catch (e) { return { requestedUrl, parseError: true }; }
    if (nd.page === '/404') return { requestedUrl, gone: true };
    const pp = nd.props && nd.props.pageProps;
    if (!pp || nd.page !== '/product' || !pp.productInfo) return { requestedUrl, notProduct: true, page: nd.page };
    const pi = pp.productInfo;
    return {
      requestedUrl, ok: true, urlPath: pp.url,
      productInfo: {
        name: pi.name, listPrice: pi.listPrice, sku: pi.sku || pi.fullSku, condition: pi.condition, isSold: !!pi.isSold,
        observations: (pi.observations || []).map((o) => o && o.tierDescription).filter(Boolean),
        priceModifiers: (pi.priceModifiers || []).filter((mm) => mm && mm.present).map((mm) => mm.name),
      },
    };
  }
  return (async () => {
    const out = [];
    for (let i = 0; i < urls.length; i += conc) {
      const chunk = urls.slice(i, i + conc);
      const res = await Promise.all(chunk.map((u) => {
        const rel = u.indexOf(base) === 0 ? u.slice(base.length) : u;  // fetch względny → to samo origin
        return fetch(rel, { headers: { accept: 'text/html' }, redirect: 'follow' })
          .then((r) => (r.status === 404 || r.status === 410) ? { requestedUrl: u, gone: true } : r.text().then((t) => parse(t, u)))
          .catch((e) => ({ requestedUrl: u, err: String(e && e.message || e) }));
      }));
      out.push(...res);
      if (i + conc < urls.length) await sleep(120);
    }
    return out;
  })();
}

// Node-owa pętla: dzieli listę na paczki EVAL_BATCH, ponawia z re-warm gdy sypią się challenge.
async function enrichUrls(page, urls, deadline) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONFIG.EVAL_BATCH) {
    if (Date.now() > deadline) { log('enrich: limit czasu — przerywam paczki.'); break; }
    const slice = urls.slice(i, i + CONFIG.EVAL_BATCH);
    let res = await page.evaluate(inPageFetchParse, { urls: slice, conc: CONFIG.BULK_CONCURRENCY, base: BASE });
    const challenged = res.filter((r) => r && r.challenge).length;
    if (challenged > slice.length / 3) {                 // ciasteczko wygasło → odśwież i ponów raz
      log('enrich: dużo challenge (', challenged, ') → re-warm i ponawiam paczkę.');
      await warmUp(page);
      res = await page.evaluate(inPageFetchParse, { urls: slice, conc: CONFIG.BULK_CONCURRENCY, base: BASE });
    }
    results.push(...res);
  }
  return results;
}

/* --------------------------------------------------------------------------
 *  EKSTRAKCJA POJEDYNCZA (nawigacja) — używana tylko w selfteście
 * ------------------------------------------------------------------------ */
async function extractDetail(page, url) {
  await gotoSafe(page, url);
  const data = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return { challenge: /Security check/i.test(document.title || ''), notProduct: !document.title };
    let nd; try { nd = JSON.parse(el.textContent); } catch (e) { return { parseError: true }; }
    if (nd.page === '/404') return { gone: true };
    const pp = nd.props && nd.props.pageProps;
    if (!pp || nd.page !== '/product' || !pp.productInfo) return { notProduct: true, page: nd.page };
    const pi = pp.productInfo;
    return {
      ok: true, urlPath: pp.url,
      productInfo: {
        name: pi.name, listPrice: pi.listPrice, sku: pi.sku || pi.fullSku, condition: pi.condition, isSold: !!pi.isSold,
        observations: (pi.observations || []).map((o) => o && o.tierDescription).filter(Boolean),
        priceModifiers: (pi.priceModifiers || []).filter((m) => m && m.present).map((m) => m.name),
      },
    };
  });
  data.requestedUrl = url;
  return data;
}

/* --------------------------------------------------------------------------
 *  DISCOVERY — lista modeli z sitemapy + linki SKU ze stron modeli
 * ------------------------------------------------------------------------ */
// Sitemapę pobieramy PRZEZ KONTEKST STRONY (rozgrzane ciasteczko) — zwykły node-fetch bywa challenge'owany.
async function fetchModelUrls(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const xml = await page.evaluate(async (u) => {
      try { const r = await fetch(u, { headers: { accept: 'application/xml,text/xml' } }); return await r.text(); }
      catch (e) { return 'FETCHERR:' + (e && e.message); }
    }, CONFIG.MODEL_SITEMAP);
    if (xml && xml.indexOf('<loc>') !== -1) {
      const urls = []; const re = /<loc>([^<]+)<\/loc>/g; let m;
      while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
      return urls;
    }
    log('Sitemap modeli: brak danych/Cloudflare (próba ' + attempt + ') — re-warm i ponawiam.');
    await warmUp(page);
  }
  throw new Error('Sitemap modeli: nie udało się pobrać (Cloudflare).');
}

function collectSkusFromJson(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { for (const v of obj) collectSkusFromJson(v, out); return; }
  for (const k in obj) {
    if (k === 'product_sku' && (typeof obj[k] === 'string' || typeof obj[k] === 'number')) out.add(String(obj[k]));
    else collectSkusFromJson(obj[k], out);
  }
}

async function domSkuIds(page) {
  return page.$$eval('a[href*="/sku-"]', (as) =>
    Array.from(new Set(as.map((a) => (a.getAttribute('href') || '').match(/\/sku-(\d+)/))
      .filter(Boolean).map((m) => m[1]))));
}

// Discovery egzemplarzy modelu: przechwytuje odpowiedzi search-service (product_sku),
// klikając "See more" aż do wyczerpania (modelStockInfo.productCount). Zwraca URL-e SKU.
async function discoverSkusForModel(page, modelUrl) {
  const skuSet = new Set();
  const onResp = async (resp) => {
    try {
      if (!resp.url().includes('/search-service/product/query')) return;
      if (!(resp.headers()['content-type'] || '').includes('json')) return;
      collectSkusFromJson(await resp.json(), skuSet);
    } catch (e) { /* ignoruj */ }
  };
  page.on('response', onResp);
  try {
    await gotoSafe(page, modelUrl);
    await page.waitForResponse((r) => r.url().includes('/search-service/product/query'), { timeout: 8000 }).catch(() => {});
    const meta = await page.evaluate(() => {
      try {
        const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
        const pp = nd.props.pageProps;
        return { isModel: nd.page === '/model', count: (pp.modelStockInfo && pp.modelStockInfo.productCount) || 0 };
      } catch (e) { return { isModel: false, count: 0 }; }
    });
    if (!meta.isModel) return [];
    (await domSkuIds(page)).forEach((s) => skuSet.add(s));

    let guard = 0, stale = 0;
    const target = meta.count || 0;
    while ((target ? skuSet.size < target : true) && guard < CONFIG.SEE_MORE_GUARD) {
      guard++;
      const btn = page.locator('button:has-text("See more"), a:has-text("See more")').first();
      if (!(await btn.count().catch(() => 0))) break;
      const before = skuSet.size;
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/search-service/product/query'), { timeout: 9000 }).catch(() => {}),
        btn.click({ timeout: 5000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(400);
      (await domSkuIds(page)).forEach((s) => skuSet.add(s));
      if (skuSet.size === before) { if (++stale >= 2) break; } else { stale = 0; }
    }
  } finally {
    page.off('response', onResp);
  }
  const base = modelUrl.replace(/\/+$/, '');
  // budujemy URL z id; fetch i tak podąży za ewentualnym przekierowaniem do kanonicznego slug-a,
  // a zapisujemy kanoniczny pageProps.url z odczytanej strony.
  return [...skuSet].map((sku) => `${base}/sku-${sku}`);
}

/* --------------------------------------------------------------------------
 *  TRYBY
 * ------------------------------------------------------------------------ */
async function runSelfTest(page) {
  log('SELFTEST — pobieram przykładowy produkt:', CONFIG.EXAMPLE_SKU);
  const d = await extractDetail(page, CONFIG.EXAMPLE_SKU);
  if (!d.ok) { log('NIE udało się odczytać produktu:', JSON.stringify(d)); return false; }
  log('Wynik (pojedynczy, nawigacja):\n' + JSON.stringify(mapProduct(d), null, 2));
  // dodatkowo sprawdź ścieżkę MASOWĄ (fetch w kontekście strony) — to nią leci 99% pracy
  const bulk = await enrichUrls(page, [CONFIG.EXAMPLE_SKU], Date.now() + 60000);
  log('Wynik (masowy, fetch w kontekście):', bulk[0] && bulk[0].ok ? 'OK ' + bulk[0].productInfo.name : JSON.stringify(bulk[0]));
  return true;
}

async function runRefresh(page, sheet, deadline) {
  const state = await sheet.getState();
  const startRow = parseInt(state.refreshCursor || '0', 10) || 0;
  const { slice, total } = await sheet.loadRowsForRefresh(CONFIG.REFRESH_PER_RUN, startRow);
  if (!total) { log('Refresh: brak istniejących wierszy.'); return; }
  log(`Refresh: ${slice.length} z ${total} wierszy (kursor ${startRow}).`);

  const byUrl = new Map(slice.map((it) => [it.url, it.row]));
  const details = await enrichUrls(page, slice.map((it) => it.url), deadline);

  const cellUpdates = [];
  const toDelete = [];
  let processed = 0;
  for (const d of details) {
    const row = byUrl.get(normalizeUrl(d.requestedUrl)) || byUrl.get(d.requestedUrl);
    if (!row) continue;
    processed++;
    if (d.ok) cellUpdates.push(...sheet.buildCellUpdates(row, mapProduct(d)));
    else if (d.gone) toDelete.push(row);            // egzemplarz zniknął (sprzedany/usunięty)
    // challenge/notProduct/parseError → zostaw bez zmian
  }
  await sheet.writeCells(cellUpdates);
  if (toDelete.length) { log('Refresh: usuwam', toDelete.length, 'sprzedanych/zniknionych.'); await sheet.deleteRows(toDelete); }
  await sheet.setState({ refreshCursor: String((startRow + processed) % Math.max(1, total)) });
  log('Refresh: zaktualizowano komórek:', cellUpdates.length);
}

async function runDiscover(page, sheet, deadline) {
  const models = await fetchModelUrls(page);
  log('Discovery: modeli w sitemapie:', models.length);
  const state = await sheet.getState();
  let cursor = parseInt(state.discoverCursor || '0', 10) || 0;
  if (cursor >= models.length) cursor = 0;

  const existingSkus = await sheet.loadExistingSkuIds();   // dedup po id SKU
  const skuId = (u) => { const m = String(u).match(/\/sku-(\d+)/); return m ? m[1] : null; };
  let modelsDone = 0, added = 0;

  for (let i = 0; i < CONFIG.MODELS_PER_RUN && cursor < models.length; i++, cursor++) {
    if (Date.now() > deadline) { log('Discovery: limit czasu — przerywam.'); break; }
    const modelUrl = models[cursor];
    let skuUrls = [];
    try { skuUrls = await discoverSkusForModel(page, modelUrl); }
    catch (e) { log('Discovery: błąd modelu', modelUrl, '-', e.message); }
    modelsDone++;
    const fresh = skuUrls.filter((u) => { const id = skuId(u); return id && !existingSkus.has(id); });
    if (fresh.length) {
      fresh.forEach((u) => { const id = skuId(u); if (id) existingSkus.add(id); });   // unikaj dubli w tym przebiegu
      const details = await enrichUrls(page, fresh, deadline);
      const products = details.filter((d) => d.ok).map(mapProduct);
      if (products.length) { await sheet.appendProducts(products); added += products.length; }
    }
    log(`  [${cursor}] ${modelUrl} → ${skuUrls.length} SKU (${fresh.length} nowych)`);
    await sleep(CONFIG.DELAY_MS);
  }

  await sheet.setState({ discoverCursor: String(cursor % Math.max(1, models.length)) });
  log('Discovery: modeli przerobionych:', modelsDone, '| nowych egzemplarzy dopisanych:', added);
}

/* --------------------------------------------------------------------------
 *  MAIN
 * ------------------------------------------------------------------------ */
async function main() {
  const mode = (process.env.MPB_MODE || 'cycle').toLowerCase();
  log('MPB monitor — tryb:', mode, '| modeli/przebieg:', CONFIG.MODELS_PER_RUN, '| refresh/przebieg:', CONFIG.REFRESH_PER_RUN, '| concurrency:', CONFIG.BULK_CONCURRENCY);
  const sheet = await new SheetClient(CONFIG.SPREADSHEET_ID, CONFIG.SHEET).init();
  log('Połączono z arkuszem. Kolumny:', JSON.stringify(sheet.cols));

  const { browser, page } = await launch();
  const deadline = Date.now() + CONFIG.MAX_RUNTIME_MS;
  try {
    await warmUp(page);
    if (mode === 'selftest') {
      await runSelfTest(page);
    } else if (mode === 'refresh') {
      await runRefresh(page, sheet, deadline);
    } else if (mode === 'discover') {
      await runDiscover(page, sheet, deadline);
    } else {                                  // cycle: pół czasu refresh znanych, pół discovery nowych
      const half = Date.now() + Math.floor(CONFIG.MAX_RUNTIME_MS / 2);
      await runRefresh(page, sheet, Math.min(half, deadline));
      await runDiscover(page, sheet, deadline);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log('Koniec przebiegu.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
