# This fork: monitored prices from the Kanban

This repository is a fork of
[TigerTag-Project/TigerTag-Studio-Manager](https://github.com/TigerTag-Project/TigerTag-Studio-Manager).
It keeps the original app as it is and adds one thing: for the filaments in the user's inventory,
the prices the **Kanban price monitor** (`LordSangreal/kanban-promocoes-aliexpress`) watches.

## What the user sees

- **Spool detail panel → "Monitored prices"** (above *Details*), only when the Kanban monitors that
  filament:
  - best current price, 90-day average and lowest price;
  - a 90-day chart drawn like the Kanban's own (`renderer/prices/chart.js`, a port of its
    `priceChart`): one line per store in the Kanban's colours, or average + lowest + now for one store;
  - one row per store with its price, when that price was seen, when the deal was posted, and a
    **Buy** button (affiliate link; AliExpress also gets its coins link);
  - the latest coupons of those stores, with the date and time they were posted (tap to copy).
  - When the exact colour is not monitored but the same line is (same brand, material and finish),
    the section shows that line with a note.
- **Notifications → low stock**: each spool tile gets a "R$ … at <store>" line that opens the best
  monitored offer.
- The gear in the section sets the monitor's address (stored per device in `localStorage`,
  `tigertag.kanbanUrl`). Default: `https://kanban-thiago.duckdns.org`.

## How it is wired

| Piece | Where |
|---|---|
| Fetch, cache, matching, clicks | `renderer/prices/index.js` |
| Price chart (same look as the Kanban) | `renderer/prices/chart.js` |
| Texts (11 languages, kept out of `renderer/locales/` so upstream merges stay clean) | `renderer/prices/strings.js` |
| Styles (theme tokens) | `renderer/prices/prices.css` |
| Hooks in the upstream files | `renderer/inventory.js`: 1 import, 1 `initKanbanPrices(...)` line, `${kanbanPricesHTML(r)}` in `buildPanelHTML`, `kanbanStockBuyHTML(row)` in the low-stock tiles · `renderer/inventory.html`: 1 `<link>` |
| Server side | Kanban `GET /api/tiger/filaments` (public, read-only, CORS open, rebuilt every 5 min) |

**Matching.** The Kanban keys every filament as `fil|brand|material|finish…|colour…[|Nkg]`
(`app/filamentos.py`). Its answer carries the vocabulary it uses; `filamentKey()` builds the same
key from the spool's brand, material, aspects, series, colour name (or its RGB colour when the
name says nothing) and capacity. A brand added on the Kanban is matched here without an app update.

## Staying on the original app's releases

`.github/workflows/upstream-sync.yml` runs every 6 hours (and on *Run workflow*): it merges the
upstream's latest **release** tag into `main`.

- Clean merge → quick checks (i18n, the fork's hooks are still there) → pushed.
- Conflict → nothing pushed; an issue lists the files (if Issues are on) and the run goes red.
- A release that edits `.github/workflows/` needs the secret **`UPSTREAM_SYNC_TOKEN`** (a
  fine-grained token on this repo with *Contents* and *Workflows* read/write); the default token
  is refused by GitHub for workflow edits.

## Building the fork's app

`package.json → build.publish` still points at the original repo, so an installed build would
auto-update to the **original** release (without these additions). Before distributing builds of
this fork, point `publish.owner` at this fork and give the fork's `build.yml` its own signing
secrets.
