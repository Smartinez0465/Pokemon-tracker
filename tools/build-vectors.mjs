// Builds data/sealed-vec.json + data/sealed-vec.bin: a visual "fingerprint" of every sealed product's box art,
// so the app can recognise a product from a photo by comparing pictures instead of reading (often stylised) text.
//
// Each product image (TCGplayer's) goes through a small vision model (DINOv2-small) and becomes 384 numbers,
// stored as 8-bit integers (~1.3 MB for all ~3,500 products). The app runs the same model on the photo in the
// browser and finds the closest fingerprints. Rows for products that already have one are reused, so a daily
// run only processes new products.
//
// Setup once:   npm install        (installs sharp and @huggingface/transformers, dev-only, not shipped)
// Run:          node tools/build-vectors.mjs          (--need just reports whether there is work to do)
//
// The way an image is prepared here (square, gray padding, no stretching) must match toSquareCanvas() in app.js.
import fs from "node:fs";

const MODEL = "Xenova/dinov2-small";
const DTYPE = "uint8"; // the 22 MB quantised model; the browser downloads the same file
const DIM = 384;
const SCALE = 0.3;     // vectors are unit length, so every value is well inside +-0.3 (the largest seen is 0.28)
const SIZE = 224;
const JSON_FILE = "data/sealed-vec.json";
const BIN_FILE = "data/sealed-vec.bin";

const sealed = JSON.parse(fs.readFileSync("data/sealed.json", "utf8"));
const wanted = sealed.items.map((r) => r[0]);

// reuse rows from the last run
const rows = new Map();
let noPicture = new Set(); // products whose picture doesn't exist (404): not worth asking for again every day
if (fs.existsSync(JSON_FILE) && fs.existsSync(BIN_FILE)) {
  const meta = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  if (meta.model === MODEL && meta.dtype === DTYPE && meta.dim === DIM && meta.scale === SCALE) {
    const bin = fs.readFileSync(BIN_FILE);
    meta.ids.forEach((id, i) => rows.set(id, new Int8Array(bin.buffer, bin.byteOffset + i * DIM, DIM).slice()));
    noPicture = new Set(meta.noPicture ?? []);
  }
}
const todo = wanted.filter((id) => !rows.has(id) && !noPicture.has(id));
const stale = [...rows.keys()].filter((id) => !wanted.includes(id));
console.log(`${wanted.length} products, ${rows.size - stale.length} already have a fingerprint, ${todo.length} to do`);
if (process.argv.includes("--need")) process.exit(todo.length ? 0 : 1);

if (todo.length) {
  const { default: sharp } = await import("sharp");
  const { AutoModel, AutoProcessor, RawImage } = await import("@huggingface/transformers");
  const model = await AutoModel.from_pretrained(MODEL, { dtype: DTYPE });
  const processor = await AutoProcessor.from_pretrained(MODEL);
  processor.do_resize = false; // already 224 x 224
  processor.do_center_crop = false;

  const embed = async (buf) => {
    const { data, info } = await sharp(buf)
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 128, g: 128, b: 128 } })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = await model(await processor(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3)));
    const cls = out.last_hidden_state.data.slice(0, DIM); // the CLS token summarises the whole picture
    const norm = Math.sqrt(cls.reduce((s, x) => s + x * x, 0)) || 1;
    return Int8Array.from(cls, (x) => Math.max(-127, Math.min(127, Math.round((x / norm / SCALE) * 127))));
  };

  let done = 0, missing = 0;
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.pop();
      try {
        const res = await fetch(`https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`);
        // no picture on file (the CDN answers 403 or 404 for those): not matchable by photo, and not worth retrying
        if (res.status === 404 || res.status === 403) { noPicture.add(id); missing++; continue; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const picture = Buffer.from(await res.arrayBuffer());
        try {
          rows.set(id, await embed(picture));
        } catch {
          noPicture.add(id); // downloaded, but not a picture we can read (some are placeholder stubs)
          missing++;
        }
      } catch { missing++; } // a network hiccup: it is tried again next run
      if (++done % 250 === 0) console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // the model runs one image at a time; extra workers overlap downloads
  console.log(`fingerprinted ${todo.length - missing}, no picture for ${missing}`);
}

const ids = wanted.filter((id) => rows.has(id));
const bin = Buffer.alloc(ids.length * DIM);
ids.forEach((id, i) => Buffer.from(rows.get(id).buffer).copy(bin, i * DIM));
fs.writeFileSync(BIN_FILE, bin);
const noPictureIds = wanted.filter((id) => noPicture.has(id));
fs.writeFileSync(JSON_FILE, JSON.stringify({ model: MODEL, dtype: DTYPE, dim: DIM, scale: SCALE, size: SIZE, ids, noPicture: noPictureIds }) + "\n");
console.log(`wrote ${JSON_FILE} and ${BIN_FILE}: ${ids.length} fingerprints (${Math.round(bin.length / 1024)} KB)`);
