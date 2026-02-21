-- Analytics tables for usage tracking
-- Two tables: analytics_sessions (one per browser session) and
-- analytics_events (high-level actions within a session).

-- Sessions table: one row per browser session
CREATE TABLE analytics_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  anonymous_id TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  app_name TEXT NOT NULL CHECK (app_name IN ('catune', 'carank')),
  app_version TEXT,
  country_code TEXT,
  region TEXT,
  screen_width INTEGER,
  screen_height INTEGER,
  user_agent_family TEXT,
  referrer_domain TEXT,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER
);

-- Events table: high-level actions within a session
CREATE TABLE analytics_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id UUID NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'file_imported',
    'demo_loaded',
    'parameters_submitted',
    'snapshot_pinned',
    'community_browser_opened',
    'submission_created',
    'ranking_completed',
    'tutorial_started',
    'tutorial_completed',
    'auth_signed_in',
    'auth_signed_out'
  )),
  event_data JSONB NOT NULL DEFAULT '{}'
);

-- Indexes: sessions
CREATE INDEX idx_sessions_app_name ON analytics_sessions(app_name);
CREATE INDEX idx_sessions_created_at ON analytics_sessions(created_at);
CREATE INDEX idx_sessions_country_code ON analytics_sessions(country_code);
CREATE INDEX idx_sessions_user_id ON analytics_sessions(user_id);

-- Indexes: events
CREATE INDEX idx_events_session_id ON analytics_events(session_id);
CREATE INDEX idx_events_event_name ON analytics_events(event_name);
CREATE INDEX idx_events_created_at ON analytics_events(created_at);

-- RLS
ALTER TABLE analytics_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- INSERT: anyone can create sessions and events (anonymous tracking)
CREATE POLICY "Anyone can insert sessions"
  ON analytics_sessions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can insert events"
  ON analytics_events FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- UPDATE on sessions: for setting ended_at on session end
CREATE POLICY "Anyone can update session end"
  ON analytics_sessions FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- SELECT: admin only
CREATE POLICY "Admins can read sessions"
  ON analytics_sessions FOR SELECT
  TO authenticated
  USING (auth.jwt()->'app_metadata'->>'role' = 'admin');

CREATE POLICY "Admins can read events"
  ON analytics_events FOR SELECT
  TO authenticated
  USING (auth.jwt()->'app_metadata'->>'role' = 'admin');

-- No DELETE policies: append-only analytics
