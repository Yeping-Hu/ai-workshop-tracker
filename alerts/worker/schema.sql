-- D1 schema for the email-alerts satellite.
--
-- Apply with:
--   npx wrangler d1 execute aiwt-alerts --remote --file=./schema.sql
--
-- Everything is IF NOT EXISTS so re-running is safe.
--
-- Privacy note that governs this whole file: subscriber addresses live HERE and
-- nowhere else. They never enter the Git repo, a workflow log, a commit message
-- or an error string. `events` and `kv` hold workshop data only, which is why
-- they can be read by the Action and quoted in logs freely.

CREATE TABLE IF NOT EXISTS subscribers (
  email          TEXT PRIMARY KEY,            -- normalized: trim + lowercase
  nonce          TEXT NOT NULL,               -- 16 random bytes hex; rotating it revokes every token
  confirmed_at   TEXT,                        -- ISO; NULL until double opt-in completes
  suppressed_at  TEXT,                        -- ISO; set on hard bounce / spam complaint; never mail while set
  conferences    TEXT NOT NULL DEFAULT '[]',  -- JSON array of conference ids (data/conferences.yml); [] = all
  topics         TEXT NOT NULL DEFAULT '[]',  -- JSON array of topic ids (data/topics.yml); [] = all
  starred_ws     TEXT NOT NULL DEFAULT '[]',  -- JSON array of workshop slugs
  starred_papers TEXT NOT NULL DEFAULT '[]',  -- JSON array of {id,title,ws,wsName,pdf?} (favorites.js shape)
  cadence        TEXT NOT NULL DEFAULT 'weekly',  -- 'weekly' | 'weekly_urgent' | 'off'
  created        TEXT NOT NULL,
  updated        TEXT NOT NULL
);

-- The weekly pass reads confirmed, non-suppressed, non-paused rows.
CREATE INDEX IF NOT EXISTS subscribers_mailable ON subscribers(confirmed_at, suppressed_at, cadence);

-- Append-only observation log of dataset changes (NO PII). Powers the weekly
-- digest ("what changed in the last 7 days") and, later, a public /changelog
-- page rendered from the same table (docs/plans/email-alerts.md §12).
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  observed TEXT NOT NULL,          -- ISO date of the daily run that saw it
  slug     TEXT NOT NULL,
  kind     TEXT NOT NULL,          -- 'announced' | 'deadline_announced' | 'extended' | 'earlier'
  old_utc  TEXT,
  new_utc  TEXT,
  days     INTEGER                 -- max(1, round(|delta|/86400000)); NULL for 'announced'
);
CREATE INDEX IF NOT EXISTS events_observed ON events(observed);

-- One row per urgent alert actually sent. Keyed on the deadline VALUE, so an
-- extension re-arms the alert for the new date while a re-run on the same day
-- is a no-op.
CREATE TABLE IF NOT EXISTS urgent_log (
  email        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  deadline_utc TEXT NOT NULL,
  sent         TEXT NOT NULL,
  PRIMARY KEY (email, slug, deadline_utc)
);

-- Small key/value store. Currently holds exactly one row: 'snapshot', the
-- previous run's workshop projection (~60 KB of JSON).
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Rate-limit buckets. `bucket` is e.g. 'sub:<sha256(ip+salt)>:<hour>' or
-- 'magic:<email>:<hour>'; `reset` is an epoch-seconds expiry. Only hashed IPs
-- are stored, and the daily maintenance call deletes expired rows.
CREATE TABLE IF NOT EXISTS rl (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rl_reset ON rl(reset);
