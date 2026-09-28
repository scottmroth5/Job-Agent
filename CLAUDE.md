## Purpose
Job Discovery and Job Hunt agents built on the shared agent-core package.
agent-core lives in ../Agent-Core and is installed as a local dependency.
Job specific logic stays in this repo; never add it to agent-core.

## Structure
/agents/discovery   finds, researches, and scores postings
/agents/hunt        cover letters, resume tailoring, application tracking
/tools              job specific tool definitions and handlers
/evals              hand scored postings and letter rubric cases
/data               gitignored; SQLite database and outputs
/legacy contains the v1 scripts for reference only. Do not modify or import from them.