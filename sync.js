"use strict";

/*
 * Optional cloud sync between devices, using a Supabase project (see supabase/setup.sql and the README).
 *
 * The app always reads and writes the copy stored on the device, so it works offline. This file
 * signs the person in and, in the background, merges that local copy with the cloud copy.
 *
 * How the merge works
 *  - Every item has `updatedAt`. Deleting an item leaves a tombstone { id, updatedAt } (see app.js).
 *  - meta.versions[id] is the updatedAt both sides last agreed on; anything newer locally is "unsent".
 *  - meta.cursor is the newest cloud change already seen, so each sync only downloads what's new.
 *  - The newest edit to an item wins. If two devices changed the same item before syncing, their sales
 *    are combined rather than one side's being lost.
 *
 * It relies on app.js globals: items, tombstones, saveItems, normalizeItem, render, $.
 */
(() => {
  const cfg = window.CARD_LEDGER || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey);
  window.ledgerSync = null;
  if (!enabled) return; // no project configured: the account button stays hidden and the app is local-only

  const base = cfg.supabaseUrl.replace(/\/+$/, "");
  const key = cfg.supabaseKey;
  const SESSION_KEY = "card-ledger-session";
  const META_KEY = "card-ledger-sync";
  const el = (id) => document.getElementById(id);

  const readJson = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  };
  const writeJson = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full: the next save will complain */ }
  };

  let session = readJson(SESSION_KEY, null);                                 // { access_token, refresh_token, expires_at, email }
  let meta = { cursor: "", versions: {}, owner: "", ...readJson(META_KEY, {}) }; // see header comment
  let state = "idle";     // idle | syncing | synced | offline | error
  let lastSynced = 0;
  let lastError = "";
  let syncing = false;
  let again = false;
  let debounce;

  const saveMeta = () => writeJson(META_KEY, meta);

  /* ---------- auth (Supabase GoTrue over plain fetch) ---------- */

  function friendly(json, status) {
    const m = String(json.msg || json.error_description || json.message || json.error || "");
    if (/invalid login credentials/i.test(m)) return "That email and password don't match.";
    if (/already (been )?registered|already exists/i.test(m)) return "That email already has an account. Try signing in.";
    if (/at least \d+ characters|weak/i.test(m)) return "Choose a longer password (at least 6 characters).";
    if (/sign.?ups? (are )?(not allowed|disabled)|not allowed for this/i.test(m)) return "New accounts are turned off for this app.";
    if (/not confirmed/i.test(m)) return "Confirm your email first (check your inbox), then sign in.";
    if (/rate limit|too many|security purposes/i.test(m)) return "Too many tries. Wait a minute and try again.";
    return m || `Something went wrong (${status}).`;
  }

  async function authCall(path, body, { method = "POST", token = "" } = {}) {
    let res;
    try {
      res = await fetch(`${base}/auth/v1/${path}`, {
        method,
        headers: { apikey: key, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error("Can't reach the server. Check your connection."), { offline: true });
    }
    let json = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw Object.assign(new Error(friendly(json, res.status)), { status: res.status });
    return json;
  }

  function setSession(json, email) {
    session = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
      email: (json.user?.email || email || session?.email || "").toLowerCase(),
    };
    writeJson(SESSION_KEY, session);
  }

  async function refreshSession() {
    if (!session?.refresh_token) throw Object.assign(new Error("Signed out."), { status: 401 });
    const json = await authCall("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    setSession(json);
  }

  async function freshToken() {
    if (!session) throw Object.assign(new Error("Signed out."), { status: 401 });
    if (session.expires_at - 60 < Date.now() / 1000) await refreshSession();
    return session.access_token;
  }

  function dropSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  /* ---------- cloud table (Supabase PostgREST over plain fetch) ---------- */

  async function rest(method, path, body, headers = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await freshToken();
      let res;
      try {
        res = await fetch(`${base}/rest/v1/${path}`, {
          method,
          headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw Object.assign(new Error("offline"), { offline: true });
      }
      if (res.status === 401 && attempt === 0) { session.expires_at = 0; continue; } // token rejected: refresh once and retry
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (/ledger_items/.test(text) && (res.status === 404 || /PGRST205|does not exist/.test(text))) {
          throw new Error("The cloud table isn't set up yet. Run supabase/setup.sql in your Supabase project.");
        }
        throw new Error(`Sync failed (${res.status}). ${text.slice(0, 160)}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    throw new Error("Sync failed: not authorised. Sign in again.");
  }

  /* ---------- merging ---------- */

  const unionSales = (a = [], b = []) => {
    const byId = new Map();
    for (const s of [...b, ...a]) byId.set(s.id, s); // if both have it, keep this device's copy
    return [...byId.values()];
  };

  // Fold cloud changes into the local copy. Returns true if anything local changed.
  function mergeRemote(rows) {
    let changed = false;
    for (const r of rows) {
      const rv = Number(r.updated_at) || 0;
      const base0 = meta.versions[r.id] ?? -1;
      if (rv <= base0) continue; // already known, e.g. our own upload coming back

      const localItem = items.find((i) => i.id === r.id);
      const localTomb = tombstones.find((t) => t.id === r.id);
      const lv = localItem ? localItem.updatedAt || 0 : localTomb ? localTomb.updatedAt : -1;
      const localDirty = (localItem || localTomb) && lv > base0; // changed here since we last agreed
      const remoteItem = r.deleted ? null : normalizeItem({ ...(r.data || {}), id: r.id, updatedAt: rv });

      const takeRemote = () => {
        items = items.filter((i) => i.id !== r.id);
        tombstones = tombstones.filter((t) => t.id !== r.id);
        if (remoteItem) items.push(remoteItem);
        else tombstones.push({ id: r.id, updatedAt: rv });
        changed = true;
      };

      if (!localDirty) {
        takeRemote();
      } else if (!remoteItem || !localItem) {
        if (rv >= lv) takeRemote(); // a delete on one side vs an edit on the other: the newer one wins
        // else keep ours, and it gets uploaded below
      } else {
        // both sides edited it: newest fields win, but keep every sale from both
        const newer = rv >= lv ? remoteItem : localItem;
        const merged = { ...newer, sales: unionSales(localItem.sales, remoteItem.sales), updatedAt: Date.now() };
        items = items.map((i) => (i.id === r.id ? merged : i));
        changed = true;
      }
      meta.versions[r.id] = rv;
    }
    return changed;
  }

  const unsentRows = () => {
    const rows = [];
    for (const it of items) {
      if ((it.updatedAt || 0) > (meta.versions[it.id] ?? -1)) {
        const { id, updatedAt, ...data } = it;
        rows.push({ id, data, updated_at: updatedAt, deleted: false });
      }
    }
    for (const t of tombstones) {
      if (t.updatedAt > (meta.versions[t.id] ?? -1)) rows.push({ id: t.id, data: {}, updated_at: t.updatedAt, deleted: true });
    }
    return rows;
  };

  async function pullAll() {
    const rows = [];
    let cursor = meta.cursor;
    for (;;) {
      const q = "ledger_items?select=id,data,updated_at,deleted,synced_at&order=synced_at.asc&limit=200"
        + (cursor ? `&synced_at=gt.${encodeURIComponent(cursor)}` : "");
      const page = (await rest("GET", q)) || [];
      rows.push(...page);
      if (page.length) cursor = page[page.length - 1].synced_at;
      if (page.length < 200) break;
    }
    return { rows, cursor };
  }

  async function pushAll() {
    const rows = unsentRows();
    for (let i = 0; i < rows.length; i += 15) {
      const batch = rows.slice(i, i + 15);
      await rest("POST", "ledger_items?on_conflict=id", batch, { Prefer: "resolution=merge-duplicates,return=minimal" });
      for (const r of batch) meta.versions[r.id] = Math.max(meta.versions[r.id] ?? -1, r.updated_at);
      saveMeta();
    }
    return rows.length;
  }

  async function syncNow() {
    if (!session) return;
    if (syncing) { again = true; return; }
    syncing = true;
    setState("syncing");
    try {
      // items from before sync existed have no timestamp yet
      let stamped = false;
      for (const it of items) if (!it.updatedAt) { it.updatedAt = Date.now(); stamped = true; }
      if (stamped) saveItems({ quiet: true });

      const { rows, cursor } = await pullAll();
      if (mergeRemote(rows)) { saveItems({ quiet: true }); render(); }
      meta.cursor = cursor;
      saveMeta();

      await pushAll();
      lastSynced = Date.now();
      lastError = "";
      setState("synced");
    } catch (err) {
      if (err.offline) { lastError = ""; setState("offline"); }
      else if (err.status === 401 || err.status === 400) {
        // the saved sign-in is no longer valid (password changed, or signed out elsewhere)
        dropSession();
        lastError = "Your sign-in expired. Please sign in again.";
        setState("idle");
      } else {
        lastError = err.message || "Sync failed.";
        setState("error");
      }
    } finally {
      syncing = false;
      if (again) { again = false; syncNow(); }
    }
  }

  const hasUnsent = () => unsentRows().length > 0;

  /* ---------- sign in / out ---------- */

  function wipeLocal() {
    items = [];
    tombstones = [];
    meta = { cursor: "", versions: {}, owner: "" };
    saveMeta();
    saveItems({ quiet: true });
    render();
  }

  // Called after any successful sign-in or sign-up.
  function startSession(email) {
    email = email.toLowerCase();
    if (meta.owner && meta.owner !== email && (items.length || tombstones.length)) {
      if (!confirm(`This device still has items from ${meta.owner}. Signing in as ${email} will remove them from this device (they stay in that account). Continue?`)) {
        dropSession();
        return false;
      }
      wipeLocal();
    }
    meta.owner = email;
    saveMeta();
    syncNow();
    return true;
  }

  async function doSignIn(email, password) {
    const json = await authCall("token?grant_type=password", { email, password });
    setSession(json, email);
    return startSession(email);
  }

  async function doSignUp(email, password) {
    const json = await authCall("signup", { email, password });
    if (!json.access_token) return "confirm"; // the project wants the email confirmed first
    setSession(json, email);
    return startSession(email) ? "ok" : "cancelled";
  }

  async function doSignOut() {
    if (!confirm("Sign out? This removes your items from this device. They stay safe in your account and come back when you sign in again.")) return false;
    await syncNow();
    while (syncing) await new Promise((r) => setTimeout(r, 100));
    if (hasUnsent() && !confirm("Some recent changes haven't reached the cloud yet, and signing out now would lose them. Sign out anyway?")) return false;
    try { await authCall("logout", {}, { token: session.access_token }); } catch { /* signing out locally is what matters */ }
    dropSession();
    wipeLocal();
    setState("idle");
    return true;
  }

  /* ---------- account UI ---------- */

  const authDialog = el("authDialog");

  function setState(s) {
    state = s;
    renderAccount();
  }

  const timeText = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function statusText() {
    if (state === "syncing") return "Syncing…";
    if (state === "offline") return "You're offline. Changes are saved here and will sync when you're back online.";
    if (state === "error") return lastError || "Sync failed.";
    return lastSynced ? `Up to date. Last synced at ${timeText(lastSynced)}.` : "Not synced yet.";
  }

  function renderAccount() {
    const btn = el("accountBtn");
    btn.hidden = false;
    btn.dataset.state = session ? state : "idle";
    btn.textContent = !session ? "Sign in to sync"
      : state === "syncing" ? "Syncing…"
      : state === "offline" ? "Offline"
      : state === "error" ? "Sync problem"
      : "Synced";
    if (authDialog.open) showView();
  }

  let resetMode = false;
  function showView() {
    el("authOut").hidden = !!session || resetMode;
    el("authIn").hidden = !session || resetMode;
    el("authReset").hidden = !resetMode;
    if (session) {
      el("authWho").textContent = session.email;
      el("authStatus").textContent = statusText();
      const msg = el("authInMsg");
      msg.hidden = !(state === "error" && lastError);
      msg.textContent = lastError;
    }
  }

  function openAccount() {
    showView();
    el("authMsg").hidden = true;
    if (!authDialog.open) authDialog.showModal();
  }

  function say(id, text) {
    const p = el(id);
    p.textContent = text;
    p.hidden = !text;
  }

  // run an action with the dialog's buttons disabled so it can't be double-tapped
  async function busy(fn) {
    const buttons = [...authDialog.querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    try { return await fn(); } finally { buttons.forEach((b) => (b.disabled = false)); }
  }

  function credentials() {
    return { email: el("authEmail").value.trim(), password: el("authPass").value };
  }

  el("accountBtn").addEventListener("click", openAccount);

  el("authForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (resetMode) return el("authSaveNew").click();
    const { email, password } = credentials();
    if (!email || password.length < 6) return say("authMsg", "Enter your email and a password of at least 6 characters.");
    busy(async () => {
      say("authMsg", "");
      try {
        if (await doSignIn(email, password)) { el("authPass").value = ""; showView(); }
      } catch (err) { say("authMsg", err.message); }
    });
  });

  el("authSignUp").addEventListener("click", () => {
    const { email, password } = credentials();
    if (!email || password.length < 6) return say("authMsg", "Enter your email and choose a password of at least 6 characters.");
    busy(async () => {
      say("authMsg", "");
      try {
        const result = await doSignUp(email, password);
        if (result === "confirm") say("authMsg", "Almost there: we emailed you a link. Open it to confirm, then come back and sign in.");
        else { el("authPass").value = ""; showView(); }
      } catch (err) { say("authMsg", err.message); }
    });
  });

  el("authForgot").addEventListener("click", () => {
    const { email } = credentials();
    if (!email) return say("authMsg", "Type your email above first, then tap Forgot password.");
    busy(async () => {
      try {
        await authCall(`recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { email });
        say("authMsg", "If that email has an account, a reset link is on its way. Open it on this device.");
      } catch (err) { say("authMsg", err.message); }
    });
  });

  el("authSyncNow").addEventListener("click", () => syncNow());

  el("authSignOut").addEventListener("click", () => {
    busy(async () => {
      if (await doSignOut()) authDialog.close();
    });
  });

  el("authSaveNew").addEventListener("click", () => {
    const password = el("authNewPass").value;
    if (password.length < 6) return say("authResetMsg", "Choose a password of at least 6 characters.");
    busy(async () => {
      try {
        await authCall("user", { password }, { method: "PUT", token: await freshToken() });
        resetMode = false;
        el("authNewPass").value = "";
        say("authResetMsg", "");
        if (startSession(session.email)) showView();
      } catch (err) { say("authResetMsg", err.message); }
    });
  });

  /* ---------- when to sync ---------- */

  window.ledgerSync = {
    // app.js calls this after every local change
    changed() {
      if (!session) return;
      clearTimeout(debounce);
      debounce = setTimeout(syncNow, 1500);
    },
    now: syncNow, // "Sync now" button, and handy for tests
  };

  const syncIfVisible = () => { if (session && document.visibilityState === "visible") syncNow(); };
  document.addEventListener("visibilitychange", syncIfVisible);
  window.addEventListener("online", syncIfVisible);
  window.addEventListener("focus", syncIfVisible);
  setInterval(syncIfVisible, 60000);

  // Links from Supabase emails (password reset, email confirmation) come back to this page with the
  // session in the URL hash.
  async function handleEmailLink() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!h.get("access_token") && !h.get("error")) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (h.get("error")) {
      openAccount();
      return say("authMsg", h.get("error_description")?.replace(/\+/g, " ") || "That link didn't work. Ask for a new one.");
    }
    try {
      const token = h.get("access_token");
      const user = await authCall("user", null, { method: "GET", token });
      setSession({ access_token: token, refresh_token: h.get("refresh_token"), expires_in: Number(h.get("expires_in")) || 3600, user }, user.email);
      if (h.get("type") === "recovery") { resetMode = true; openAccount(); }
      else { startSession(user.email); openAccount(); }
    } catch (err) {
      openAccount();
      say("authMsg", err.message);
    }
  }

  renderAccount();
  handleEmailLink();
  if (session) syncNow();
})();
