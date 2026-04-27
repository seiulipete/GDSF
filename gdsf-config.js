// ── GDSF CHECK-IN: KONFIGURATION ─────────────────────────────────────────────
// Diese Datei einfach bearbeiten um Supabase-URL und Key zu ändern.

const SUPABASE_URL = 'https://xdgufsqaplekmxuiubhu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkZ3Vmc3FhcGxla214dWl1Ymh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NTIzNjcsImV4cCI6MjA5MjQyODM2N30.SDA1FaWNT-jHPepYBtEYG62VqTvimvO8kmqUV24BNsI';

// Supabase SQL-Setup (einmalig ausführen wenn noch nicht vorhanden):
// ALTER TABLE events ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
