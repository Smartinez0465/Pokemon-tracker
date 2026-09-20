"use strict";

// Kept as "pokemon-inventory-v1" so data saved by earlier versions still loads.
const STORAGE_KEY = "pokemon-inventory-v1";

/*
 * Data model
 * item = { id, name, type, set, number, photo, qty, unitCost, buyDate, boughtFrom, notes,
 *          sales: [{ id, date, qty, unitPrice, fees, platform }] }
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
const ui = { search: "", tab: "inventory", sort: "newest", expanded: new Set() };

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
  const q = ui.search.trim().toLowerCase();
  const matches = (item) => !q ||
    [item.name, item.set, item.number, item.type, item.boughtFrom, item.notes]
      .some((f) => (f || "").toLowerCase().includes(q));

  const rows = [];
  for (const item of items.filter(matches)) {
    const c = calc(item);
    if (ui.tab === "inventory") {
      if (c.remaining > 0) rows.push({ item, c, date: item.buyDate, cost: c.stockCost, profit: 0 });
    } else {
      for (const sale of item.sales) {
        rows.push({ item, c, sale, date: sale.date, cost: sale.qty * item.unitCost, profit: saleProfit(item, sale) });
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
  return `<tr class="details"><td colspan="${colspan}">
    <p class="tiny">Bought ${fmtDate(item.buyDate)}${item.boughtFrom ? ` from ${esc(item.boughtFrom)}` : ""}
      · ${item.qty} × ${fmt(item.unitCost)} = ${fmt(c.totalCost)}${item.type ? ` · ${esc(item.type)}` : ""}</p>
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

function renderTable() {
  const cols = COLUMNS[ui.tab];
  $("head").innerHTML = `<tr>${cols.map(([label, num]) => `<th${num ? ' class="num"' : ""}>${label}</th>`).join("")}</tr>`;

  // keep the sort menu in step with the tab
  const keys = sortKeys(ui.tab);
  if (!keys.includes(ui.sort)) ui.sort = "newest";
  $("sort").innerHTML = keys.map((k) => `<option value="${k}">${SORTS[k]}</option>`).join("");
  $("sort").value = ui.sort;

  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.tab === ui.tab)));

  const rows = buildRows();
  const html = [];
  for (const r of rows) {
    html.push(ui.tab === "sold" ? soldRow(r) : inventoryRow(r));
    if (ui.expanded.has(r.item.id)) html.push(detailsRow(r, cols.length));
  }
  $("rows").innerHTML = html.join("");
  $("count").textContent = `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;

  $("empty").hidden = rows.length > 0;
  $("emptyText").textContent = ui.search.trim() ? `Nothing matches “${ui.search.trim()}”.`
    : ui.tab === "sold" ? "Nothing sold yet."
    : "No items yet. Add your first one.";
}

function render() {
  renderStats();
  renderTable();
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

function openItemDialog(item) {
  editingId = item ? item.id : null;
  $("itemTitle").textContent = item ? "Edit item" : "Add item";
  $("itemError").hidden = true;
  itemForm.reset();
  itemForm.name.value = item?.name ?? "";
  itemForm.set.value = item?.set ?? "";
  itemForm.number.value = item?.number ?? "";
  itemForm.type.value = item?.type ?? "Single card";
  itemForm.qty.value = item?.qty ?? 1;
  itemForm.unitCost.value = item ? item.unitCost : "";
  itemForm.buyDate.value = item?.buyDate ?? today();
  itemForm.boughtFrom.value = item?.boughtFrom ?? "";
  itemForm.notes.value = item?.notes ?? "";
  resetLookup(item);
  updateTotalPreview();
  itemDialog.showModal();
  itemForm.name.focus();
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

  const error = !f.name.value.trim() ? "Please enter a name."
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
  $("cardSearch").value = "";
  renderResults();
  setStatus("Add a photo of a card or sealed product and I'll try to fill in what it is.");
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
  await identify(scaled(src, 1600), token);
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
async function readCardText(canvas, onProgress) {
  const T = await loadTesseract();
  const worker = await T.createWorker("eng", 1, { logger: onProgress });
  try {
    const { width: W, height: H } = canvas;
    const strip = async (top, height) => (await worker.recognize(canvas, {
      rectangle: { left: 0, top: Math.round(H * top), width: W, height: Math.round(H * height) },
    })).data.text;

    await worker.setParameters({ tessedit_pageseg_mode: "6" }); // one block of text
    const out = { top: await strip(0, 0.18), bottom: await strip(0.85, 0.15), full: "" };

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
      .replace(/^(basic|stage\s*[12]|restored|baby)\b\s*/i, "");
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

async function searchCards({ name, number, total }) {
  const base = String(name).trim();
  const first = base.split(/\s+/)[0];
  // a misread letter or two shouldn't sink the search, so retry with shorter versions of the name
  const tries = [base, first, first.slice(0, 5)].filter((v, i, a) => v.length >= 3 && a.indexOf(v) === i);

  let list = [];
  for (const q of tries) {
    const res = await getJson(`${TCGDEX}/cards?name=${encodeURIComponent(q)}`);
    list = Array.isArray(res) ? res : [];
    if (list.length) break;
  }

  const want = number ? digits(number) : "";
  const lower = base.toLowerCase();
  const rank = (c) => (c.name.toLowerCase() === lower ? 0 : c.name.toLowerCase().startsWith(lower) ? 1 : 2);
  let pool = list;
  if (want) {
    const sameNumber = list.filter((c) => digits(c.localId) === want);
    if (sameNumber.length) pool = sameNumber;
  }
  pool = pool.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 12);

  // the list doesn't say which set a card is from, so fetch each candidate's details
  const details = await Promise.all(pool.map((c) =>
    getJson(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));

  return details.filter(Boolean).map((d) => {
    const official = d.set?.cardCount?.official ?? d.set?.cardCount?.total ?? "";
    const nm = d.name.toLowerCase();
    const numOk = !!want && digits(d.localId) === want;
    const totOk = !!total && String(official) === digits(total);
    return {
      kind: "card",
      id: d.id,
      name: d.name,
      setName: d.set?.name ?? "",
      printed: official ? `${d.localId}/${official}` : String(d.localId),
      image: d.image ? `${d.image}/low.webp` : "",
      numOk,
      score: (numOk ? 3 : 0) + (totOk ? 3 : 0) + (nm === lower ? 2 : nm.startsWith(lower) ? 1 : 0),
    };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
}

/* -- sealed products (boxes, tins, collections...) -- */

/*
 * TCGdex only knows single cards, so sealed product comes from a snapshot the app ships with:
 * data/sealed.json, built by tools/build-sealed.mjs as [productId, groupIndex, name] rows.
 * Matching is by words: rare words ("celebration", "lucario") count far more than common ones
 * ("collection", "box"), so a photo's text only needs to contain the distinctive parts of a name.
 */

let sealedIndex = null;
function loadSealed() {
  return (sealedIndex ??= fetch("data/sealed.json")
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(buildSealedIndex)
    .catch(() => { sealedIndex = null; return null; })); // try again next time
}

const STOP_WORDS = new Set("the of and for with a an in by to pokemon tcg trading card cards game inc tm".split(" "));

function tokenize(text) {
  return String(text || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // é -> e
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

function buildSealedIndex(data) {
  const items = data.items.map(([id, gi, name]) => ({
    id, name, group: data.groups[gi][1], tokens: [...new Set(tokenize(name))],
  }));
  const df = new Map();
  for (const it of items) for (const t of it.tokens) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => Math.log(1 + items.length / (1 + (df.get(t) || 0)));
  for (const it of items) it.total = it.tokens.reduce((s, t) => s + weight(t), 0);
  return { items, weight };
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

const looksSealed = (text) =>
  /\b(box|etb|tin|collection|pack|bundle|blister|sticker|elite|trainer|display|case|deck|premium|binder|sleeves|playmat|celebration|anniversary)\b/i.test(text || "");

// Typed search: how much of what you typed does the product name cover.
// Photo search (query.ocrText): how much of the product name appears in the text read off the box.
async function searchSealed(query) {
  const idx = await loadSealed();
  if (!idx) return [];
  const ocr = !!query.ocrText;
  const qTokens = [...new Set(tokenize(ocr ? query.ocrText : query.name))];
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

  const results = scored.slice(0, ocr ? 6 : 8).map(({ it, score }) => ({
    kind: "sealed",
    id: "p" + it.id,
    name: it.name,
    setName: cleanSetName(it.group),
    printed: "",
    image: `https://tcgplayer-cdn.tcgplayer.com/product/${it.id}_200w.jpg`,
    type: guessSealedType(it.name),
    score,
    strong: false,
  }));
  // Only treat a photo match as certain when it's a near-complete, distinctive name with a clear lead.
  if (ocr && scored.length) {
    const [top, next] = scored;
    results[0].strong = top.score >= 0.8 && top.matched >= 5 && (!next || top.score - next.score >= 0.08);
  }
  return results;
}

/* -- parsing what was typed / how results are shown and applied -- */

function parseQuery(text) {
  const t = text.trim();
  let m = t.match(/^(.*\S)\s+([A-Za-z]{0,3}\d{1,3})\s*\/\s*([A-Za-z]{0,3}\d{2,3})$/); // "charizard 4/102"
  if (m) return { name: m[1], number: m[2], total: m[3], raw: t };
  m = t.match(/^(.*\S)\s+(\d{1,3})$/);                                                 // "charizard 4"
  return m ? { name: m[1], number: m[2], raw: t } : { name: t, raw: t };
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
        <b>${esc(c.name)}${c.kind === "sealed" ? ' <em class="tag">Sealed</em>' : ""}</b>
        <span>${esc([c.setName, c.printed && "#" + c.printed].filter(Boolean).join(" · "))}</span>
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
  put("type", card.kind === "sealed" ? card.type : "Single card");
  // the official picture is only a stand-in until they add their own photo
  if (card.image && (!photoData || photoIsOfficial)) {
    photoData = card.image;
    photoIsOfficial = true;
    renderPhoto();
  }
  pickedId = card.id;
  renderResults();
}

async function lookup(query, token, auto) {
  setStatus(`Looking up “${query.name || "the photo"}”…`);
  let sealed = [], cards = [], cardsFailed = false;

  if (!query.skipSealed) sealed = await searchSealed(query).catch(() => []); // local, so works offline
  if (token !== lookupToken) return;

  const sealedStrong = !!sealed[0]?.strong;
  if (query.name && !sealedStrong) {
    try {
      cards = await searchCards(query);
    } catch {
      cardsFailed = true;
    }
    if (token !== lookupToken) return;
  }

  const sealedFirst = query.ocrText ? sealedStrong : looksSealed(query.raw || query.name);
  found = sealedFirst ? [...sealed, ...cards] : [...cards, ...sealed.slice(0, 5)];
  pickedId = "";

  if (!found.length) {
    renderResults();
    setStatus(cardsFailed
      ? "Couldn't reach the card database. Check your connection, or fill in the details yourself."
      : query.ocrText
        ? "Couldn't tell what that is from the photo. Type its name in Find card, or try a straighter, brighter photo."
        : `Nothing found for “${query.name}”. Try fewer words.`);
    return;
  }

  const bestCard = cards[0];
  const pick = sealedStrong ? sealed[0]
    : bestCard && (bestCard.numOk || (cards.length === 1 && !sealed.length)) ? bestCard : null;
  if (auto && pick) {
    applyCard(pick, false);
    if (pick.kind === "sealed") $("cardSearch").value = pick.name; // replace any junk words read off the box
    setStatus(`Filled in from the photo: ${describe(pick)}. Wrong one? Pick another below.`, true);
  } else {
    renderResults();
    setStatus(auto
      ? "I read the photo but wasn't sure what it is. Pick the match below, or type a name in Find card."
      : "Pick the match below.");
  }
}

async function identify(canvas, token) {
  setStatus("Getting the text reader ready… (first time only, this can take a minute)");
  let text;
  try {
    text = await readCardText(canvas, (m) => {
      if (token === lookupToken && m.status === "recognizing text") {
        setStatus(`Reading the photo… ${Math.round((m.progress || 0) * 100)}%`);
      }
    });
  } catch {
    if (token === lookupToken) setStatus("Couldn't run the text reader (it needs an internet connection). Type the name in Find card instead.");
    return;
  }
  if (token !== lookupToken) return;

  const name = guessName(text.top) || guessName(text.full);
  const num = guessNumber(text.bottom) || guessNumber(text.full) || guessNumber(text.top);

  if (name && num) { // a card: name plus the printed set number
    $("cardSearch").value = `${name} ${num.local}/${num.total}`;
    await lookup({ name, number: num.local, total: num.total, raw: name, skipSealed: true }, token, true);
    return;
  }
  // No card number, so it may be sealed (box, tin, collection...): match the words on it against known products.
  $("cardSearch").value = name;
  await lookup({ name, raw: name, ocrText: [text.top, text.bottom, text.full].join("\n") }, token, true);
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
  lookup(parseQuery(text), ++lookupToken, false);
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
  setStatus(`Filled in: ${card.name} · ${card.setName} · #${card.printed}`, true);
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
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => { ui.tab = t.dataset.tab; renderTable(); }));

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
