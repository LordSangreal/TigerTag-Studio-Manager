/*
 * prices/chart.js — the Kanban's price chart, drawn the same way here.
 *
 * Port of `multiChart` / `drawChart` + `priceChart` from the Kanban (app/static/common.js), so a
 * filament's history looks the same in both places:
 *   • several stores → one smooth line per store (monotone curve, gradient area under it, a dot on
 *     each record up to 40), colours ser0…ser4 in order of appearance, legend "Store R$ last";
 *   • one store → the accent line with its gradient, dashed average line "média R$ …", the lowest
 *     price marked in green ("mín") and the latest one ("agora");
 *   • "nice" price ticks on the left, dates under the axis, a tooltip on the nearest record.
 * Markup is returned as a string (the detail panel is HTML built in one go); the tooltip is wired by
 * one delegated listener (`wireChartTips`).
 */

const W = 360, H = 220, PAD = { l: 64, r: 16, t: 14, b: 28 };
const IW = W - PAD.l - PAD.r, IH = H - PAD.t - PAD.b;
const charts = new Map();   // chart id → { pts: [{x, y, head, lines}] } for the tooltip
let seq = 0;

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (v, loc) => v == null ? "—" : Number(v).toLocaleString(loc, { style: "currency", currency: "BRL" });
const brl0 = (v, loc) => Number(v).toLocaleString(loc, { style: "currency", currency: "BRL", maximumFractionDigits: v >= 100 ? 0 : 2 });

function niceTicks(lo, hi, n = 4) {
  if (hi === lo) { hi = lo + 1; lo = Math.max(0, lo - 1); }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}

// Smooth curve that never overshoots the real values between two records (monotone cubic).
function smoothPath(pts) {
  if (pts.length < 2) return "";
  const n = pts.length, dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {   // Fritsch–Carlson
    if (!m[i]) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s2 = a * a + b * b;
    if (s2 > 9) { const k = 3 / Math.sqrt(s2); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/**
 * history: [{ store, store_name, points: [["YYYY-MM-DD", price], …] }] (Kanban /api/tiger/filaments).
 * opts: { days, locale, label: { aria, avg, min, now } } → HTML string ("" when nothing to draw).
 */
export function priceChartHTML(history, opts) {
  const { days = 90, locale = "pt-BR", label } = opts;
  const since = Date.now() - days * 864e5;
  const ss = (history || [])
    .map(s => ({ name: s.store_name || s.store, first: Date.parse(s.first_at || ""),
      pts: (s.points || []).map(p => [Date.parse(p[0] + "T12:00:00Z"), Number(p[1])]).filter(p => p[0] >= since).sort((a, b) => a[0] - b[0]) }))
    .filter(s => s.pts.length)
    // the Kanban colours stores in order of appearance (first price seen; the server sends it as first_at)
    .sort((a, b) => (a.first || a.pts[0][0]) - (b.first || b.pts[0][0]))
    .map((s, k) => ({ ...s, cls: `ser${k % 5}` }));
  if (!ss.length) return "";
  const single = ss.length === 1;
  const all = ss.flatMap(s => s.pts);
  const vals = all.map(p => p[1]);
  const avg = single ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const ticks = niceTicks(Math.min(...vals, ...(avg != null ? [avg] : [])), Math.max(...vals, ...(avg != null ? [avg] : [])));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
  const X = t => PAD.l + (t1 === t0 ? IW / 2 : (t - t0) / (t1 - t0) * IW);
  const Y = v => PAD.t + IH - (v - lo) / (hi - lo) * IH;
  const fmtD = t => new Date(t).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const id = `kpc${++seq}`;
  const out = [];
  for (const t of ticks) {
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" class="grid"/>`,
      `<text x="${PAD.l - 8}" y="${(Y(t) + 4).toFixed(1)}" class="ax" text-anchor="end">${esc(brl0(t, locale))}</text>`);
  }
  const nx = Math.max(2, Math.floor(IW / 70));
  for (let k = 0; k <= nx; k++) {
    const t = t0 + (t1 - t0) * k / nx;
    out.push(`<text x="${X(t).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(fmtD(t))}</text>`);
  }
  const tips = [];
  ss.forEach((s, k) => {
    const pts = s.pts.map(([t, v]) => [X(t), Y(v)]);
    if (pts.length === 1) pts.push([X(t1), pts[0][1]]);    // one price only: a dash up to today
    const cls = single ? "" : ` ${s.cls}`;
    const g = `${id}g${k}`;
    out.push(`<defs><linearGradient id="${g}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" class="stop-top${single ? " acc" : cls}"/><stop offset="100%" class="stop-bottom${single ? " acc" : cls}"/></linearGradient></defs>`);
    const d = smoothPath(pts);
    out.push(`<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${Y(lo).toFixed(1)} L${pts[0][0].toFixed(1)},${Y(lo).toFixed(1)} Z" fill="url(#${g})" class="area"/>`,
      `<path d="${d}" class="line${cls}"/>`);
    if (s.pts.length <= 40) for (const [t, v] of s.pts) out.push(`<circle cx="${X(t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" class="dot${cls}"/>`);
    for (const [t, v] of s.pts) tips.push({ x: X(t), y: Y(v), head: single ? brl(v, locale) : `${s.name} ${brl(v, locale)}`, sub: fmtD(t) });
  });
  if (single) {
    const p = ss[0].pts, ys = p.map(x => x[1]);
    const iMin = ys.indexOf(Math.min(...ys)), last = ys.length - 1;
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(avg).toFixed(1)}" y2="${Y(avg).toFixed(1)}" class="avg"/>`,
      `<text x="${PAD.l + 6}" y="${(Y(avg) - 6).toFixed(1)}" class="ax avg-lb" text-anchor="start">${esc(label.avg(brl(avg, locale)))}</text>`);
    const marks = [{ i: iMin, text: label.min(brl(ys[iMin], locale)), cls: "min" }, ...(iMin === last ? [] : [{ i: last, text: label.now(brl(ys[last], locale)), cls: "" }])];
    for (const mk of marks) {
      const cx = X(p[mk.i][0]), cy = Y(ys[mk.i]);
      const anchor = cx > W - 90 ? "end" : cx < PAD.l + 60 ? "start" : "middle";
      out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" class="dot ${mk.cls}"/>`,
        `<text x="${cx.toFixed(1)}" y="${(cy - 10 < PAD.t + 8 ? cy + 18 : cy - 10).toFixed(1)}" class="ax mk-lb" text-anchor="${anchor}">${esc(mk.text)}</text>`);
    }
  }
  out.push(`<line y1="${PAD.t}" y2="${PAD.t + IH}" class="cross" visibility="hidden"/>`,
    `<circle r="5" class="dot hover" visibility="hidden"/>`,
    `<rect x="${PAD.l}" y="${PAD.t}" width="${IW}" height="${IH}" class="hit"/>`);
  charts.set(id, tips);
  const legend = single ? "" : `<div class="series-legend">${ss.map(s =>
    `<span><i class="${s.cls}"></i>${esc(s.name)} ${esc(brl(s.pts[s.pts.length - 1][1], locale))}</span>`).join("")}</div>`;
  return `<div class="kp-chart" data-kp-chart="${id}"><svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${esc(label.aria)}">${out.join("")}</svg><div class="chart-tip" hidden></div>${legend}</div>`;
}

// Tooltip on the nearest record (the Kanban's reading layer), one listener for every chart.
export function wireChartTips(root = document) {
  const show = ev => {
    const hit = ev.target.closest?.(".kp-chart .hit");
    if (!hit) return;
    const box = hit.closest(".kp-chart"), tips = charts.get(box.dataset.kpChart);
    if (!tips?.length) return;
    const svg = box.querySelector("svg"), r = svg.getBoundingClientRect();
    const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * W / r.width;
    let best = tips[0];
    for (const p of tips) if (Math.abs(p.x - px) < Math.abs(best.x - px)) best = p;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot.hover"), tip = box.querySelector(".chart-tip");
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="tip-h">${esc(best.head)}</div><div>${esc(best.sub)}</div>`;
    tip.hidden = false;
    const left = best.x * r.width / W, tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(left - tw / 2, 0), r.width - tw)}px`;
    tip.style.top = `${Math.max(best.y * r.height / H - tip.offsetHeight - 12, 0)}px`;
  };
  const hide = ev => {
    const hit = ev.target.closest?.(".kp-chart .hit");
    if (!hit) return;
    const box = hit.closest(".kp-chart");
    box.querySelector(".chart-tip").hidden = true;
    box.querySelectorAll(".cross, .dot.hover").forEach(e => e.setAttribute("visibility", "hidden"));
  };
  root.addEventListener("pointermove", show);
  root.addEventListener("pointerdown", show);
  root.addEventListener("pointerout", hide);
}
