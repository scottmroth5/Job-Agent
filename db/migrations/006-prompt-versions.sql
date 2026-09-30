-- Prompt edits made in the admin screen. The repo files are the defaults; a row here with
-- active = 1 overrides the default for that prompt. Every save is kept as history.
CREATE TABLE prompt_versions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX prompt_versions_name ON prompt_versions(name, id);
CREATE UNIQUE INDEX prompt_versions_one_active ON prompt_versions(name) WHERE active = 1;
