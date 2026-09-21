# Card Ledger

A Pokémon inventory tracker. Track what you bought, what's in inventory, what you paid, and what you sold it for.
A plain HTML/CSS/JS web app: no build step, no dependencies. It's an installable PWA,
so once it's online you can add it to your phone's home screen and it behaves like an app.

## Run it on your computer

Opening `index.html` directly works, but the "install as app" and offline features
need a web server. From this folder:

```
npx serve .
```

(or `python -m http.server 8080`), then open the address it prints.

## Put it online (free)

**GitHub Pages**: push this folder to a GitHub repo, then Settings → Pages →
"Deploy from a branch" → `main` / `(root)`. Your site will be at
`https://<username>.github.io/<repo>/`.

**Netlify / Cloudflare Pages**: drag this folder onto their dashboard, or connect the repo.
No build command; publish directory is the repo root.

The site must be served over HTTPS (all of the above are).

## Install on your phone

- **iPhone**: open the site in Safari → Share → *Add to Home Screen*.
- **Android**: open it in Chrome → menu → *Install app* / *Add to Home screen*.

## Adding items: single card or sealed

**Add item** starts by asking whether you're adding a **single card** or a **sealed product**. Nothing else shows until
you choose, and after that the search, the photo reader and the *Type* list only deal with that kind: sealed shows only
boxes, ETBs, packs, tins and collections; single card shows only cards. You can switch kind part-way through.

**Inventory** and **Sold** are split into two sections: **Sealed products**, and **Cards · opened & singles** (your stored
cards). Each heading shows how many items are in it and what they cost, and the Inventory sections also show what they're
worth when every item in that section has a price. A section only appears when it has something in it. The **All / Sealed /
Cards** switch next to the tabs shows just one of them.

## Photo + auto-fill

Tap *Take or choose photo* (on a phone this offers the camera). The photo is shrunk and saved with the item (tap a
thumbnail in the list to view it larger), and the app works out what it is. **What you chose (single card or sealed)
decides how:**

- **Sealed product: matched by how it looks.** Box art is mostly logos and artwork, which text reading can't make sense
  of, so the photo is compared with pictures instead. `data/sealed-vec.*` holds a small "fingerprint" of every product's
  official box art, and the app runs the same small vision model (DINOv2-small, about 22 MB, downloaded once from the
  [Hugging Face](https://huggingface.co/Xenova/dinov2-small) hub through jsDelivr, then cached) on your photo and picks the
  closest products. It's tried at several zoom levels, so the box doesn't have to fill the frame. A clear winner is filled
  in; otherwise you get up to 12 close matches, best guess first, and the best guess is put in the search box. **The photo
  and the search box work together:** words typed before the photo lift the products that fit them, and words typed after it
  put the matching products in order of how much they look like your photo (removing the photo forgets it). If the model
  can't download (for example you're offline the first time), it falls back to reading the words on the box.
- **Single card: found, then read.** The app finds the card in the photo, crops to it, and reads the name (top) and the set
  number (bottom, like `4/102`) on your device (Tesseract OCR, loaded from a CDN on first use). The number alone points at
  the set (card 4 of a set with 102 cards), so it's checked first against the free [TCGdex](https://tcgdex.net) database and
  the name only has to confirm it. A card is only filled in automatically when the number and name agree; otherwise the best
  matches are listed. Reading a card takes several seconds, longer on a phone.

Tips for both: a straight-on, well-lit photo with the product filling most of the frame works best, and a small tilt is
fine. Photos are never uploaded anywhere. Only the words read off a card are sent to TCGdex.

If it isn't sure, type a name into **Find card** / **Find sealed product** and pick the match, e.g. `charizard 4/102` or
`30th celebration elite trainer box`. Anything you typed yourself is never overwritten by auto-fill.

**Keeping the data fresh.** The sealed list and its prices are a snapshot of [TCGCSV](https://tcgcsv.com) (a free mirror of
TCGplayer's catalog), built by `node tools/build-sealed.mjs`; TCGCSV doesn't allow browsers to read it directly, which is why
it's a bundled file. The box-art fingerprints are built by `node tools/build-vectors.mjs` (run `npm install` once first; it
only needs to process new products, and about 250 products with no picture on file can't be matched by photo). A GitHub
Action (`.github/workflows/update-sealed.yml`) refreshes both every day; you can also run it by hand from the repo's
**Actions** tab.

Both the photo reader and the card database need an internet connection. Without one you can still add items by hand.

## Searching

Both search boxes (the one at the top of the page and **Find card / Find sealed product** in the add form) understand
shorthand and different spellings, so these all find *Pitch Black Elite Trainer Box*: `etb`, `E.T.B.`, `e-t-b`,
`elite-trainer-box`, `pitch-black etb`, `pitchblack elitetrainerbox`. Shorthand understood: `etb` (Elite Trainer Box),
`pc` (Pokemon Center), `bb` (Booster Bundle), `bbox` (Booster Box), `upc` / `spc` (Ultra / Super Premium Collection).
The top search also finds an item however you typed it in: an item saved as "30th Celebration ETB" is found by
`elite trainer box`. Names that really contain a hyphen, like *Porygon-Z*, still work with or without it.

**Suggestions appear as you type.** The word you're still typing matches anything that starts with it, so `30th st` already
lists the 30th Celebration Tech Sticker products and `pitch bl` lists Pitch Black products, without finishing the words.
Sealed suggestions start at 2 characters and update almost instantly; card and nickname suggestions work the same way
(`lillies clef`, `hops zac`, `moonb`). Put a space after the last word to say it's finished.

The set name counts when you look for a sealed product, so `black bolt poster collection` finds *Unova Poster Collection*.
Black Bolt and White Flare share some products (the "Unova ..." ones, listed under just one of the two), so those are found
under either name and labelled *Black Bolt / White Flare*.

**Finding single cards, including the special ones.** Typing in **Find card** forgives apostrophes, plurals, short forms and
small typos: `lillies clefairy` finds *Lillie's Clefairy ex*, `hops zacian` finds *Hop's Zacian ex*, `pika` finds Pikachu, and
`clefary` still finds Clefairy. Every print of the card is listed, newest set first, with its set, number and rarity, so
the special ones are visible. Add a rarity word to narrow it down:

| Type | Finds |
|---|---|
| `sir`, `special illustration rare` | Special Illustration Rare |
| `ir`, `illustration rare` | Illustration Rare |
| `hyper rare`, `hr` | Hyper Rare and Mega Hyper Rare |
| `mega hyper rare`, `mhr` | Mega Hyper Rare only |
| `alt art`, `alt` | the special art prints: Special Illustration, Illustration, Ultra and Secret Rare |
| `full art`, `rainbow`, `shiny`, `double rare`, `promo` | those rarities |

So `hops zacian sir` gives just the Special Illustration Rare, and `mega lucario ex mhr` the Mega Hyper Rare. Add a card
number too if you know it (`mew ex sir 232/091`). TCG Pocket cards (the phone game) are left out.

**Nicknames** like *bubble mew* aren't in any card database, so they live in
[`data/nicknames.json`](data/nicknames.json): each nickname points at one or more TCGdex card ids. It starts with
`bubble mew` (Paldean Fates Mew ex SIR) and `moonbreon` (Evolving Skies Umbreon VMAX alt art); add your own lines the same way.

## What your inventory is worth now

The bar above the totals estimates what the inventory in stock would sell for today, next to what you paid for it.

- **Sealed products** use TCGplayer's market price from `data/sealed.json` (refreshed daily, dated in the bar).
- **Single cards** use TCGplayer's market price from TCGdex, fetched live and kept on the device for 12 hours.
  When a card has several printings, the plain (non-holo) price is used if there is one.
- An item is priced when you **pick it from the search results** (the app remembers which product it is). Sealed items you
  typed in by hand are matched if the name is exactly a product's name. If you change the name afterwards, the link is dropped.
- **Graded cards aren't priced**: the grade changes the value a lot and there's no free source for graded prices.
- Anything that can't be priced is counted in the bar ("2 not priced") and left out of the total. To price one, tap *Edit*
  and pick it from the search results. *Refresh prices* re-fetches everything now.
- It's an estimate before fees and shipping, using the market price, not a guaranteed sale price.

## Where your data lives

Each device keeps its own copy in the browser, and the app always works from that copy, so it works offline.
Without sync turned on, your phone and computer **do not share data**: use *Backup* on one and *Restore* on the other.

## Sync your phone and computer (optional)

Sync signs you in with an email and password and keeps every device's copy in step through a free
[Supabase](https://supabase.com) project. Until you set it up, the app behaves exactly as before and the sign-in button is hidden.

1. Create a free account at supabase.com and click **New project** (any name; save the database password somewhere).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql), and click **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email" (otherwise sign-up waits for an email link).
4. **Authentication → URL Configuration**: set **Site URL** to your site's address
   (`https://smartinez0465.github.io/Pokemon-tracker/`). Password-reset emails link back to it.
5. **Project Settings → API** (or **API Keys**): copy the **Project URL** and the **anon / publishable key**, and paste them into [`config.js`](config.js).
   These two values are meant to be public. The database only lets each signed-in user see their own items.
6. Publish the site, open it on each device, tap **Sign in to sync**, and **Create account** once. Then use the same email and password everywhere.
7. Once your account exists, switch **off** *Allow new users to sign up* (Authentication → Sign In / Providers) so nobody else can register.

How it behaves
- Changes save on the device first and upload in the background. Offline edits are kept and sent when you're back online.
- If the same item is edited on two devices before they sync, the newest edit wins but **sales from both are kept**.
- Signing out removes the items from that device (they stay in your account and return when you sign in).
- Photos sync too. The free plan has plenty of room, but a very large photo library will use it up.
- Supabase's free plan pauses a project that sees no use for about a week. Your data is kept: open the dashboard and click **Restore**.

## Updating the site

Push to `main` and GitHub Pages redeploys in about a minute. If a change doesn't show up on an installed copy,
bump `CACHE` in `sw.js` (e.g. `pokemon-tracker-v8`) so devices drop their old cached files.
