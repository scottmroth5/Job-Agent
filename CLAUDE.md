## Purpose
Job Discovery and Job Hunt agents built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.0"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>"; test unreleased changes with npm link ../Agent-Core.
Job specific logic stays in this repo; never add it to agent-core.

## Structure
/agents/discovery   finds, researches, and scores postings
/agents/hunt        cover letters, resume tailoring, application tracking
/tools              job specific tool definitions and handlers
/server             API over the SQLite store, plus the in-process scheduler that runs the agents
/web                React (Vite) UI; the only place the user reviews and edits the pipeline
/evals              hand scored postings and letter rubric cases
/data               gitignored; SQLite database and outputs
/legacy contains the v1 scripts for reference only. Do not modify or import from them.