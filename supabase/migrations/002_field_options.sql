-- Canonical field options lookup table
-- Run in Supabase Dashboard -> SQL Editor (after 001)

CREATE TABLE IF NOT EXISTS field_options (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  field_name    TEXT NOT NULL,
  value         TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT uq_field_option UNIQUE (field_name, value),
  CONSTRAINT valid_field_name CHECK (field_name IN ('indicator', 'species', 'brain_region'))
);

ALTER TABLE field_options ENABLE ROW LEVEL SECURITY;

-- Public read (anon + authenticated), only service_role (Dashboard) can write
CREATE POLICY "Public read access"
  ON field_options FOR SELECT TO anon, authenticated USING (true);

CREATE INDEX idx_field_options_field ON field_options (field_name, display_order);
