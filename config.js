// Cloud sync settings. Leave both empty and the app works exactly as before, just without sync.
//
// To turn sync on, create a free Supabase project (see README, "Sync your phone and computer"),
// then paste its Project URL and its "anon" / publishable key here.
// These two values are meant to be public: the database only lets each signed-in user
// see their own items (Row Level Security in supabase/setup.sql).
window.CARD_LEDGER = {
  supabaseUrl: "",   // e.g. "https://abcdefghijkl.supabase.co"
  supabaseKey: "",   // the anon / publishable key
};
