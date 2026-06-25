/**
 * sheets.js — cienka warstwa nad Google Sheets API (konto serwisowe).
 *
 *  - Autoryzacja: zmienna środowiskowa GOOGLE_SERVICE_ACCOUNT_JSON (cała zawartość
 *    pliku klucza konta serwisowego). Arkusz musi być UDOSTĘPNIONY na adres e-mail
 *    tego konta (client_email) z prawem do edycji.
 *  - Kolumny rozpoznawane są PO NAZWACH NAGŁÓWKÓW (wiersz 1) — patrz HEADER_ALIASES.
 *    Dzięki temu kolejność kolumn w arkuszu może się różnić; skrypt sam je znajdzie.
 *  - Stan/kursor trzymany jest w osobnej zakładce "_mpb_state" (klucz | wartość),
 *    żeby przebieg w GitHub Actions (bez trwałego dysku) mógł kontynuować pracę.
 */

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const STATE_SHEET = '_mpb_state';

// Nagłówek (lowercase, trim) → kanoniczny klucz pola.
const HEADER_ALIASES = {
  url:       ['url', 'adres', 'adres url', 'link'],
  name:      ['nazwa', 'nazwa produktu', 'name', 'produkt'],
  price:     ['cena', 'price', 'cena (eur)', 'cena eur', 'cena €'],
  sku:       ['sku', 'kod', 'kod produktu'],
  condition: ['cosmetic condition', 'condition', 'stan', 'stan kosmetyczny', 'kondycja'],
  notes:     ['notes', 'uwagi', 'notatki'],
  included:  ["what's included", 'what’s included', 'what included', 'whats included', 'w zestawie', 'zawartość', 'zawartosc', 'included'],
  // opcjonalne kolumny pomocnicze (użyte tylko jeśli istnieją w nagłówku):
  updated:   ['ostatnia aktualizacja', 'aktualizacja', 'updated', 'data aktualizacji'],
  status:    ['status'],
};

// Domyślny nagłówek wpisywany TYLKO gdy wiersz 1 arkusza MPB jest pusty.
const DEFAULT_HEADER = [
  'URL', 'Nazwa', 'Cena', 'SKU', 'Cosmetic condition', 'Notes', "What's included",
  'Ostatnia aktualizacja', 'Status',
];

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

class SheetClient {
  constructor(spreadsheetId, sheetTitle) {
    this.spreadsheetId = spreadsheetId;
    this.sheetTitle = sheetTitle;
    this.api = null;
    this.cols = null;        // { url: 1, name: 2, ... }  (1-based numery kolumn)
    this._sheetsByTitle = null;
  }

  async init() {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Brak zmiennej GOOGLE_SERVICE_ACCOUNT_JSON (klucz konta serwisowego).');
    let creds;
    try { creds = JSON.parse(raw); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nie jest poprawnym JSON-em.'); }
    const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    await auth.authorize();
    this.api = google.sheets({ version: 'v4', auth });

    await this._loadSheetList();
    await this._ensureSheet(this.sheetTitle);
    await this._ensureSheet(STATE_SHEET);
    await this._loadColumns();
    return this;
  }

  async _loadSheetList() {
    const res = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties' });
    this._sheetsByTitle = {};
    for (const s of res.data.sheets || []) this._sheetsByTitle[s.properties.title] = s.properties;
  }

  async _ensureSheet(title) {
    if (this._sheetsByTitle[title]) return;
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await this._loadSheetList();
  }

  async _loadColumns() {
    const range = `${this.sheetTitle}!1:1`;
    const res = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    let header = (res.data.values && res.data.values[0]) || [];
    const anyFilled = header.some((v) => String(v || '').trim() !== '');
    if (!anyFilled) {
      // pusty arkusz → wpisz domyślny nagłówek (nie nadpisujemy istniejącego układu)
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetTitle}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [DEFAULT_HEADER] },
      });
      header = DEFAULT_HEADER.slice();
    }
    this.cols = {};
    header.forEach((h, i) => {
      const key = String(h || '').trim().toLowerCase();
      for (const canon in HEADER_ALIASES) {
        if (HEADER_ALIASES[canon].includes(key)) { this.cols[canon] = i + 1; break; }
      }
    });
    if (!this.cols.url) throw new Error(`W arkuszu "${this.sheetTitle}" brak kolumny URL (nagłówek w wierszu 1).`);
  }

  /** Mapa istniejących URL → numer wiersza (1-based). Zwraca też ostatni wiersz z danymi. */
  async loadExistingByUrl() {
    const colA1 = colLetter(this.cols.url);
    const range = `${this.sheetTitle}!${colA1}2:${colA1}`;
    const res = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    const vals = res.data.values || [];
    const map = new Map();
    let lastRow = 1;
    vals.forEach((row, i) => {
      const u = normalizeUrl(String((row && row[0]) || '').trim());
      const rowNum = i + 2;
      if (u) { map.set(u, rowNum); lastRow = rowNum; }
    });
    return { map, lastRow };
  }

  /** Zbiór istniejących SKU (po id) — z kolumny URL (/sku-<id>) i z kolumny SKU. Do dedupu discovery. */
  async loadExistingSkuIds() {
    const set = new Set();
    const urlA1 = colLetter(this.cols.url);
    const r1 = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${this.sheetTitle}!${urlA1}2:${urlA1}` });
    for (const row of (r1.data.values || [])) { const m = String((row && row[0]) || '').match(/\/sku-(\d+)/); if (m) set.add(m[1]); }
    if (this.cols.sku) {
      const skuA1 = colLetter(this.cols.sku);
      const r2 = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${this.sheetTitle}!${skuA1}2:${skuA1}` });
      for (const row of (r2.data.values || [])) { const v = String((row && row[0]) || '').trim(); if (/^\d+$/.test(v)) set.add(v); }
    }
    return set;
  }

  /** Wczytuje pełne wiersze (potrzebne przy odświeżaniu) — zwraca [{row, url}]. */
  async loadRowsForRefresh(limit, startRow) {
    const colA1 = colLetter(this.cols.url);
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId, range: `${this.sheetTitle}!${colA1}2:${colA1}`,
    });
    const vals = res.data.values || [];
    const out = [];
    for (let i = 0; i < vals.length; i++) {
      const u = normalizeUrl(String((vals[i] && vals[i][0]) || '').trim());
      if (u) out.push({ row: i + 2, url: u });
    }
    // okno [startRow .. startRow+limit) w przestrzeni indeksów listy
    const from = startRow % Math.max(1, out.length);
    const slice = [];
    for (let k = 0; k < Math.min(limit, out.length); k++) slice.push(out[(from + k) % out.length]);
    return { slice, total: out.length };
  }

  /** Zapis produktu do KONKRETNEGO wiersza (update). product = {url,name,price,sku,condition,notes,included,...}. */
  buildCellUpdates(rowNum, product) {
    const ups = [];
    const put = (canon, value) => { if (this.cols[canon] && value !== undefined) ups.push({ row: rowNum, col: this.cols[canon], value }); };
    put('url', product.url);
    put('name', product.name);
    put('price', product.price);
    put('sku', product.sku);
    put('condition', product.condition);
    put('notes', product.notes);
    put('included', product.included);
    put('updated', product.updated);
    put('status', product.status);
    return ups;
  }

  /** Zbiorczy zapis pojedynczych komórek (jeden value-range na komórkę → brak nadpisywania sąsiednich kolumn). */
  async writeCells(cellUpdates) {
    if (!cellUpdates.length) return;
    const data = cellUpdates.map((c) => ({
      range: `${this.sheetTitle}!${colLetter(c.col)}${c.row}`,
      values: [[c.value === null || c.value === undefined ? '' : c.value]],
    }));
    // chunkujemy, żeby nie przekroczyć limitów pojedynczego żądania
    for (let i = 0; i < data.length; i += 500) {
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + 500) },
      });
    }
  }

  /** Dopisuje nowe wiersze na dole (kolejność kolumn wg mapy nagłówków). */
  async appendProducts(products) {
    if (!products.length) return;
    const maxCol = Math.max(...Object.values(this.cols));
    const rows = products.map((p) => {
      const arr = new Array(maxCol).fill('');
      const set = (canon, v) => { if (this.cols[canon]) arr[this.cols[canon] - 1] = (v === null || v === undefined ? '' : v); };
      set('url', p.url); set('name', p.name); set('price', p.price); set('sku', p.sku);
      set('condition', p.condition); set('notes', p.notes); set('included', p.included);
      set('updated', p.updated); set('status', p.status);
      return arr;
    });
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetTitle}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }

  /** Usuwa wiersz po numerze (np. produkt sprzedany / zniknął). Wymaga sheetId. */
  async deleteRows(rowNums) {
    if (!rowNums.length) return;
    const sheetId = this._sheetsByTitle[this.sheetTitle].sheetId;
    // od dołu, żeby indeksy się nie przesuwały; deleteDimension liczy od 0
    const requests = rowNums.sort((a, b) => b - a).map((r) => ({
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } },
    }));
    for (let i = 0; i < requests.length; i += 200) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: requests.slice(i, i + 200) },
      });
    }
  }

  // ----- STAN / KURSOR (_mpb_state) -----
  async getState() {
    const res = await this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${STATE_SHEET}!A:B` });
    const vals = res.data.values || [];
    const state = {};
    for (const row of vals) if (row[0]) state[row[0]] = row[1];
    return state;
  }

  async setState(obj) {
    const current = await this.getState();
    const merged = { ...current, ...obj };
    const rows = Object.keys(merged).map((k) => [k, String(merged[k])]);
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${STATE_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows.length ? rows : [['', '']] },
    });
  }
}

function normalizeUrl(u) {
  if (!u) return '';
  u = u.split('#')[0].split('?')[0].trim();
  return u.replace(/\/+$/, '');
}

module.exports = { SheetClient, normalizeUrl, colLetter };
