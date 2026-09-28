# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a freshly initialized Node.js project (`npm init` defaults) with no source code, dependencies, or commits yet. Update this file once the architecture takes shape.

- Entry point declared in `package.json`: `index.js` (does not exist yet).
- No build, lint, or test tooling is configured; `npm test` is the npm placeholder and exits with an error.
- Default git branch is `master`, but `main` is the intended PR base branch.

## Conventions from existing config

- `.gitignore` excludes `node_modules/`, `.env`, and `data/`. Secrets and config belong in `.env`, and runtime/generated data belongs in `data/`. Neither should be committed.
- Development happens on Windows (PowerShell primary, Git Bash available).
