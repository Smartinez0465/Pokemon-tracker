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

It works for **sealed product** too (boxes, ETBs, tins, collections, blisters...). Sealed items have no card
number, so the app matches the words on the package against a list of known products
(`data/sealed.json`) and fills in the name, set and type.

If it can't read the photo, type a name into **Find card or sealed product** and pick the match, e.g.
`charizard 4/102` or `30th celebration tech sticker collection`.

Card data comes from TCGdex. The sealed list is a snapshot of [TCGCSV](https://tcgcsv.com) (a free mirror of TCGplayer's
catalog), built by `node tools/build-sealed.mjs`. TCGCSV doesn't allow browsers to read it directly, which is why it's
a bundled file. A GitHub Action (`.github/workflows/update-sealed.yml`) refreshes it every Monday so new sets show up;
you can also run it by hand from the repo's **Actions** tab.
Anything you typed yourself is never overwritten by auto-fill. The bought date defaults to today and can be changed.

Only the words read from the card are sent to TCGdex; the photo itself stays in your browser.
Both steps need an internet connection. Without one you can still add items by hand.

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
