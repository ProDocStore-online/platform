-- Versioned artifacts for ProDocStore-managed publishing.
--
-- Before this, a managed publish recorded a job and then served whatever was
-- currently in `pages` — so every draft edit went live immediately and there
-- was nothing to roll back to. A publish now snapshots the KB's pages into an
-- immutable version, and `publish_pointers` decides which version is served.
--
-- Rollback is therefore a pointer change: no content is copied, rewritten, or
-- deleted. Page content is stored inline here for the same reason as in
-- 0001_init.sql — large assets move to R2 later.

-- One immutable snapshot of a KB, addressed by a per-KB monotonic version number.
CREATE TABLE IF NOT EXISTS publish_versions (
  id          TEXT PRIMARY KEY,            -- uuid
  kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,            -- 1, 2, 3 … within the KB
  target_id   TEXT REFERENCES publish_targets(id) ON DELETE SET NULL,
  job_id      TEXT REFERENCES publish_jobs(id) ON DELETE SET NULL,
  page_count  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (kb_id, version)
);
CREATE INDEX IF NOT EXISTS idx_publish_versions_kb ON publish_versions(kb_id, version);

-- The artifact itself: the rendered-source state of every page at publish time.
CREATE TABLE IF NOT EXISTS publish_version_pages (
  version_id  TEXT NOT NULL REFERENCES publish_versions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  title       TEXT,
  content     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, path)
);

-- Exactly one live version per KB. Publishing and rollback both write here, and
-- publishing writes it in the same D1 batch as the snapshot so the deployed
-- version is recorded atomically.
CREATE TABLE IF NOT EXISTS publish_pointers (
  kb_id       TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES publish_versions(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  updated_by  TEXT NOT NULL REFERENCES users(id),
  updated_at  INTEGER NOT NULL
);
