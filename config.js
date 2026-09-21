// Cloud sync settings. Leave both empty and the app works exactly as before, just without sync.
//
// To turn sync on, create a free Supabase project (see README, "Sync your phone and computer"),
// then paste its Project URL and its "anon" / publishable key here.
// These two values are meant to be public: the database only lets each signed-in user
// see their own items (Row Level Security in supabase/setup.sql).
window.CARD_LEDGER = {
  supabaseUrl: "https://voftijoqfysmfxrprphe.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvZnRpam9xZnlzbWZ4cnBycGhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NDE4ODAsImV4cCI6MjEwNTUxNzg4MH0.AbfyfZbSIEroiIftRmbEwri8-z2TTf3Vj2Nb8J253T4",   // anon key: public by design
};
