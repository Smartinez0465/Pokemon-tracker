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

## Photo + auto-fill

In **Add item**, tap *Take or choose photo* (on a phone this offers the camera). The app:

1. shrinks the photo and saves it with the item (tap a thumbnail in the list to view it larger),
2. reads the card name and number **on your device** (Tesseract OCR, loaded from a CDN on first use),
3. looks that up in the free [TCGdex](https://tcgdex.net) database and fills in name, set, card number and type.

If it can't read the card, type a name (and optionally the number, e.g. `charizard 4/102`) into **Find card** and pick the match.
Anything you typed yourself is never overwritten by auto-fill. The bought date defaults to today and can be changed.

Only the words read from the card are sent to TCGdex; the photo itself stays in your browser.
Both steps need an internet connection. Without one you can still add items by hand.

## Where your data lives

Data is saved in the browser on each device, so **your phone and computer do not share
data yet**. Use *Backup (JSON)* on one and *Restore backup* on the other to move it.
Syncing across devices needs a small backend (e.g. Supabase or Firebase) and a login.

## Updating the site

After changing files, bump `CACHE` in `sw.js` (e.g. `pokemon-tracker-v2`) so
installed copies pick up the new version.
