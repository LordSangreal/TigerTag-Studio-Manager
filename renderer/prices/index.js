/*
 * prices/index.js — "Monitored prices" for a filament, read from the Kanban price monitor.
 *
 * The Kanban server (kanban-promocoes-aliexpress, GET /api/tiger/filaments) watches filament prices in
 * several stores (AliExpress, Shopee, Mercado Livre, Amazon) and publishes, per filament, the offers of
 * each store with their affiliate links, a 90-day price history per store and the latest coupons.
 *
 * This module is self-contained on purpose: the host (inventory.js) only imports it, calls
 * `initKanbanPrices` once, and drops `kanbanPricesHTML(row)` into the spool detail panel and
 * `kanbanStockBuyHTML(row)` into the low-stock tiles. Everything else (fetch, cache, matching, chart,
 * clicks, server address) lives here, so the fork can keep merging the upstream app with few conflicts.
 *
 * Matching: the server sends its own vocabulary (brands, materials, finishes, colours) and keys its
 * filaments as "fil|brand|material|finish…|colour…[|Nkg]". `filamentKey` builds the same key from the
 * spool's fields with that vocabulary (a port of `filamentos.key` in the Kanban repo), so a brand added
 * on the server is matched here without an app update.
 */

import { STRINGS } from './strings.js';
import { priceChartHTML, wireChartTips } from './chart.js';

const URL_KEY = "tigertag.kanbanUrl";
const CACHE_KEY = "tigertag.kanbanCache";
const DEFAULT_URL = "https://kanban-thiago.duckdns.org";
const MAX_AGE_MS = 5 * 60 * 1000;          // the server rebuilds its answer every 5 minutes
const RETRY_MS = 60 * 1000;                 // after a failure, wait before asking again
const STORE_NAMES = { aliexpress: "AliExpress", shopee: "Shopee", mercadolivre: "Mercado Livre", amazon: "Amazon" };

const host = {
  esc: s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  lang: () => "pt",
  openExternal: url => window.open(url, "_blank", "noopener"),
  toast: () => {},
};

// The module's own texts (strings.js), in the app's language, English as the fallback.
function tr(key, params = {}) {
  const byLang = STRINGS[key] || {};
  const v = byLang[host.lang()] ?? byLang.en ?? key;
  return String(v).replace(/\{\{(\w+)\}\}/g, (_, x) => params[x] ?? "");
}
// Number and date formatting: the app's "pt" is Brazilian Portuguese.
const locale = () => ({ pt: "pt-BR", "pt-pt": "pt-PT", zh: "zh-CN" })[host.lang()] || host.lang() || "en";

let data = null;            // last server answer
let fetchedAt = 0;
let loading = null;         // in-flight promise
let failedAt = 0;
let lastError = "";
let index = null;           // { exact: Map<key, filament>, line: Map<lineKey, filament[]> }
const rowsBySpool = new Map();   // spoolId → last row drawn, to redraw the section once data arrives

// ── settings ────────────────────────────────────────────────────────────────
export function kanbanUrl() {
  try { return (localStorage.getItem(URL_KEY) ?? DEFAULT_URL).trim().replace(/\/+$/, ""); } catch { return DEFAULT_URL; }
}
function setKanbanUrl(url) {
  try { localStorage.setItem(URL_KEY, String(url || "").trim()); } catch { /* storage blocked */ }
  data = null; index = null; fetchedAt = 0; failedAt = 0; lastError = "";
  try { localStorage.removeItem(CACHE_KEY); } catch { /* storage blocked */ }
}

// ── data ────────────────────────────────────────────────────────────────────
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c && c.url === kanbanUrl() && c.body?.filaments) { data = c.body; fetchedAt = c.at || 0; buildIndex(); }
  } catch { /* no cache */ }
}

function load(force = false) {
  const base = kanbanUrl();
  if (!base) return Promise.resolve(null);
  if (loading) return loading;
  const fresh = data && Date.now() - fetchedAt < MAX_AGE_MS;
  if (!force && (fresh || Date.now() - failedAt < RETRY_MS)) return Promise.resolve(data);
  loading = fetch(`${base}/api/tiger/filaments`, { headers: { Accept: "application/json" } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(body => {
      if (!body || !Array.isArray(body.filaments)) throw new Error("bad answer");
      data = body; fetchedAt = Date.now(); lastError = ""; buildIndex();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ url: base, at: fetchedAt, body })); } catch { /* too big / blocked */ }
      return data;
    })
    .catch(e => { failedAt = Date.now(); lastError = e?.message || String(e); console.warn("[kanban] prices:", lastError); return data; })
    .finally(() => { loading = null; redrawAll(); });
  return loading;
}

// ── matching (port of filamentos.key in the Kanban repo) ─────────────────────
function norm(s) {
  s = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = s.replace(/\+/g, " plus ").replace(/±/g, " ");
  return " " + s.replace(/[^a-z0-9.,]+/g, " ").trim() + " ";
}
function find(text, table) {
  const found = [];
  let rest = text;
  for (const k of Object.keys(table).sort((a, b) => b.length - a.length)) {
    const pat = ` ${k} `;
    if (rest.includes(pat)) { found.push(table[k]); rest = rest.split(pat).join(" | "); }
  }
  return found;
}
// Nearest colour word of the vocabulary for a spool that only has an RGB colour.
function hexColorWord(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex || ""));
  if (!m) return "";
  const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.15) return "preto";
  if (l > 0.88 && s < 0.4) return "branco";
  if (s < 0.15) return l < 0.3 ? "preto" : l > 0.82 ? "branco" : "cinza";
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return l > 0.7 ? "rosa" : "vermelho";
  if (h < 40) return l < 0.35 ? "marrom" : "laranja";
  if (h < 70) return l < 0.35 ? "marrom" : "amarelo";
  if (h < 165) return "verde";
  if (h < 255) return "azul";
  if (h < 290) return "roxo";
  return "rosa";
}
/** Kanban key of a spool row ("fil|sunlu|pla|matte|preto"), or "" when it cannot be told. */
export function filamentKey(row, vocab = data?.vocab) {
  if (!row || !vocab) return "";
  const words = [row.material, row.aspect1, row.aspect2, row.series, row.colorName !== "-" ? row.colorName : ""];
  const text = norm(words.filter(Boolean).join(" "));
  const mats = [...new Set(find(text, vocab.materials))];
  if (mats.length !== 1) return "";
  const brand = find(norm(row.brand), vocab.brands)[0] || "";
  if (!brand) return "";
  const finishes = [...new Set(find(text, vocab.finishes))].sort();
  let colors = [...new Set(find(text, vocab.colors))].sort();
  if (!colors.length && !row.colorHex2) { const c = hexColorWord(row.colorHex); if (c) colors = [c]; }
  const parts = ["fil", brand, mats[0], ...finishes, ...colors];
  const grams = Number(row.capacity);
  if (grams > 0) {
    const kg = Math.round(grams / 10) / 100;
    if (kg >= 0.2 && kg !== 1) parts.push(`${kg}kg`);
  }
  return parts.join("|");
}
// Same product line in another colour: the key without its colour words.
function lineKey(key, vocab) {
  const colors = new Set(Object.values(vocab?.colors || {}));
  return key.split("|").filter(p => !colors.has(p)).join("|");
}
function buildIndex() {
  const exact = new Map(), line = new Map();
  for (const f of data?.filaments || []) {
    exact.set(f.key, f);
    const lk = lineKey(f.key, data.vocab);
    if (!line.has(lk)) line.set(lk, []);
    line.get(lk).push(f);
  }
  index = { exact, line };
}
/** { filament, exact } for a spool row, or null. */
export function matchFilament(row) {
  if (!index) return null;
  const key = filamentKey(row);
  if (!key) return null;
  const f = index.exact.get(key);
  if (f) return { filament: f, exact: true };
  const same = (index.line.get(lineKey(key, data.vocab)) || []).filter(x => x.best_price != null);
  if (!same.length) return null;
  same.sort((a, b) => a.best_price - b.best_price);
  return { filament: same[0], exact: false, others: same.length };
}

// ── formatting ──────────────────────────────────────────────────────────────
const money = v => v == null ? "—" : Number(v).toLocaleString(locale(), { style: "currency", currency: "BRL" });
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
// Colour of each store = its chart line (the Kanban numbers stores in order of appearance, ser0…ser4).
function seriesClasses(f) {
  const first = s => Date.parse(s.first_at || "") || Math.min(...(s.points || []).map(p => Date.parse(p[0] + "T12:00:00Z")));
  const order = (f.history || []).filter(s => s.points?.length).sort((a, b) => first(a) - first(b));
  const one = order.length === 1;
  return new Map(order.map((s, k) => [s.store, one ? "acc" : `ser${k % 5}`]));
}

// ── markup ──────────────────────────────────────────────────────────────────
function sectionShell(row, inner) {
  return `<div class="panel-section kp-section" data-kp-spool="${host.esc(row.spoolId)}">
      <div class="panel-label kp-head"><span>${host.esc(tr("kpTitle"))}</span>
        <button type="button" class="kp-gear" data-kp-settings aria-label="${host.esc(tr("kpServer"))}"><span class="icon icon-settings icon-12" aria-hidden="true"></span></button>
      </div>
      <div class="kp-settings" hidden>
        <input type="url" class="kp-url" value="${host.esc(kanbanUrl())}" placeholder="https://…" aria-label="${host.esc(tr("kpServer"))}">
        <button type="button" class="primary sm" data-kp-save>${host.esc(tr("kpSave"))}</button>
      </div>
      ${inner}
    </div>`;
}

function offersHTML(f) {
  const ser = seriesClasses(f);
  return `<div class="kp-offers">${f.offers.map(o => `
      <div class="kp-offer">
        <span class="kp-dot ${ser.get(o.store) || ""}"></span>
        <div class="kp-offer-main">
          <b>${host.esc(o.store_name || o.store)}</b>
          <small>${o.collected_at ? host.esc(tr("kpSeenAt", { at: when(o.collected_at) })) : ""}${o.published_at ? " · " + host.esc(tr("kpPublishedAt", { at: when(o.published_at) })) : ""}${o.in_stock ? "" : " · " + host.esc(tr("kpOutOfStock"))}</small>
        </div>
        <span class="kp-price">${money(o.price)}</span>
        <button type="button" class="det-buy-link kp-buy" data-kp-open="${host.esc(o.buy_url)}"><span class="icon icon-cart icon-14" aria-hidden="true"></span><span>${host.esc(tr("kpBuy"))}</span></button>
        ${o.coins_url ? `<button type="button" class="kp-coins" data-kp-open="${host.esc(o.coins_url)}">${host.esc(tr("kpCoins"))}</button>` : ""}
      </div>`).join("")}</div>`;
}

function couponsHTML(f) {
  if (!f.coupons?.length) return "";
  return `<div class="kp-sub">${host.esc(tr("kpCoupons"))}</div><div class="kp-coupons">${f.coupons.map(c => {
    const disc = c.discount_pct > 0 ? `${Math.round(c.discount_pct)}%` : c.discount_brl > 0 ? money(c.discount_brl) : "";
    const min = c.min_order_brl > 0 ? tr("kpMinOrder", { v: money(c.min_order_brl) }) : "";
    return `<div class="kp-coupon${c.ended ? " is-ended" : ""}">
        <button type="button" class="kp-code" data-kp-copy="${host.esc(c.code)}" aria-label="${host.esc(tr("kpCopy"))}">${host.esc(c.code)}<span class="icon icon-copy icon-12" aria-hidden="true"></span></button>
        <span class="kp-coupon-info"><span>${[disc && `<b>${host.esc(disc)}</b>`, min && host.esc(min), host.esc(STORE_NAMES[c.store] || c.store)].filter(Boolean).join(" · ")}</span>
          <small>${host.esc(tr(c.ended ? "kpCouponEnded" : "kpCouponSeen", { at: when(c.seen_at) }))}</small></span>
      </div>`; }).join("")}</div>`;
}

/** The "Monitored prices" section of the spool detail panel ("" when nothing to show). */
export function kanbanPricesHTML(row) {
  if (!row || !row.spoolId || row.deleted) return "";
  rowsBySpool.set(String(row.spoolId), row);
  if (!kanbanUrl()) return sectionShell(row, `<p class="kp-note">${host.esc(tr("kpNoServer"))}</p>`);
  if (!data) {
    load();
    return sectionShell(row, `<p class="kp-note">${host.esc(tr(lastError ? "kpOffline" : "kpLoading"))}</p>`);
  }
  if (Date.now() - fetchedAt > MAX_AGE_MS) load();
  const m = matchFilament(row);
  if (!m) return "";      // not monitored: keep the panel as the upstream app draws it
  const f = m.filament;
  const stats = `<div class="kp-stats">
      <span class="det-buy-price"><span class="icon icon-tag icon-14" aria-hidden="true"></span>${money(f.best_price)}</span>
      <small>${host.esc(tr("kpAvgMin", { avg: money(f.avg_90d), min: money(f.min_90d), days: data.history_days || 90 }))}</small>
    </div>`;
  const note = m.exact ? "" : `<p class="kp-note">${host.esc(tr("kpOtherColor", { name: f.name }))}</p>`;
  return sectionShell(row, `${note}${stats}${priceChartHTML(f.history, { days: data.history_days || 90, locale: locale(), label: { aria: tr("kpChartAria"), avg: v => tr("kpChartAvg", { v }), min: v => tr("kpChartMin", { v }), now: v => tr("kpChartNow", { v }) } })}${offersHTML(f)}${couponsHTML(f)}`);
}

/** One line under a low-stock tile: best monitored price + buy button ("" when not monitored). */
export function kanbanStockBuyHTML(row) {
  if (!row || !data) { if (!data) load(); return ""; }
  const m = matchFilament(row);
  const o = m?.filament.offers.find(x => x.price != null && x.in_stock);
  if (!o) return "";
  return `<span class="kp-nc-buy" role="link" tabindex="0" data-kp-open="${host.esc(o.buy_url)}">` +
    `<span class="icon icon-cart icon-12" aria-hidden="true"></span>${host.esc(tr("kpStockBuy", { price: money(o.price), store: o.store_name || o.store }))}</span>`;
}

function redrawAll() {
  document.querySelectorAll("[data-kp-spool]").forEach(el => {
    const row = rowsBySpool.get(el.dataset.kpSpool);
    if (!row) return;
    const html = kanbanPricesHTML(row);
    if (!html) { el.remove(); return; }
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    el.replaceWith(tmp.firstElementChild);
  });
}

function onClick(e) {
  const open = e.target.closest("[data-kp-open]");
  if (open) {
    e.preventDefault(); e.stopPropagation();
    const url = open.dataset.kpOpen;
    if (/^https:\/\//i.test(url)) host.openExternal(url);
    return;
  }
  const copy = e.target.closest("[data-kp-copy]");
  if (copy) {
    e.preventDefault(); e.stopPropagation();
    navigator.clipboard?.writeText(copy.dataset.kpCopy).then(() => host.toast(tr("kpCopied", { code: copy.dataset.kpCopy }), "success")).catch(() => {});
    return;
  }
  const gear = e.target.closest("[data-kp-settings]");
  if (gear) {
    const box = gear.closest(".kp-section")?.querySelector(".kp-settings");
    if (box) box.hidden = !box.hidden;
    return;
  }
  const save = e.target.closest("[data-kp-save]");
  if (save) {
    const input = save.closest(".kp-settings")?.querySelector(".kp-url");
    setKanbanUrl(input ? input.value : "");
    load(true);
    redrawAll();
  }
}
function onKey(e) {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".kp-nc-buy")) onClick(e);
}

/** Called once by the host with its helpers (all optional). */
export function initKanbanPrices(opts = {}) {
  Object.assign(host, Object.fromEntries(Object.entries(opts).filter(([, v]) => typeof v === "function")));
  readCache();
  // Capture phase: a buy button inside a low-stock tile must not also trigger the tile itself.
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  wireChartTips(document);
  load();
}
