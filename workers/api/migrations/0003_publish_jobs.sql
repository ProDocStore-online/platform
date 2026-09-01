-- Durable publish registry for GitHub-backed knowledge-base publishing.
-- This is the bridge from today's client-hosted GitHub Actions path to
-- webhook-driven and later PDocs-managed publishing.

CREATE TABLE IF NOT EXISTS publish_targets (
  id                TEXT PRIMARY KEY,
  kb_id             TEXT REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  local_draft_id    TEXT,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL DEFAULT 'github',
  mode              TEXT NOT NULL DEFAULT 'client-hosted',
  github_owner      TEXT NOT NULL,
  github_repo       TEXT NOT NULL,
  github_full_name  TEXT NOT NULL,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  visibility        TEXT NOT NULL DEFAULT 'private',
  live_url          TEXT NOT NULL,
  actions_url       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (provider, github_full_name)
);
CREATE INDEX IF NOT EXISTS idx_publish_targets_user ON publish_targets(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_publish_targets_draft ON publish_targets(user_id, local_draft_id);
CREATE INDEX IF NOT EXISTS idx_publish_targets_kb ON publish_targets(kb_id);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id                 TEXT PRIMARY KEY,
  target_id          TEXT NOT NULL REFERENCES publish_targets(id) ON DELETE CASCADE,
  kb_id              TEXT REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  user_id            TEXT NOT NULL REFERENCES users(id),
  source             TEXT NOT NULL DEFAULT 'api',
  trigger            TEXT NOT NULL DEFAULT 'console',
  status             TEXT NOT NULL DEFAULT 'submitted',
  github_full_name   TEXT NOT NULL,
  github_branch      TEXT NOT NULL DEFAULT 'main',
  github_commit_sha  TEXT NOT NULL,
  github_commit_url  TEXT NOT NULL,
  live_url           TEXT NOT NULL,
  actions_url        TEXT NOT NULL,
  message            TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_target_time ON publish_jobs(target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_user_time ON publish_jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status, created_at);
