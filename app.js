"use strict";

// Kept as "pokemon-inventory-v1" so data saved by earlier versions still loads.
const STORAGE_KEY = "pokemon-inventory-v1";

/*
 * Data model
 * item = { id, name, type, set, number, photo, qty, unitCost, buyDate, boughtFrom, notes, ref,
 *          sales: [{ id, date, qty, unitPrice, fees, platform }] }
 * `ref` says which product this is, so it can be priced: "sealed:<TCGplayer product id>" or
 * "card:<TCGdex card id>". Empty when the person typed the item in without picking a match.
 * Each item is a purchase "lot": qty units bought at unitCost each.
 * Sales are recorded a few units at a time, so a lot can be partly sold. A lot with units
 * left shows in Inventory; every sale shows as its own row in Sold.
 */

/*
 * Sync (see sync.js): every item carries `updatedAt` (ms), stamped by touch() whenever it changes.
 * Deleting an item leaves a tombstone { id, updatedAt } so other devices learn it was deleted.
 */
const DELETED_KEY = "card-ledger-deleted";
let items = loadJson(STORAGE_KEY);
let tombstones = loadJson(DELETED_KEY);
const ui = { search: "", tab: "inventory", show: "all", sort: "newest", expanded: new Set() }; // show: all | sealed | single

/* ---------- storage ---------- */

function loadJson(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// `quiet` is for changes that arrived *from* the cloud, which shouldn't trigger another upload.
function saveItems({ quiet = false } = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    localStorage.setItem(DELETED_KEY, JSON.stringify(tombstones));
  } catch {
    alert("Could not save: this browser's storage may be full (photos take the most room). Use \"Backup\" to keep your data, then remove some photos.");
  }
  if (!quiet && window.ledgerSync) window.ledgerSync.changed();
}

const touch = (item) => { item.updatedAt = Date.now(); return item; };

function forgetItem(id) {
  items = items.filter((i) => i.id !== id);
  tombstones = tombstones.filter((t) => t.id !== id).concat({ id, updatedAt: Date.now() });
}

// One place that turns anything (a backup file, a row from the cloud) into a clean item.
function normalizeItem(i) {
  return {
    id: i.id || uid(),
    name: String(i.name ?? ""),
    type: i.type || "Other",
    set: i.set || "",
    number: i.number || "",
    photo: okPhoto(i.photo) ? i.photo : "",
    qty: Number(i.qty) || 1,
    unitCost: Number(i.unitCost) || 0,
    buyDate: i.buyDate || today(),
    boughtFrom: i.boughtFrom || "",
    notes: i.notes || "",
    ref: /^(sealed|card):\S+$/.test(i.ref || "") ? i.ref : "",
    updatedAt: Number(i.updatedAt) || 0,
    sales: (Array.isArray(i.sales) ? i.sales : []).map((s) => ({
      id: s.id || uid(),
      date: s.date || today(),
      qty: Number(s.qty) || 0,
      unitPrice: Number(s.unitPrice) || 0,
      fees: Number(s.fees) || 0,
      platform: s.platform || "",
    })),
  };
}

/* ---------- helpers ---------- */

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => money.format(n);
const signed = (n) => (n < 0 ? "−" : "+") + money.format(Math.abs(n));
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const round2 = (n) => Math.round(n * 100) / 100;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function today() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function calc(item) {
  const soldQty = item.sales.reduce((s, x) => s + x.qty, 0);
  const revenue = item.sales.reduce((s, x) => s + x.qty * x.unitPrice, 0);
  const fees = item.sales.reduce((s, x) => s + x.fees, 0);
  const remaining = item.qty - soldQty;
  return {
    soldQty,
    remaining,
    totalCost: item.qty * item.unitCost,
    revenue,
    fees,
    profit: revenue - fees - soldQty * item.unitCost, // realized profit on units sold so far
    stockCost: remaining * item.unitCost,
  };
}

function saleProfit(item, s) {
  return s.qty * s.unitPrice - s.fees - s.qty * item.unitCost;
}

const itemMeta = (item) =>
  [item.set, item.number && "#" + item.number].filter(Boolean).join(" · ") || item.type || "—";

/* ---------- stats ---------- */

function renderStats() {
  const all = items.map(calc);
  const sum = (k) => all.reduce((s, c) => s + c[k], 0);
  const spent = sum("totalCost");
  const revenue = sum("revenue");
  const fees = sum("fees");
  const profit = sum("profit");
  const owned = sum("remaining");
  const soldUnits = sum("soldQty");
  const soldCost = revenue - fees - profit;
  const roi = soldCost > 0 ? (profit / soldCost) * 100 : null;

  const cards = [
    { label: "Total spent", value: fmt(spent), sub: `${items.length} purchase${items.length === 1 ? "" : "s"}` },
    { label: "Total sold for", value: fmt(revenue), sub: fees ? `${fmt(fees)} in fees` : "" },
    {
      label: "Realized profit",
      value: `<span class="${profit >= 0 ? "pos" : "neg"}">${signed(profit)}</span>`,
      sub: roi === null ? "" : `${roi.toFixed(1)}% return on sold items`,
      cls: "hl",
    },
    { label: "Items owned", value: owned, sub: owned ? `${fmt(sum("stockCost"))} at cost` : "" },
    { label: "Items sold", value: soldUnits, sub: "" },
  ];
  $("stats").innerHTML = cards.map((c) => `
    <div class="stat ${c.cls || ""}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${esc(c.sub)}</div>
    </div>`).join("");
}

/* ---------- what the inventory is worth now ---------- */

/*
 * An item picked from the search carries a `ref` (see the data model) and its price comes from there:
 *  - sealed: the market price in data/sealed.json (TCGplayer, refreshed daily by a GitHub Action)
 *  - cards:  TCGdex's TCGplayer market price, fetched live and kept on this device for 12 hours
 * Older sealed items with no ref are matched by exact product name. Graded cards aren't priced: the
 * grade changes the value a lot and there's no free source for graded prices.
 */

const SEALED_TYPES = ["Booster pack", "Booster box", "Elite Trainer Box", "Collection / tin / other sealed"];
const SINGLE_TYPES = ["Single card", "Graded card"];
const kindOf = (type) => (SEALED_TYPES.includes(type) ? "sealed" : "single");

const PRICE_CACHE_KEY = "card-ledger-card-prices";
const PRICE_TTL = 12 * 60 * 60 * 1000;
const market = { prices: new Map(), busy: false, again: false, failed: false, sealedDate: "" }; // prices: item id -> { v: updatedAt when priced, price|null }
const cardPrices = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
})();

// TCGdex lists a price per printing (normal, holofoil, reverse-holofoil...). Prefer the plain one so
// we don't assume a card is the pricier holo or reverse print.
function tcgplayerPrice(t) {
  const variants = Object.entries(t || {}).filter(([, v]) => v && typeof v === "object");
  const pick = ["normal", "holofoil"].map((k) => variants.find(([n]) => n === k)).find(Boolean) || variants[0];
  const price = pick ? (pick[1].marketPrice ?? pick[1].midPrice) : null;
  return Number.isFinite(price) ? price : null;
}

const pendingCards = new Map();
function cardPrice(id, force) {
  if (!pendingCards.has(id)) pendingCards.set(id, fetchCardPrice(id, force).finally(() => pendingCards.delete(id)));
  return pendingCards.get(id);
}

async function fetchCardPrice(id, force) {
  const hit = cardPrices[id];
  if (hit && !force && Date.now() - hit.at < PRICE_TTL) return hit.price;
  try {
    const card = await getJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`);
    const price = tcgplayerPrice(card.pricing?.tcgplayer);
    cardPrices[id] = { price, at: Date.now() };
    try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cardPrices)); } catch { /* a missing cache is fine */ }
    return price;
  } catch (err) {
    if (hit) return hit.price; // offline: an old price beats none
    throw err;
  }
}

const nameKey = (name) => [...new Set(tokenize(name))].sort().join(" ");

// Sealed item typed in by hand: link it only when exactly one product has its name (and set, if that narrows it).
async function autoRef(item) {
  if (kindOf(item.type) !== "sealed") return "";
  const idx = await loadSealed();
  if (!idx) return "";
  let hits = idx.items.filter((p) => nameKey(p.name) === nameKey(item.name));
  if (hits.length > 1 && item.set) {
    const sameSet = hits.filter((p) => cleanSetName(p.group).toLowerCase() === item.set.trim().toLowerCase());
    if (sameSet.length) hits = sameSet;
  }
  return hits.length === 1 ? "sealed:" + hits[0].id : "";
}

async function priceOf(item, force) {
  const ref = item.ref || (await autoRef(item));
  if (ref.startsWith("sealed:")) return (await loadSealed())?.byId.get(Number(ref.slice(7)))?.price ?? null;
  if (ref.startsWith("card:")) return cardPrice(ref.slice(5), force);
  return null;
}

// Prices whatever is in stock and hasn't been priced since it last changed. `force` re-fetches everything.
async function refreshPrices({ force = false } = {}) {
  if (market.busy) { market.again = true; return; }
  const todo = items.filter((it) => calc(it).remaining > 0 && it.type !== "Graded card" &&
    (force || market.prices.get(it.id)?.v !== it.updatedAt));
  if (!todo.length) return;

  market.busy = true;
  market.failed = false;
  renderMarket();
  try {
    if (force) await loadSealed(true);
    await Promise.all(todo.map(async (it) => {
      try { market.prices.set(it.id, { v: it.updatedAt, price: await priceOf(it, force) }); }
      catch { market.failed = true; } // no entry, so it's tried again next time
    }));
  } finally {
    market.busy = false;
    renderMarket();
    renderTable();
    if (market.again) { market.again = false; refreshPrices(); }
  }
}

function renderMarket() {
  let value = 0, paid = 0, units = 0, pricedUnits = 0;
  for (const it of items) {
    const n = calc(it).remaining;
    if (n <= 0) continue;
    units += n;
    const price = it.type === "Graded card" ? null : market.prices.get(it.id)?.price;
    if (price == null) continue;
    value += n * price;
    paid += n * it.unitCost;
    pricedUnits += n;
  }
  const gain = value - paid;
  const has = pricedUnits > 0;
  const notes = [];
  if (market.busy) notes.push("Checking prices…");
  else {
    if (units && !has) notes.push("No prices yet. Items picked from the search box are priced automatically.");
    else if (units > pricedUnits) notes.push(`${units - pricedUnits} not priced: graded cards, or items not picked from the search. Edit one and pick it from the results to price it.`);
    if (market.failed) notes.push("Couldn't reach the card database for some cards.");
    if (has) notes.push(`TCGplayer market prices${market.sealedDate ? `. Sealed as of ${fmtDate(market.sealedDate)}` : ""}.`);
  }

  $("market").innerHTML = `
    <div class="stat main">
      <div class="label">Worth right now</div>
      <div class="value${has ? "" : " dash"}">${has ? fmt(value) : "—"}</div>
      <div class="sub">${units ? `${pricedUnits} of ${units} item${units === 1 ? "" : "s"} priced` : "Nothing in inventory"}</div>
    </div>
    <div class="stat">
      <div class="label">If sold now</div>
      <div class="value sm${has ? "" : " dash"}">${has ? `<span class="${gain >= 0 ? "pos" : "neg"}">${signed(gain)}</span>` : "—"}</div>
      <div class="sub">${has && paid > 0 ? `${gain >= 0 ? "+" : "−"}${Math.abs((gain / paid) * 100).toFixed(1)}% over cost, before fees` : ""}</div>
    </div>
    <div class="note">
      ${notes.map((n) => `<p>${esc(n)}</p>`).join("")}
      <button class="link" type="button" id="refreshPrices"${market.busy || !units ? " disabled" : ""}>Refresh prices</button>
    </div>`;
}

$("market").addEventListener("click", (e) => {
  if (e.target.closest("#refreshPrices")) refreshPrices({ force: true });
});

/* ---------- table ---------- */

const SORTS = {
  newest: "Newest",
  oldest: "Oldest",
  name: "Name A–Z",
  cost: "Highest cost",
  "profit-desc": "Highest profit",
  "profit-asc": "Lowest profit",
};
const sortKeys = (tab) => (tab === "sold" ? Object.keys(SORTS) : ["newest", "oldest", "name", "cost"]);

const COLUMNS = {
  inventory: [["Item"], ["Qty", 1], ["Paid each", 1], ["Cost", 1], [""]],
  sold: [["Item"], ["Qty", 1], ["Paid each", 1], ["Total paid", 1], ["Sold for", 1], ["Profit · when · where", 1], [""]],
};

// One row per lot with units left (Inventory), or one row per sale (Sold).
function buildRows() {
  // Every word typed must appear somewhere in the item, ignoring case, hyphens and spaces, and with shorthand
  // like "etb" understood: "black etb", "pitch-black" and "PitchBlack ETB" all find "Pitch Black Elite Trainer Box".
  const squash = (s) => normalizeSearch(s).replace(/[^a-z0-9]/g, "");
  const terms = normalizeSearch(ui.search).split(/\s+/).map(squash).filter(Boolean);
  const matches = (item) => {
    if (!terms.length) return true;
    const fields = [item.name, item.set, item.number, item.type, item.boughtFrom, item.notes].map(squash);
    return terms.every((t) => fields.some((f) => f.includes(t)));
  };

  const rows = [];
  for (const item of items.filter(matches)) {
    const c = calc(item);
    if (ui.tab === "inventory") {
      if (c.remaining > 0) rows.push({ item, c, kind: kindOf(item.type), date: item.buyDate, cost: c.stockCost, profit: 0 });
    } else {
      for (const sale of item.sales) {
        rows.push({ item, c, sale, kind: kindOf(item.type), date: sale.date, cost: sale.qty * item.unitCost, profit: saleProfit(item, sale) });
      }
    }
  }

  const sorters = {
    newest: (a, b) => b.date.localeCompare(a.date),
    oldest: (a, b) => a.date.localeCompare(b.date),
    name: (a, b) => a.item.name.localeCompare(b.item.name),
    cost: (a, b) => b.cost - a.cost,
    "profit-desc": (a, b) => b.profit - a.profit,
    "profit-asc": (a, b) => a.profit - b.profit,
  };
  return rows.sort(sorters[ui.sort]);
}

// A photo is either a web link (e.g. an official card image) or a small JPEG the app made itself.
const okPhoto = (s) => /^https?:\/\//i.test(s || "") || /^data:image\/(jpeg|png|webp);base64,/i.test(s || "");

function thumb(item) {
  if (!okPhoto(item.photo)) return `<div class="thumb"></div>`;
  return `<div class="thumb" data-action="zoom" data-id="${item.id}" title="View photo">
    <img src="${esc(item.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">
  </div>`;
}

function itemCell(item) {
  return `<td class="full"><div class="cell-item">
    ${thumb(item)}
    <div class="item-text">
      <div class="item-name">${esc(item.name)}</div>
      <div class="item-meta">${esc(itemMeta(item))}</div>
    </div>
  </div></td>`;
}

function inventoryRow({ item, c }) {
  return `<tr class="entry" data-action="toggle" data-id="${item.id}">
    ${itemCell(item)}
    <td class="num" data-label="Qty">${c.remaining}${c.remaining < item.qty ? ` <span class="tiny">of ${item.qty}</span>` : ""}</td>
    <td class="num dim" data-label="Paid each">${fmt(item.unitCost)}</td>
    <td class="num" data-label="Cost">${fmt(c.stockCost)}</td>
    <td class="full"><div class="actions">
      <button class="mini primary" data-action="sell" data-id="${item.id}">Sell</button>
      <button class="mini" data-action="edit" data-id="${item.id}">Edit</button>
      <button class="mini x" data-action="delete" data-id="${item.id}" aria-label="Delete">✕</button>
    </div></td>
  </tr>`;
}

function soldRow({ item, sale, profit }) {
  const when = [fmtDate(sale.date), sale.platform].filter(Boolean).map(esc).join("  ·  ");
  return `<tr class="entry" data-action="toggle" data-id="${item.id}">
    ${itemCell(item)}
    <td class="num" data-label="Qty sold">${sale.qty}</td>
    <td class="num dim" data-label="Paid each">${fmt(item.unitCost)}</td>
    <td class="num" data-label="Total paid">${fmt(sale.qty * item.unitCost)}</td>
    <td class="num" data-label="Sold for">${fmt(sale.qty * sale.unitPrice)}${sale.fees ? `<div class="tiny">− ${fmt(sale.fees)} fees</div>` : ""}</td>
    <td class="num full" data-label="Profit · when · where">
      <span class="${profit >= 0 ? "pos" : "neg"}">${signed(profit)}</span>
      <span class="tiny">${when ? "  ·  " + when : ""}</span>
    </td>
    <td class="full"><div class="actions">
      <button class="mini primary" data-action="undo-sale" data-id="${item.id}" data-sale="${sale.id}">Undo sale</button>
      <button class="mini" data-action="edit" data-id="${item.id}">Edit</button>
      <button class="mini x" data-action="delete" data-id="${item.id}" aria-label="Delete">✕</button>
    </div></td>
  </tr>`;
}

function detailsRow({ item, c }, colspan) {
  const showSales = ui.tab === "inventory" && item.sales.length > 0;
  const price = ui.tab === "inventory" && item.type !== "Graded card" ? market.prices.get(item.id)?.price : null;
  return `<tr class="details"><td colspan="${colspan}">
    <p class="tiny">Bought ${fmtDate(item.buyDate)}${item.boughtFrom ? ` from ${esc(item.boughtFrom)}` : ""}
      · ${item.qty} × ${fmt(item.unitCost)} = ${fmt(c.totalCost)}${item.type ? ` · ${esc(item.type)}` : ""}</p>
    ${price != null ? `<p class="tiny">Market price now: ${fmt(price)} each · ${fmt(price * c.remaining)} for the ${c.remaining} you have</p>` : ""}
    ${item.notes ? `<p>${esc(item.notes)}</p>` : ""}
    ${showSales ? `<h4>Sales so far</h4><ul class="sales-list">${item.sales.map((s) => {
      const p = saleProfit(item, s);
      return `<li>
        <span>${fmtDate(s.date)}</span>
        <span>${s.qty} × ${fmt(s.unitPrice)}</span>
        ${s.fees ? `<span class="tiny">fees ${fmt(s.fees)}</span>` : ""}
        ${s.platform ? `<span class="tiny">${esc(s.platform)}</span>` : ""}
        <span class="${p >= 0 ? "pos" : "neg"}">${signed(p)}</span>
        <button class="mini" data-action="undo-sale" data-id="${item.id}" data-sale="${s.id}">Undo</button>
      </li>`;
    }).join("")}</ul>` : ""}
  </td></tr>`;
}

// The list is split into sealed product and cards (opened packs, singles, graded) so each is easy to see.
const GROUPS = [["sealed", "Sealed products"], ["single", "Cards · opened & singles"]];
const SHOW = [["all", "All"], ["sealed", "Sealed"], ["single", "Cards"]];

function renderKinds(counts) {
  $("kinds").innerHTML = SHOW.map(([k, label]) => {
    const n = k === "all" ? counts.sealed + counts.single : counts[k];
    return `<button class="tab" type="button" data-show="${k}" aria-pressed="${ui.show === k}">${label} <span class="tiny">${n}</span></button>`;
  }).join("");
}

// The heading row above each section, with what's in it.
function groupRow(label, part, colspan) {
  let text;
  if (ui.tab === "sold") {
    const units = part.reduce((s, r) => s + r.sale.qty, 0);
    const profit = part.reduce((s, r) => s + r.profit, 0);
    text = `${units} sold · <span class="${profit >= 0 ? "pos" : "neg"}">${signed(profit)}</span> profit`;
  } else {
    const units = part.reduce((s, r) => s + r.c.remaining, 0);
    const cost = part.reduce((s, r) => s + r.cost, 0);
    const prices = part.map((r) => (r.item.type === "Graded card" ? null : market.prices.get(r.item.id)?.price));
    const worth = prices.every((p) => p != null) // only quote a value when every item in the section has a price
      ? part.reduce((s, r, i) => s + r.c.remaining * prices[i], 0) : null;
    text = `${units} item${units === 1 ? "" : "s"} · ${fmt(cost)} at cost${worth != null ? ` · worth ${fmt(worth)}` : ""}`;
  }
  return `<tr class="group"><td colspan="${colspan}"><span class="group-name">${label}</span><span class="group-sum">${text}</span></td></tr>`;
}

function renderTable() {
  const cols = COLUMNS[ui.tab];
  $("head").innerHTML = `<tr>${cols.map(([label, num]) => `<th${num ? ' class="num"' : ""}>${label}</th>`).join("")}</tr>`;

  // keep the sort menu in step with the tab
  const keys = sortKeys(ui.tab);
  if (!keys.includes(ui.sort)) ui.sort = "newest";
  $("sort").innerHTML = keys.map((k) => `<option value="${k}">${SORTS[k]}</option>`).join("");
  $("sort").value = ui.sort;

  document.querySelectorAll(".tab[data-tab]").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.tab === ui.tab)));

  const everything = buildRows();
  const counts = { sealed: 0, single: 0 };
  for (const r of everything) counts[r.kind]++;
  renderKinds(counts);

  const rows = ui.show === "all" ? everything : everything.filter((r) => r.kind === ui.show);
  const html = [];
  for (const [kind, label] of GROUPS) {
    const part = rows.filter((r) => r.kind === kind);
    if (!part.length) continue;
    if (ui.show === "all") html.push(groupRow(label, part, cols.length));
    for (const r of part) {
      html.push(ui.tab === "sold" ? soldRow(r) : inventoryRow(r));
      if (ui.expanded.has(r.item.id)) html.push(detailsRow(r, cols.length));
    }
  }
  $("rows").innerHTML = html.join("");
  $("count").textContent = `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;

  $("empty").hidden = rows.length > 0;
  $("emptyText").textContent = ui.search.trim() ? `Nothing matches “${ui.search.trim()}”.`
    : ui.show !== "all" ? `No ${ui.show === "sealed" ? "sealed products" : "cards"} ${ui.tab === "sold" ? "sold yet" : "in your inventory"}.`
    : ui.tab === "sold" ? "Nothing sold yet."
    : "No items yet. Add your first one.";
}

function render() {
  renderMarket();
  renderStats();
  renderTable();
  refreshPrices();
}

/* ---------- add / edit item ---------- */

const itemDialog = $("itemDialog");
const itemForm = $("itemForm");
let editingId = null;

function updateTotalPreview() {
  const qty = Number(itemForm.qty.value) || 0;
  const cost = Number(itemForm.unitCost.value) || 0;
  $("totalCostPreview").value = fmt(qty * cost);
}

/*
 * A new item starts with a choice: single card or sealed product. Nothing else in the form shows until
 * it's made, and from then on the search, the photo reader and the Type list only deal with that kind.
 */
let addKind = ""; // "" until chosen, then "single" or "sealed"

function idleStatus() {
  return addKind === "sealed"
    ? "Add a photo of the box and I'll try to work out which product it is, or search by name below."
    : "Add a photo of a card and I'll try to fill in what it is.";
}

function setKind(k, currentType) {
  addKind = k;
  itemForm.classList.toggle("no-kind", !k);
  document.querySelectorAll(".kind-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === k)));
  $("kindHint").hidden = !!k;
  if (!k) return;

  const sealed = k === "sealed";
  const types = sealed ? SEALED_TYPES : SINGLE_TYPES;
  // an older item may carry a type that isn't in the list (e.g. "Other"): keep it selectable
  const list = currentType && !types.includes(currentType) && kindOf(currentType) === k ? [...types, currentType] : types;
  itemForm.type.innerHTML = list.map((t) => `<option>${esc(t)}</option>`).join("");
  itemForm.type.value = currentType && list.includes(currentType) ? currentType : types[0];

  $("numberField").hidden = sealed; // sealed products have no card number
  $("searchLabel").textContent = sealed ? "Find sealed product" : "Find card";
  $("cardSearch").placeholder = sealed ? "e.g. 30th Celebration Elite Trainer Box" : "e.g. Charizard 4/102";
  itemForm.name.placeholder = sealed ? "Pitch Black Elite Trainer Box" : "Charizard holo";
  itemForm.set.placeholder = sealed ? "Pitch Black" : "Base Set";
  setStatus(idleStatus());
}

// Switching kind part-way through: throw away what the other kind's search filled in.
function switchKind(k) {
  if (addKind) {
    lookupToken++;
    found = [];
    pickedId = "";
    $("cardSearch").value = "";
    renderResults();
    if (pickedRef) {
      for (const field of ["name", "set", "number"]) { itemForm.elements[field].value = ""; userEdited.delete(field); }
      if (photoIsOfficial) { photoData = ""; photoIsOfficial = false; renderPhoto(); }
      pickedRef = "";
      pickedName = "";
    }
    if (k === "sealed") itemForm.number.value = "";
  }
  const first = !addKind;
  setKind(k);
  if (first) $("cardSearch").focus();
}

$("kindPick").addEventListener("click", (e) => {
  const btn = e.target.closest(".kind-btn");
  if (btn && btn.dataset.kind !== addKind) switchKind(btn.dataset.kind);
});

function openItemDialog(item) {
  editingId = item ? item.id : null;
  $("itemTitle").textContent = item ? "Edit item" : "Add item";
  $("itemError").hidden = true;
  itemForm.reset();
  resetLookup(item);
  setKind(item ? kindOf(item.type) : "", item?.type);
  itemForm.name.value = item?.name ?? "";
  itemForm.set.value = item?.set ?? "";
  itemForm.number.value = item?.number ?? "";
  itemForm.qty.value = item?.qty ?? 1;
  itemForm.unitCost.value = item ? item.unitCost : "";
  itemForm.buyDate.value = item?.buyDate ?? today();
  itemForm.boughtFrom.value = item?.boughtFrom ?? "";
  itemForm.notes.value = item?.notes ?? "";
  updateTotalPreview();
  itemDialog.showModal();
  if (item) itemForm.name.focus();
}

itemForm.addEventListener("input", (e) => {
  // remember what the person typed themselves so auto-fill never overwrites it
  if (AUTOFILL_FIELDS.includes(e.target.name)) userEdited.add(e.target.name);
  updateTotalPreview();
});

itemForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = itemForm;
  const qty = parseInt(f.qty.value, 10);
  const unitCost = round2(Number(f.unitCost.value));
  const photo = photoData;
  const existing = editingId ? items.find((i) => i.id === editingId) : null;
  const soldQty = existing ? calc(existing).soldQty : 0;

  const error = !addKind ? "Choose whether this is a single card or a sealed product."
    : !f.name.value.trim() ? "Please enter a name."
    : !(qty >= 1) ? "Quantity must be at least 1."
    : f.unitCost.value === "" || !(unitCost >= 0) ? "Enter the price you paid."
    : qty < soldQty ? `You've already sold ${soldQty} of these, so quantity can't be lower than that.`
    : photo && !okPhoto(photo) ? "That photo can't be used. Remove it and add it again."
    : "";
  if (error) {
    $("itemError").textContent = error;
    $("itemError").hidden = false;
    return;
  }

  const data = {
    name: f.name.value.trim(),
    set: f.set.value.trim(),
    number: f.number.value.trim(),
    type: f.type.value,
    qty,
    unitCost,
    buyDate: f.buyDate.value,
    boughtFrom: f.boughtFrom.value.trim(),
    photo,
    notes: f.notes.value.trim(),
    // the link to the product it was picked as; dropped if the name was changed afterwards
    ref: pickedRef && f.name.value.trim() === pickedName ? pickedRef : "",
  };

  if (existing) touch(Object.assign(existing, data));
  else items.push(touch({ id: uid(), ...data, sales: [] }));

  saveItems();
  itemDialog.close();
  render();
});

/* ---------- photo + card lookup ---------- */

/*
 * Flow: the person picks a photo -> we shrink it and keep it with the item, read the card's
 * name and number from it on their device (Tesseract OCR), then look that up in the free
 * TCGdex database and fill in name, set, card number and type. The photo itself never leaves
 * the device; only the words we read are sent to the database. Anything the person typed
 * themselves is never overwritten by auto-fill.
 */

const TCGDEX = "https://api.tcgdex.net/v2/en";
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const AUTOFILL_FIELDS = ["name", "set", "number", "type"];

let photoData = "";          // photo saved with the item: a web link or a small JPEG data URL
let photoIsOfficial = false; // true when photoData is a database image we filled in ourselves
let userEdited = new Set();  // fields the person typed, which auto-fill must not overwrite
let lookupToken = 0;         // bumps on every new photo/search so slow answers can't land late
let found = [];              // current search results
let pickedId = "";
let pickedRef = "";          // "sealed:<id>" / "card:<id>" of the result picked (kept with the item so it can be priced)
let pickedName = "";         // the name in the form when it was picked; the link is dropped if the name changes

function setStatus(msg, ok = false) {
  const el = $("idStatus");
  el.textContent = msg;
  el.classList.toggle("ok", ok);
}

function resetLookup(item) {
  lookupToken++;
  photoData = item?.photo ?? "";
  photoIsOfficial = /^https:\/\/assets\.tcgdex\.net\//.test(photoData);
  userEdited = new Set(item ? AUTOFILL_FIELDS : []);
  found = [];
  pickedId = "";
  pickedRef = item?.ref ?? "";
  pickedName = item?.name ?? "";
  $("cardSearch").value = "";
  renderResults();
  setStatus(idleStatus());
  renderPhoto();
}

function renderPhoto() {
  $("photoThumb").innerHTML = okPhoto(photoData)
    ? `<img src="${esc(photoData)}" alt="" referrerpolicy="no-referrer">`
    : "<span>No photo</span>";
  $("photoRemove").hidden = !photoData;
  $("photoBtn").textContent = photoData ? "Replace photo" : "Take or choose photo";
}

function showPhoto(src) {
  if (!okPhoto(src)) return;
  $("photoBig").src = src;
  $("photoDialog").showModal();
}

/* -- photo file -> small JPEG + a bigger canvas for reading -- */

async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scaled(src, maxSide) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function handlePhoto(file) {
  const token = ++lookupToken;
  setStatus("Preparing photo…");
  let src;
  try {
    src = await loadImage(file);
  } catch {
    setStatus("Couldn't open that image. Try a JPEG or PNG.");
    return;
  }
  photoData = scaled(src, 420).toDataURL("image/jpeg", 0.75); // small enough to keep many in storage
  photoIsOfficial = false;
  renderPhoto();
  await identify(src, token);
  if (src.close) src.close();
}

/* -- reading the card (OCR) -- */

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return (tesseractLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { tesseractLoading = null; reject(new Error("could not load the text reader")); };
    document.head.appendChild(s);
  }));
}

// Names sit in the top strip of a card and the set number in the bottom strip, so read those
// separately (more accurate than one pass over the whole photo), then fall back to the whole photo.
async function readCardText(canvas, onProgress, wholePhoto) {
  const T = await loadTesseract();
  const worker = await T.createWorker("eng", 1, { logger: onProgress });
  try {
    if (wholePhoto) { // sealed boxes: the product name is printed anywhere on the front
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      return { top: "", bottom: "", full: (await worker.recognize(canvas)).data.text };
    }
    const { width: W, height: H } = canvas;
    // Lines the reader isn't sure about (table grain, glare, a border) are dropped, so they can't be mistaken for a name.
    const strip = async (top, height, minConfidence = 0) => {
      const { data } = await worker.recognize(canvas, {
        rectangle: { left: 0, top: Math.round(H * top), width: W, height: Math.round(H * height) },
      });
      return data.lines?.length
        ? data.lines.filter((l) => l.confidence >= minConfidence).map((l) => l.text).join("\n")
        : data.text;
    };

    await worker.setParameters({ tessedit_pageseg_mode: "6" }); // one block of text
    const out = { top: await strip(0, 0.2, 60), bottom: await strip(0.85, 0.15), full: "" };

    if (!guessNumber(out.bottom)) { // "4/102" only has digits and a slash, so let it read nothing else
      await worker.setParameters({ tessedit_char_whitelist: "0123456789/" });
      out.bottom += "\n" + (await strip(0.88, 0.12));
      await worker.setParameters({ tessedit_char_whitelist: "" });
    }

    if (!guessName(out.top) || !guessNumber(out.bottom)) {
      await worker.setParameters({ tessedit_pageseg_mode: "11" }); // whole page, scattered text (box art)
      out.full = (await worker.recognize(canvas)).data.text;
    }
    return out;
  } finally {
    worker.terminate();
  }
}

function guessName(text) {
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.replace(/\bHP\b.*$/i, "")                      // "Charizard   HP 120" -> "Charizard"
      .replace(/[^A-Za-zÀ-ÿ'’.\- ]+/g, " ").replace(/\s+/g, " ").trim()
      .replace(/^(basic|stage\s*[12]|restored|baby)\b\s*/i, "")
      .replace(/^pok[eé]mon\b\s*/i, "");                           // "Basic Pokémon" alone is a label, not a name
    if (/^(evolves|put|trainer|supporter|item|stadium|energy)\b/i.test(line)) continue;
    if (/[A-Za-zÀ-ÿ]{3,}/.test(line)) return line;
  }
  return "";
}

function guessNumber(text) {
  const m = String(text || "").match(/\b([A-Za-z]{0,3}\d{1,3})\s*[\/|]\s*([A-Za-z]{0,3}\d{2,3})\b/);
  return m ? { local: m[1], total: m[2] } : null;
}

/* -- looking it up (TCGdex) -- */

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const digits = (s) => String(s ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/*
 * Typed card search. TCGdex's own name search wants the exact spelling ("Lillie's Clefairy ex"), so "lillies clefairy"
 * finds nothing and "hop" finds Hoppip and Machop. So instead: ask TCGdex for every card containing the most telling
 * word, and do the matching here, which forgives apostrophes ("hops" = "Hop's"), plurals, short forms ("pika") and a
 * slip of the finger. Words like "sir", "alt art" or "mega hyper rare" narrow the results by rarity, and nicknames
 * such as "bubble mew" come from data/nicknames.json.
 */

const CARD_STOP_WORDS = new Set("card cards pokemon tcg the".split(" "));
const CARD_TYPE_WORDS = new Set("ex v vmax vstar gx mega break lv x y star prime".split(" "));

// lower case, no accents, apostrophes dropped so "Hop's" is "hops", then split into words
function cardWords(text) {
  return String(text || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const cardKey = (text) => cardWords(text).filter((w) => !CARD_STOP_WORDS.has(w)).join(" ");
const stemWord = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w); // "hops" -> "hop"

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Does one typed word match any word of a card's name?
function wordMatches(q, nameWords, lenient) {
  const sq = stemWord(q);
  return nameWords.some((w, i) => {
    const sw = stemWord(w);
    if (sw === sq || w === q) return true;
    if (q === "mega" && w === "m" && i === 0) return true;                       // older cards: "M Charizard-EX"
    if (q.length === 1 && w === q + "s") return true;                            // "n" -> "N's Zoroark ex"
    if (sq.length >= 4 && sw.startsWith(sq)) return true;                        // "pika" -> pikachu
    if (sq.length >= 5 && editDistance(sq, sw) <= (sq.length >= 8 ? 2 : 1)) return true; // a misspelling
    return lenient && sq.length >= 3 && sw.startsWith(sq);
  });
}

// Rarity words people type, and the TCGdex rarities they stand for. Longest phrases first; each is removed from the search.
const RARITY_WORDS = [
  [/\bmega hyper rares?\b|\bmhr\b/g, ["Mega Hyper Rare"]],
  [/\bhyper rares?\b|\bhr\b/g, ["Hyper rare", "Mega Hyper Rare"]],
  [/\bspecial (?:illustration|art) rares?\b|\bspecial illustrations?\b|\bsir\b|\bsar\b/g, ["Special illustration rare"]],
  [/\billustration rares?\b|\bir\b/g, ["Illustration rare"]],
  [/\balt(?:ernate|ernative)? art\b|\balt\b|\baa\b/g, ["Special illustration rare", "Illustration rare", "Ultra Rare", "Secret Rare"]],
  [/\bfull art\b|\bfa\b/g, ["Ultra Rare", "Full Art Trainer"]],
  [/\brainbow(?: rare)?\b|\bsecret rares?\b|\bsecret\b/g, ["Secret Rare", "Hyper rare"]],
  [/\bshiny rares?\b|\bshiny\b/g, ["Shiny rare", "Shiny Ultra Rare", "Shiny rare V", "Shiny rare VMAX"]],
  [/\bdouble rares?\b/g, ["Double rare"]],
  [/\bpromos?\b/g, ["Promo"]],
];

function extractRarities(text) {
  let rest = " " + String(text).toLowerCase().replace(/[-_]+/g, " ") + " ";
  const rarities = new Set();
  for (const [re, list] of RARITY_WORDS) {
    if (re.test(rest)) list.forEach((r) => rarities.add(r));
    re.lastIndex = 0;
    rest = rest.replace(re, " ");
  }
  return { rest: rest.replace(/\s+/g, " ").trim(), rarities: [...rarities] };
}

// Memoised, so typing more letters doesn't re-download the same cards.
const jsonCache = new Map();
function getJsonCached(url) {
  if (!jsonCache.has(url)) jsonCache.set(url, getJson(url).catch((err) => { jsonCache.delete(url); throw err; }));
  return jsonCache.get(url);
}

// Cards (brief) whose name contains `word`; for a misspelt word, retries with pieces of it.
async function cardsContaining(word, extra = "") {
  const stem = stemWord(word);
  const tries = [stem, ...(stem.length >= 5 ? [stem.slice(0, 5), stem.slice(-5)] : [])].filter((v, i, a) => a.indexOf(v) === i);
  for (const t of tries) {
    const res = await getJsonCached(`${TCGDEX}/cards?name=${encodeURIComponent(t)}${extra}`);
    if (Array.isArray(res) && res.length) return res;
  }
  return [];
}

async function searchCards({ name, number, total, rarities }) {
  const words = cardWords(name).filter((w) => !CARD_STOP_WORDS.has(w) && (w.length > 1 || w === "n"));
  if (!words.length) return [];
  const key = words.join(" ");

  // the most telling word: the longest one that isn't just "ex" or "vmax"
  const telling = words.filter((w) => !CARD_TYPE_WORDS.has(w));
  const anchor = (telling.length ? telling : words).reduce((a, b) => (b.length > a.length ? b : a));
  let brief = await cardsContaining(anchor);

  // TCG Pocket sets (ids like "A3a-002") are a different game
  brief = brief.filter((c) => !/^[A-Z]/.test(c.id));
  const nameWordsOf = (c) => cardWords(c.name);
  let pool = brief.filter((c) => words.every((q) => wordMatches(q, nameWordsOf(c), false)));
  if (!pool.length) { // nothing fits every word: allow short forms, and (with 3+ words) one word to be off
    pool = brief.filter((c) => {
      const missed = words.filter((q) => !wordMatches(q, nameWordsOf(c), true)).length;
      return missed === 0 || (words.length > 2 && missed === 1);
    });
  }

  if (rarities?.length) { // ask TCGdex which of these cards have the wanted rarities
    const allowed = new Set();
    await Promise.all(rarities.map(async (r) => {
      const res = await cardsContaining(anchor, `&rarity=${encodeURIComponent(r)}`).catch(() => []);
      res.forEach((c) => allowed.add(c.id));
    }));
    pool = pool.filter((c) => allowed.has(c.id));
  }

  const want = number ? digits(number) : "";
  if (want) {
    const sameNumber = pool.filter((c) => digits(c.localId) === want);
    if (sameNumber.length) pool = sameNumber;
  }

  // closest name first, then newest set first (TCGdex lists sets oldest to newest)
  const order = new Map((await allSets()).map((s, i) => [s.id, i]));
  const setOf = (c) => c.id.slice(0, c.id.lastIndexOf("-"));
  const extraWords = (c) => Math.max(0, cardWords(c.name).length - words.length);
  pool = pool.slice().sort((a, b) =>
    extraWords(a) - extraWords(b) || (order.get(setOf(b)) ?? -1) - (order.get(setOf(a)) ?? -1)).slice(0, 30);

  const details = await Promise.all(pool.map((c) =>
    getJsonCached(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
  return details.filter(Boolean).map((d) => cardResult(d, key, want, total))
    .sort((a, b) => b.score - a.score);
}

// Nicknames ("bubble mew", "moonbreon") aren't in any card database, so they come from a small file of our own.
let nicknameList = null;
function loadNicknames() {
  return (nicknameList ??= fetch("data/nicknames.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})));
}

async function nicknameCards(name) {
  const key = cardKey(name);
  if (!key) return [];
  const hits = [];
  for (const [nick, entry] of Object.entries(await loadNicknames())) {
    const nk = cardKey(nick);
    if (nk && !nick.startsWith("_") && (` ${key} `).includes(` ${nk} `)) hits.push({ nick, ids: entry.ids || [] });
  }
  const found = [];
  for (const { nick, ids } of hits) {
    const details = await Promise.all(ids.map((id) => getJsonCached(`${TCGDEX}/cards/${encodeURIComponent(id)}`).catch(() => null)));
    for (const d of details.filter(Boolean)) found.push({ ...cardResult(d, key, "", ""), alias: nick, score: 20 });
  }
  return found;
}

// A TCGdex card as a search result, scored on how well it fits the number and name that were read.
function cardResult(d, queryKey, wantNumber, total) {
  const official = d.set?.cardCount?.official ?? d.set?.cardCount?.total ?? "";
  const nm = cardKey(d.name);
  const numOk = !!wantNumber && digits(d.localId) === wantNumber;
  const totOk = !!total && String(official) === digits(total);
  const sameName = !!queryKey && nm === queryKey;
  return {
    kind: "card",
    id: d.id,
    ref: "card:" + d.id,
    name: d.name,
    setName: d.set?.name ?? "",
    // as printed on the card: "232/091", not "232/91"
    printed: official ? `${d.localId}/${/^\d+$/.test(d.localId) ? String(official).padStart(d.localId.length, "0") : official}` : String(d.localId),
    image: d.image ? `${d.image}/low.webp` : "",
    rarity: d.rarity && d.rarity !== "None" ? d.rarity : "",
    numOk,
    totOk,
    named: sameName,
    score: (numOk ? 3 : 0) + (totOk ? 3 : 0) + (sameName ? 2 : queryKey && nm.startsWith(queryKey) ? 1 : 0),
  };
}

// "4/102" means card 4 of a set with 102 cards: find the sets of that size and look the card up in each.
let setsList = null;
function allSets() {
  return (setsList ??= getJson(`${TCGDEX}/sets`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => { setsList = null; return []; }));
}

async function cardsByNumber(number, total, name) {
  const sets = (await allSets()).filter((s) => String(s.cardCount?.official) === digits(total)).slice(0, 8);
  const plain = String(number).replace(/^0+(?=\d)/, "");
  const ids = sets.flatMap((s) => [...new Set([`${s.id}-${plain}`, `${s.id}-${plain.padStart(3, "0")}`, `${s.id}-${number}`])]);
  const details = await Promise.all(ids.map((id) => getJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`).catch(() => null)));
  return details.filter(Boolean).map((d) => cardResult(d, cardKey(name), digits(number), total));
}

/* -- finding the card in a photo, and reading it -- */

/*
 * A photo rarely has the card filling the frame, and the name/number strips only line up if it does. So first
 * find the card: it's the biggest "busy" patch in the picture (artwork, text and a border, with lots of edges)
 * against a plainer table. Returns its box in the photo's pixels, or null if nothing card-sized stands out.
 */
function findCard(photo) {
  const W = 320, H = Math.max(1, Math.round((photo.height * W) / photo.width));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(photo, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  const edge = new Float32Array(W * H);
  let sum = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      edge[i] = Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]);
      sum += edge[i];
    }
  }
  const strong = Math.max(24, (sum / (W * H)) * 2);

  // a grid of 8px cells; a cell is "busy" when enough of its pixels are strong edges
  const CELL = 8, gw = Math.floor(W / CELL), gh = Math.floor(H / CELL);
  const busy = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let n = 0;
      for (let y = gy * CELL; y < (gy + 1) * CELL; y++) {
        for (let x = gx * CELL; x < (gx + 1) * CELL; x++) if (edge[y * W + x] > strong) n++;
      }
      busy[gy * gw + gx] = n > CELL * CELL * 0.12 ? 1 : 0;
    }
  }

  // the biggest connected patch of busy cells
  const seen = new Uint8Array(gw * gh);
  let best = null;
  for (let start = 0; start < busy.length; start++) {
    if (!busy[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0, x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % gw, y = (i / gw) | 0;
      n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const j of [x > 0 && i - 1, x < gw - 1 && i + 1, y > 0 && i - gw, y < gh - 1 && i + gw]) {
        if (j !== false && busy[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!best || n > best.n) best = { x0, y0, x1, y1 };
  }
  if (!best) return null;

  const k = photo.width / W, pad = 0.03 * Math.max(photo.width, photo.height);
  const left = Math.max(0, best.x0 * CELL * k - pad), top = Math.max(0, best.y0 * CELL * k - pad);
  const box = {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(Math.min(photo.width, (best.x1 + 1) * CELL * k + pad) - left),
    h: Math.round(Math.min(photo.height, (best.y1 + 1) * CELL * k + pad) - top),
  };
  const share = (box.w * box.h) / (photo.width * photo.height);
  return share > 0.08 && share < 0.9 ? box : null; // too small is noise; nearly everything means no clear card
}

// The card (or the whole photo) enlarged to a size the text reader copes with, in stretched black and white
// so a dim photo reads as well as a bright one.
function forReading(photo, box) {
  const b = box || { x: 0, y: 0, w: photo.width, h: photo.height };
  const k = Math.min(2.5, Math.max(1, 2000 / b.h));
  const c = document.createElement("canvas");
  c.width = Math.round(b.w * k);
  c.height = Math.round(b.h * k);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[lum(i) | 0]++;
  const n = c.width * c.height;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  if (hi - lo >= 40) {
    const gain = 255 / (hi - lo);
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, (lum(i) - lo) * gain));
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

// Is `needle` somewhere in `hay`, allowing a few misread letters? (approximate substring match)
function approxIncludes(hay, needle, maxErr) {
  let prev = Array.from({ length: needle.length + 1 }, (_, i) => i);
  for (const ch of hay) {
    const cur = [0];
    for (let j = 1; j <= needle.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (needle[j - 1] === ch ? 0 : 1));
    }
    if (cur[needle.length] <= maxErr) return true;
    prev = cur;
  }
  return false;
}

const lettersOnly = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

// Does the text read off the card contain this card's name?
function nameSeen(cardName, text) {
  const first = lettersOnly(String(cardName).split(/\s+/)[0]);
  const want = first.length >= 4 ? first : lettersOnly(cardName);
  return want.length >= 3 && approxIncludes(lettersOnly(text), want, want.length >= 8 ? 2 : want.length >= 5 ? 1 : 0);
}

/*
 * Reading a card photo: crop to the card, read the name (top) and set number (bottom), and identify it.
 * The printed number ("4/102": card 4 of a set with 102 cards) points at the set by itself, so it's checked
 * first, and the name only has to confirm it. If the cropped view isn't conclusive, the whole photo is tried too.
 */
async function recognizeCard(photo, onProgress) {
  const box = findCard(photo);
  const views = box ? [forReading(photo, box), forReading(photo, null)] : [forReading(photo, null)];
  let best = { results: [], name: "", num: null, failed: false };
  for (const view of views) {
    const text = await readCardText(view, onProgress);
    const name = guessName(text.top) || guessName(text.full);
    const num = guessNumber(text.bottom) || guessNumber(text.full) || guessNumber(text.top);
    const attempt = { results: [], name, num, failed: false, text };
    try {
      attempt.results = await resolveCard({ name, num, seen: lettersOnly(text.top).length >= 3 ? text.top : text.full });
    } catch {
      attempt.failed = true; // couldn't reach the card database
    }
    if (!best.text || (attempt.results[0]?.score ?? -1) > (best.results[0]?.score ?? -1)) best = attempt;
    if (attempt.results[0]?.sure) break;
  }
  return best;
}

async function resolveCard({ name, num, seen }) {
  const [byName, byNumber] = await Promise.all([
    name ? searchCards({ name, number: num?.local, total: num?.total }) : [],
    num?.total ? cardsByNumber(num.local, num.total, name).catch(() => []) : [],
  ]);
  const merged = new Map();
  for (const c of [...byNumber, ...byName]) if (!merged.has(c.id)) merged.set(c.id, c);
  const list = [...merged.values()];

  for (const c of list) {
    c.named = c.named || (!!seen && nameSeen(c.name, seen));
    if (c.named) c.score += 2;
  }
  list.sort((a, b) => b.score - a.score);

  // Certain only when number (and set size) match AND the name backs it up (or no name could be read and only
  // one card fits), with a clear lead over the runner-up.
  const numberFits = (c) => c.numOk && (c.totOk || !num?.total);
  const top = list[0];
  if (top) {
    top.sure = numberFits(top)
      && (top.named || (!name && list.filter(numberFits).length === 1))
      && (!list[1] || top.score - list[1].score >= 2);
  }
  return list.slice(0, 8);
}

/* -- sealed products (boxes, tins, collections...) -- */

/*
 * TCGdex only knows single cards, so sealed product comes from a snapshot the app ships with:
 * data/sealed.json, built by tools/build-sealed.mjs as [productId, groupIndex, name, marketPrice] rows.
 * Matching is by words: rare words ("celebration", "lucario") count far more than common ones
 * ("collection", "box"), so a photo's text only needs to contain the distinctive parts of a name.
 */

let sealedIndex = null;
function loadSealed(fresh) {
  if (fresh) sealedIndex = null;
  return (sealedIndex ??= fetch("data/sealed.json", fresh ? { cache: "no-cache" } : undefined)
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(buildSealedIndex)
    .catch(() => { sealedIndex = null; return null; })); // try again next time
}

const STOP_WORDS = new Set("the of and for with a an in by to pokemon tcg trading card cards game inc tm".split(" "));

// Shorthand people type, spelled out the way product names are.
const ALIASES = {
  etb: "elite trainer box",
  pc: "pokemon center",
  upc: "ultra premium collection",
  spc: "super premium collection",
  bb: "booster bundle",
  bbox: "booster box",
};

// One wording for everything we search with: lower case, no accents, "&" as "and", letters split by dots or
// hyphens rejoined ("E.T.B.", "e-t-b" -> "etb"), then shorthand spelled out ("etb" -> "elite trainer box").
// Hyphens between real words ("pitch-black") are left for the callers, which treat them as spaces.
function normalizeSearch(text) {
  return String(text || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // é -> e
    .replace(/&/g, " and ")
    .replace(/\b[a-z](?:[.-][a-z])+\b/g, (run) => run.replace(/[.-]/g, ""))
    .replace(/[a-z0-9]+/g, (word) => ALIASES[word] ?? word);
}

function tokenize(text) {
  return normalizeSearch(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// "pitchblack" or "elitetrainerbox" (hyphens and spaces dropped): split into words we know.
function splitGlued(token, df, depth = 0) {
  if (df.has(token) || token.length < 5 || depth > 3) return [token];
  for (let i = 2; i <= token.length - 2; i++) {
    const head = token.slice(0, i);
    if (!df.has(head)) continue;
    const rest = splitGlued(token.slice(i), df, depth + 1);
    if (rest.every((r) => df.has(r))) return [head, ...rest];
  }
  return [token];
}

const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

function buildSealedIndex(data) {
  market.sealedDate = data.generated || "";
  const items = data.items.map(([id, gi, name, price]) => ({
    id, name, price, group: data.groups[gi][1], tokens: [...new Set(tokenize(name))],
  }));
  const df = new Map();
  for (const it of items) for (const t of it.tokens) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => Math.log(1 + items.length / (1 + (df.get(t) || 0)));
  for (const it of items) it.total = it.tokens.reduce((s, t) => s + weight(t), 0);
  return { items, weight, df, byId: new Map(items.map((it) => [it.id, it])) };
}

// "ME: 30th Celebration" -> "30th Celebration", "SM - Cosmic Eclipse" -> "Cosmic Eclipse"
function cleanSetName(group) {
  if (/^miscellaneous/i.test(group)) return "";
  return group.replace(/^[A-Z]{2,5}\d{0,2}\s*[:\-]\s+/, "");
}

function guessSealedType(name) {
  const n = name.toLowerCase();
  if (/\bcase\b|\bbundle\b|\bblister\b/.test(n)) return "Collection / tin / other sealed";
  if (/elite trainer box/.test(n)) return "Elite Trainer Box";
  if (/booster (box|display)/.test(n)) return "Booster box";
  if (/booster pack/.test(n) && !/\d[- ]pack|pack of|display|box/.test(n)) return "Booster pack";
  return "Collection / tin / other sealed";
}

function sealedResult(it, score) {
  return {
    kind: "sealed",
    id: "p" + it.id,
    ref: "sealed:" + it.id,
    name: it.name,
    setName: cleanSetName(it.group),
    printed: "",
    image: `https://tcgplayer-cdn.tcgplayer.com/product/${it.id}_200w.jpg`,
    type: guessSealedType(it.name),
    score,
    strong: false,
  };
}

// Typed search: how much of what you typed does the product name cover.
// Photo search (query.ocrText): how much of the product name appears in the text read off the box.
async function searchSealed(query) {
  const idx = await loadSealed();
  if (!idx) return [];
  const ocr = !!query.ocrText;
  let qTokens = [...new Set(tokenize(ocr ? query.ocrText : query.name))];
  if (!ocr) qTokens = [...new Set(qTokens.flatMap((t) => splitGlued(t, idx.df)))]; // typed "pitchblack" -> pitch black
  if (!qTokens.length) return [];
  const qTotal = qTokens.reduce((s, t) => s + idx.weight(t), 0);

  const scored = [];
  for (const it of idx.items) {
    let matched = 0, count = 0, covered = 0;
    for (const t of it.tokens) {
      if (qTokens.some((q) => sameWord(q, t))) { matched += idx.weight(t); count++; }
    }
    if (!count) continue;
    for (const q of qTokens) {
      if (it.tokens.some((t) => sameWord(q, t))) covered += idx.weight(q);
    }
    const precision = matched / it.total;
    const coverage = covered / qTotal;
    if (ocr ? !(count >= 2 && precision >= 0.5) : coverage < 0.5) continue;
    scored.push({ it, matched, score: ocr ? precision : 0.75 * coverage + 0.25 * precision });
  }
  scored.sort((a, b) => b.score - a.score); // stable: ties keep newest set first

  const results = scored.slice(0, ocr ? 6 : 8).map(({ it, score }) => sealedResult(it, score));
  // Only treat a photo match as certain when it's a near-complete, distinctive name with a clear lead.
  if (ocr && scored.length) {
    const [top, next] = scored;
    results[0].strong = top.score >= 0.8 && top.matched >= 5 && (!next || top.score - next.score >= 0.08);
  }
  return results;
}

/* -- recognising a sealed product from a photo (matching pictures, not text) -- */

/*
 * Box art is mostly logos and artwork, which text reading can't make sense of. So instead the photo is
 * compared with pictures: data/sealed-vec.* holds a small "fingerprint" of every product's official box art
 * (built by tools/build-vectors.mjs with the DINOv2-small vision model). Here the same model, downloaded once
 * (about 22 MB) and run on the device, fingerprints the photo, and the closest products win. The photo never
 * leaves the device.
 * The box can sit anywhere in a real photo, so the photo is fingerprinted at several zoom levels (centred
 * squares of different size) and each product keeps its best score.
 */
const VISION = {
  lib: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0",
  model: "Xenova/dinov2-small",
  dtype: "uint8",
  size: 224,
  crops: [0.9, 0.75, 0.6, 0.5, 0.4],
  sure: { score: 0.8, margin: 0.05 }, // how close, and how far ahead of the runner-up, counts as certain (tuned on test photos: no wrong auto-fills)
};

let visionLoading = null;
function loadVision(onProgress) {
  return (visionLoading ??= (async () => {
    const T = await import(VISION.lib);
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status !== "progress" || !p.total) return;
      files.set(p.file, p);
      const all = [...files.values()];
      const total = all.reduce((s, f) => s + f.total, 0);
      onProgress?.(Math.round((100 * all.reduce((s, f) => s + f.loaded, 0)) / total));
    };
    const model = await T.AutoModel.from_pretrained(VISION.model, { dtype: VISION.dtype, progress_callback });
    const processor = await T.AutoProcessor.from_pretrained(VISION.model);
    processor.do_resize = false; // we hand it a ready 224 x 224 square
    processor.do_center_crop = false;
    return { T, model, processor };
  })().catch((err) => { visionLoading = null; throw err; }));
}

let vectorsLoading = null;
function loadVectors() {
  return (vectorsLoading ??= (async () => {
    const [meta, buf] = await Promise.all([
      fetch("data/sealed-vec.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetch("data/sealed-vec.bin").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); }),
    ]);
    if (meta.model !== VISION.model || meta.dtype !== VISION.dtype || meta.size !== VISION.size) {
      throw new Error("the product fingerprints were made with a different model");
    }
    return { ids: meta.ids, dim: meta.dim, scale: meta.scale, rows: new Int8Array(buf) };
  })().catch((err) => { vectorsLoading = null; throw err; }));
}

// A centred square of the photo (frac = share of its shorter side), scaled to the model's input size.
// Must stay in step with how tools/build-vectors.mjs prepares product pictures (square, no stretching).
function squareOf(photo, frac) {
  const side = Math.round(Math.min(photo.width, photo.height) * frac);
  const c = document.createElement("canvas");
  c.width = c.height = VISION.size;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "rgb(128,128,128)";
  x.fillRect(0, 0, VISION.size, VISION.size);
  x.imageSmoothingQuality = "high";
  x.drawImage(photo, Math.round((photo.width - side) / 2), Math.round((photo.height - side) / 2), side, side, 0, 0, VISION.size, VISION.size);
  return c;
}

async function fingerprint(vision, square) {
  const px = square.getContext("2d").getImageData(0, 0, VISION.size, VISION.size).data;
  const rgb = new Uint8ClampedArray(VISION.size * VISION.size * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
  const out = await vision.model(await vision.processor(new vision.T.RawImage(rgb, VISION.size, VISION.size, 3)));
  const hidden = out.last_hidden_state;
  const cls = Float32Array.from(hidden.data.slice(0, hidden.dims[2])); // the first token summarises the whole picture
  const norm = Math.hypot(...cls) || 1;
  return cls.map((v) => v / norm);
}

// Returns the closest products (best first), each with a cosine `score`, or throws if the matcher can't run.
async function matchSealedPhoto(photo, onProgress) {
  const [vision, vecs, idx] = await Promise.all([loadVision(onProgress), loadVectors(), loadSealed()]);
  if (!idx) throw new Error("the product list isn't available");
  const queries = [];
  for (const frac of VISION.crops) queries.push(await fingerprint(vision, squareOf(photo, frac)));

  const { ids, dim, scale, rows } = vecs;
  const unit = scale / 127;
  const best = new Float32Array(ids.length).fill(-1);
  for (const q of queries) {
    for (let i = 0, o = 0; i < ids.length; i++, o += dim) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += q[d] * rows[o + d];
      s *= unit;
      if (s > best[i]) best[i] = s;
    }
  }
  const order = [...best.keys()].sort((a, b) => best[b] - best[a]);
  const results = [];
  for (const i of order) {
    const it = idx.byId.get(ids[i]);
    if (it) results.push(sealedResult(it, best[i]));
    if (results.length === 8) break;
  }
  if (results.length) {
    const lead = results[0].score - (results[1]?.score ?? 0);
    results[0].strong = results[0].score >= VISION.sure.score && lead >= VISION.sure.margin;
  }
  return results;
}


/* -- parsing what was typed / how results are shown and applied -- */

// "mew ex sir 232/091" -> the name words, the number, and any rarity words ("sir", "alt art", "mega hyper rare"...)
function parseQuery(text) {
  const t = text.trim();
  let query = { name: t, raw: t };
  let m = t.match(/^(.*\S)[\s-]+([A-Za-z]{0,3}\d{1,3})\s*\/\s*([A-Za-z]{0,3}\d{2,3})$/); // "charizard 4/102" or "charizard-4/102"
  if (m) query = { name: m[1], number: m[2], total: m[3], raw: t };
  else if ((m = t.match(/^(.*\S)\s+(\d{1,3})$/))) query = { name: m[1], number: m[2], raw: t };  // "charizard 4"
  const { rest, rarities } = extractRarities(query.name);
  return rarities.length ? { ...query, name: rest, rarities } : query;
}

const describe = (c) => [c.name, c.setName, c.printed && "#" + c.printed].filter(Boolean).join(" · ");

function renderResults() {
  const box = $("cardResults");
  box.hidden = found.length === 0;
  box.innerHTML = found.map((c, i) => `
    <button type="button" class="result${c.id === pickedId ? " picked" : ""}" data-i="${i}">
      ${c.image
        ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
        : `<i class="noimg"></i>`}
      <div>
        <b>${esc(c.name)}</b>
        <span>${esc([c.setName, c.printed && "#" + c.printed, c.rarity, c.alias && `“${c.alias}”`].filter(Boolean).join(" · "))}</span>
      </div>
    </button>`).join("");
}

function applyCard(card, explicit) {
  // auto-fill leaves alone anything the person typed; tapping a result themselves overrides
  const put = (field, value) => {
    if (explicit || !userEdited.has(field)) itemForm.elements[field].value = value;
  };
  put("name", card.name);
  put("set", card.setName);
  put("number", card.printed); // sealed products have none, which clears a leftover card number
  put("type", card.kind === "sealed" ? card.type : itemForm.type.value === "Graded card" ? "Graded card" : "Single card");
  // the official picture is only a stand-in until they add their own photo
  if (card.image && (!photoData || photoIsOfficial)) {
    photoData = card.image;
    photoIsOfficial = true;
    renderPhoto();
  }
  pickedId = card.id;
  pickedRef = card.ref;
  pickedName = itemForm.name.value.trim();
  renderResults();
}

// Show a list of matches. `auto` means they came from a photo, so a confident first result is filled in.
function showMatches(list, { auto, sealed, failed, query = {}, vision }) {
  found = list;
  pickedId = "";

  if (!found.length) {
    renderResults();
    setStatus(failed
      ? "Couldn't reach the card database. Check your connection, or fill in the details yourself."
      : sealed
        ? auto
          ? "Couldn't tell which product that is from the photo. Type its name in Find sealed product, or try a straighter, brighter photo."
          : `No sealed product matches “${query.name}”. Try fewer words, like the set name and “Elite Trainer Box”, or fill in the details yourself.`
        : query.name
          ? `Nothing found for “${query.name}”. Try fewer words.`
          : "Couldn't tell what card that is from the photo. Type its name in Find card, or try a straighter, brighter photo.");
    return;
  }

  const top = found[0];
  const pick = sealed ? (top.strong ? top : null) : (top.sure ? top : null);
  if (auto && pick) {
    applyCard(pick, false);
    if (sealed) $("cardSearch").value = pick.name; // replace any junk words read off the box
    setStatus(`Filled in from the photo: ${describe(pick)}. Wrong one? Pick another below.`, true);
  } else {
    renderResults();
    setStatus(auto
      ? `${vision ? "Here are the closest matches to the photo" : "I read the photo but wasn't sure what it is"}. Pick yours below, or type a name in ${sealed ? "Find sealed product" : "Find card"}.`
      : "Pick the match below.");
  }
}

// Search only the kind the person chose: sealed products come from the local list, cards from TCGdex.
async function lookup(query, token, auto) {
  const sealed = addKind === "sealed";
  setStatus(`Looking up “${query.name || "the photo"}”…`);
  let list = [], failed = false;

  if (sealed) {
    list = await searchSealed(query).catch(() => []); // local, so works offline
  } else if (query.name) {
    const nicknamed = await nicknameCards(query.name).catch(() => []); // "bubble mew" and the like
    try {
      const searched = await searchCards(query);
      list = [...nicknamed, ...searched.filter((c) => !nicknamed.some((n) => n.id === c.id))];
    } catch {
      list = nicknamed;
      failed = !nicknamed.length;
    }
  }
  if (token !== lookupToken) return;
  showMatches(list, { auto, sealed, failed, query });
}

async function identify(src, token) {
  const sealed = addKind === "sealed";
  // Box matching only needs a modest size; a card's small print is read from as many pixels as we can afford.
  const canvas = scaled(src, sealed ? 1600 : 2600);

  if (sealed) {
    // Boxes are matched by how they look. If that can't run (say, no connection for the first download),
    // fall back to reading the words on the box.
    let matches = null;
    try {
      setStatus("Getting the image matcher ready… (first time only, about 22 MB)");
      matches = await matchSealedPhoto(canvas, (pct) => {
        if (token === lookupToken) setStatus(`Getting the image matcher ready… ${pct}% (first time only, about 22 MB)`);
      });
      if (token === lookupToken) setStatus("Comparing your photo with the known products…");
    } catch (err) {
      console.warn("image matching unavailable:", err);
    }
    if (token !== lookupToken) return;
    if (matches) {
      showMatches(matches, { auto: true, sealed: true, vision: true });
      return;
    }
  }

  const progress = (m) => {
    if (token === lookupToken && m.status === "recognizing text") {
      setStatus(`Reading the photo… ${Math.round((m.progress || 0) * 100)}%`);
    }
  };
  setStatus("Getting the text reader ready… (first time only, this can take a minute)");

  if (!sealed) {
    // Cards: find the card in the photo, read its name and set number, and identify it.
    let read;
    try {
      read = await recognizeCard(canvas, progress);
    } catch {
      if (token === lookupToken) setStatus("Couldn't run the text reader (it needs an internet connection). Type the name in Find card instead.");
      return;
    }
    if (token !== lookupToken) return;
    if (!read.name && !read.num) {
      setStatus("Couldn't read a card name or number from that photo. Type it in Find card, or try a straighter, brighter photo.");
      return;
    }
    const printed = read.num ? `${read.num.local}/${read.num.total}` : "";
    $("cardSearch").value = [read.name, printed].filter(Boolean).join(" ");
    showMatches(read.results, { auto: true, sealed: false, failed: read.failed, query: { name: read.name } });
    return;
  }

  // Sealed, with no picture match: match the words printed on the box against the known products.
  let text;
  try {
    text = await readCardText(canvas, progress, true);
  } catch {
    if (token === lookupToken) setStatus("Couldn't run the text reader (it needs an internet connection). Type the name in Find sealed product instead.");
    return;
  }
  if (token !== lookupToken) return;
  await lookup({ name: "", raw: "", ocrText: text.full }, token, true);
}


/* -- wiring -- */

$("photoBtn").addEventListener("click", () => $("photoFile").click());
$("photoThumb").addEventListener("click", () => (photoData ? showPhoto(photoData) : $("photoFile").click()));
$("photoRemove").addEventListener("click", () => { photoData = ""; photoIsOfficial = false; renderPhoto(); });
$("photoFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) handlePhoto(file);
});
$("photoDialog").addEventListener("click", () => $("photoDialog").close());

let searchTimer;
function searchNow() {
  clearTimeout(searchTimer);
  const text = $("cardSearch").value;
  if (text.trim().length < 3) return;
  lookup(addKind === "sealed" ? { name: text.trim(), raw: text.trim() } : parseQuery(text), ++lookupToken, false);
}
$("cardSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  if ($("cardSearch").value.trim().length < 3) {
    lookupToken++;
    found = [];
    renderResults();
    return;
  }
  searchTimer = setTimeout(searchNow, 450);
});
$("cardSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); searchNow(); }
});

$("cardResults").addEventListener("click", (e) => {
  const btn = e.target.closest(".result");
  const card = btn && found[Number(btn.dataset.i)];
  if (!card) return;
  applyCard(card, true);
  setStatus(`Filled in: ${describe(card)}`, true);
});

// if the dialog is closed mid-lookup, drop any answer that arrives afterwards
itemDialog.addEventListener("close", () => { lookupToken++; });

/* ---------- record a sale ---------- */

const sellDialog = $("sellDialog");
const sellForm = $("sellForm");
let sellingId = null;

function openSellDialog(item) {
  const c = calc(item);
  sellingId = item.id;
  $("sellTitle").textContent = `Record a sale: ${item.name}`;
  $("sellInfo").textContent = `${c.remaining} in inventory · you paid ${fmt(item.unitCost)} each`;
  $("sellError").hidden = true;
  sellForm.reset();
  sellForm.qty.max = c.remaining;
  sellForm.qty.value = c.remaining;
  sellForm.unitPrice.value = "";
  sellForm.fees.value = "0";
  sellForm.date.value = today();
  updateSellPreview();
  sellDialog.showModal();
  sellForm.unitPrice.focus();
}

function updateSellPreview() {
  const item = items.find((i) => i.id === sellingId);
  if (!item) return;
  const qty = Number(sellForm.qty.value) || 0;
  const price = Number(sellForm.unitPrice.value) || 0;
  const fees = Number(sellForm.fees.value) || 0;
  const profit = qty * price - fees - qty * item.unitCost;
  $("sellPreview").innerHTML = `Profit on this sale: <span class="${profit >= 0 ? "pos" : "neg"}">${signed(profit)}</span>`;
}

sellForm.addEventListener("input", updateSellPreview);

sellForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const item = items.find((i) => i.id === sellingId);
  if (!item) return;
  const f = sellForm;
  const qty = parseInt(f.qty.value, 10);
  const unitPrice = round2(Number(f.unitPrice.value));
  const fees = round2(Number(f.fees.value) || 0);
  const remaining = calc(item).remaining;

  const error = !(qty >= 1) ? "Quantity must be at least 1."
    : qty > remaining ? `You only have ${remaining} left.`
    : f.unitPrice.value === "" || !(unitPrice >= 0) ? "Enter the price you sold it for."
    : !(fees >= 0) ? "Fees can't be negative."
    : "";
  if (error) {
    $("sellError").textContent = error;
    $("sellError").hidden = false;
    return;
  }

  item.sales.push({ id: uid(), date: f.date.value, qty, unitPrice, fees, platform: f.platform.value.trim() });
  touch(item);
  saveItems();
  sellDialog.close();
  render();
});

/* ---------- table actions ---------- */

$("rows").addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const item = items.find((i) => i.id === el.dataset.id);
  if (!item) return;

  switch (el.dataset.action) {
    case "zoom":
      showPhoto(item.photo);
      break;
    case "toggle":
      ui.expanded.has(item.id) ? ui.expanded.delete(item.id) : ui.expanded.add(item.id);
      renderTable();
      break;
    case "sell":
      openSellDialog(item);
      break;
    case "edit":
      openItemDialog(item);
      break;
    case "delete":
      if (confirm(`Delete "${item.name}" and its sales history? This can't be undone.`)) {
        forgetItem(item.id);
        ui.expanded.delete(item.id);
        saveItems();
        render();
      }
      break;
    case "undo-sale":
      if (confirm("Undo this sale? The units go back into inventory.")) {
        item.sales = item.sales.filter((s) => s.id !== el.dataset.sale);
        touch(item);
        saveItems();
        render();
      }
      break;
  }
});

/* ---------- toolbar + dialogs ---------- */

$("addBtn").addEventListener("click", () => openItemDialog(null));
$("search").addEventListener("input", (e) => { ui.search = e.target.value; renderTable(); });
$("sort").addEventListener("change", (e) => { ui.sort = e.target.value; renderTable(); });
document.querySelectorAll(".tab[data-tab]").forEach((t) =>
  t.addEventListener("click", () => { ui.tab = t.dataset.tab; renderTable(); }));
$("kinds").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-show]");
  if (btn) { ui.show = btn.dataset.show; renderTable(); }
});

document.querySelectorAll("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close()));

// click on the dimmed backdrop closes a dialog
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

/* ---------- export / import ---------- */

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$("exportCsv").addEventListener("click", () => {
  const header = ["Name", "Set", "Card no.", "Type", "Date bought", "Where bought", "Qty bought", "Paid each",
    "Total paid", "Qty sold", "Qty left", "Sales revenue", "Fees", "Net sales", "Profit", "Status", "Notes"];
  const lines = items.map((item) => {
    const c = calc(item);
    const status = c.remaining === 0 ? "Sold" : c.soldQty > 0 ? "Partly sold" : "In inventory";
    return [item.name, item.set, item.number, item.type, item.buyDate, item.boughtFrom, item.qty,
      item.unitCost.toFixed(2), c.totalCost.toFixed(2), c.soldQty, c.remaining,
      c.revenue.toFixed(2), c.fees.toFixed(2), (c.revenue - c.fees).toFixed(2), c.profit.toFixed(2),
      status, item.notes].map(csvCell).join(",");
  });
  download(`card-ledger-${today()}.csv`, [header.join(","), ...lines].join("\r\n"), "text/csv");
});

$("exportJson").addEventListener("click", () => {
  download(`card-ledger-backup-${today()}.json`, JSON.stringify(items, null, 2), "application/json");
});

$("importBtn").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const valid = Array.isArray(data) && data.every((i) =>
      i && typeof i.name === "string" && Number(i.qty) >= 1 && Number.isFinite(Number(i.unitCost)));
    if (!valid) throw new Error("bad format");
    if (!confirm(`Replace your current data (${items.length} items) with this backup (${data.length} items)?`)) return;
    const incoming = data.map((i) => touch(normalizeItem(i)));
    // items that were here but aren't in the backup are being replaced, so other devices should drop them too
    const keep = new Set(incoming.map((i) => i.id));
    for (const old of items) if (!keep.has(old.id)) forgetItem(old.id);
    tombstones = tombstones.filter((t) => !keep.has(t.id));
    items = incoming;
    saveItems();
    render();
  } catch {
    alert("That file doesn't look like a backup from this app.");
  }
});

/* ---------- installable / offline (PWA) ---------- */

// Service workers only run over http(s), not when index.html is opened straight from disk.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
// Ask the browser not to evict our saved data when storage is low.
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

render();
