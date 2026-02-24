-- Add 'bridge' to the valid_data_source constraint
-- Bridge submissions come from the Python↔browser data exchange

ALTER TABLE catune_submissions DROP CONSTRAINT valid_data_source;
ALTER TABLE catune_submissions ADD CONSTRAINT valid_data_source
  CHECK (data_source IN ('user', 'demo', 'training', 'bridge'));
