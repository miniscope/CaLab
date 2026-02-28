-- Add 'cadecon' to the analytics_sessions app_name CHECK constraint

ALTER TABLE analytics_sessions
  DROP CONSTRAINT analytics_sessions_app_name_check;

ALTER TABLE analytics_sessions
  ADD CONSTRAINT analytics_sessions_app_name_check
  CHECK (app_name IN ('catune', 'carank', 'cadecon'));
