-- ProDocStore platform-native data model (D1).
-- Private KBs, org membership + RBAC, pages, AI review proposals, and AI usage metering.
-- Page content is stored inline here for the MVP; large assets move to R2 later.

-- Users are provisioned from OAuth sign-in (GitHub/Google). Sessions live in KV; this row
-- is the durable identity that org memberships reference.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- e.g. github_123 / google_sub
  email       TEXT,
  name        TEXT,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL
);

-- An organization = a paying customer workspace. Everything private is scoped to an org.
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,            -- uuid
  slug        TEXT NOT NULL UNIQUE,        -- subdomain: <slug>.prodocstore.online
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'trial', -- trial | team | business | enterprise
  seats       INTEGER NOT NULL DEFAULT 3,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

-- RBAC. A user's role within an org. 'viewer' seats are free; owner/admin/editor consume seats.
CREATE TABLE IF NOT EXISTS memberships (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'viewer', -- owner | admin | editor | reviewer | viewer
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- A private knowledge base. Belongs to exactly one org. Published to an access-controlled
-- subdomain; optional custom domain.
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id            TEXT PRIMARY KEY,          -- uuid
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,             -- unique within org
  title         TEXT NOT NULL,
  description   TEXT,
  visibility    TEXT NOT NULL DEFAULT 'private', -- private | org | public
  custom_domain TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (org_id, slug)
);

-- A page within a KB. Markdown source held inline (MVP). Path is the route, e.g. docs/index.md.
CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,            -- uuid
  kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,               -- unique within KB
  title       TEXT,
  content     TEXT NOT NULL DEFAULT '',    -- markdown source
  updated_by  TEXT REFERENCES users(id),
  updated_at  INTEGER NOT NULL,
  UNIQUE (kb_id, path)
);

-- AI (or human) proposed change to a page — the review gate. Applying an approved proposal
-- writes its content onto the page. Mirrors FreeDocStore's PR flow, platform-native.
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,          -- uuid
  kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'open', -- open | approved | rejected | applied
  summary       TEXT,
  rationale     TEXT,
  base_content  TEXT NOT NULL,             -- page content the proposal was diffed against
  content       TEXT NOT NULL,             -- proposed replacement
  origin        TEXT NOT NULL DEFAULT 'console', -- console | mcp | extension
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  decided_by    TEXT REFERENCES users(id),
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_kb_status ON proposals(kb_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_page ON proposals(page_id);

-- AI usage metering for quota + billing. One row per model call (console, MCP, or extension).
CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,       -- uuid
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users(id),
  provider          TEXT NOT NULL,          -- platform | anthropic | openai | github
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_time ON ai_usage(org_id, created_at);
