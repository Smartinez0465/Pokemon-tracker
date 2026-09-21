// Builds data/sealed.json: every sealed (non-card) Pokémon TCG product, with its current market price,
// as [productId, groupIndex, name, price] rows, from TCGCSV.
//
// TCGCSV (https://tcgcsv.com) is a free daily mirror of TCGplayer's catalog. It doesn't allow
// browsers to read it directly (no CORS), so we snapshot the sealed products and their prices here,
// ship the file with the app, and refresh it on a schedule (see .github/workflows/update-sealed.yml).
//
// Run: node tools/build-sealed.mjs
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://tcgcsv.com/tcgplayer/3"; // category 3 = Pokémon
const HEADERS = { "User-Agent": "CardLedger/1.0 (+https://github.com/Smartinez0465/Pokemon-tracker)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (attempt === 4) throw err;
    }
    await sleep(1000 * attempt);
  }
  throw new Error(`gave up on ${url}`);
}

const groups = (await get(`${BASE}/groups`)).results ?? [];
// newest sets first, so ties in a search favour recent products
groups.sort((a, b) => String(b.publishedOn).localeCompare(String(a.publishedOn)));

const outGroups = [];
const items = [];
for (const g of groups) {
  const products = (await get(`${BASE}/${g.groupId}/products`)).results ?? [];
  // single cards carry a "Number" field; anything without one is sealed product (boxes, tins, packs...)
  // ("Code Card" entries are digital game codes, not something you'd hold in a box)
  const sealed = products.filter((p) =>
    !(p.extendedData ?? []).some((e) => e.name === "Number") && !/^code card\b/i.test(p.name));
  if (sealed.length) {
    // TCGplayer's market price (what it's really selling for lately), in USD; null when it has none
    const prices = new Map();
    for (const r of (await get(`${BASE}/${g.groupId}/prices`)).results ?? []) {
      const price = r.marketPrice ?? r.midPrice;
      if (price != null && !prices.has(r.productId)) prices.set(r.productId, price);
    }
    const gi = outGroups.push([g.groupId, g.name]) - 1;
    for (const p of sealed) items.push([p.productId, gi, p.name, prices.get(p.productId) ?? null]);
  }
  await sleep(120); // be gentle with a free service
}

if (items.length < 500) throw new Error(`only ${items.length} products found, refusing to overwrite the data file`);

await mkdir("data", { recursive: true });
// the date sits on its own line so the weekly refresh can tell "only the date changed" from "new products"
const date = new Date().toISOString().slice(0, 10);
const json = `{\n"generated":"${date}",\n"groups":${JSON.stringify(outGroups)},\n"items":${JSON.stringify(items)}\n}\n`;
await writeFile("data/sealed.json", json);
console.log(`wrote data/sealed.json: ${items.length} sealed products in ${outGroups.length} sets (${Math.round(json.length / 1024)} KB)`);
