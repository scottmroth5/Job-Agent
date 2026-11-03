# 0002: TypeScript through Node type stripping

Status: accepted, 2026-11-02

## Context
The code is about 22,000 lines of JavaScript with no type checking. The riskiest v3 change makes every database call asynchronous, and a missed `await` there fails quietly. Adding a build step to the server adds another moving part to every deploy.

## Decision
- Convert in place to TypeScript, run by Node's built-in type stripping. This needs Node 22.18 or newer.
- Allow only erasable syntax: no enums, parameter properties, or decorators. Use `.ts` import specifiers and `import type`.
- `tsc --noEmit` in strict mode and typed ESLint rules (`no-floating-promises`, `await-thenable`) run in CI.
- Convert one directory at a time, `checkJs` first, then rename files to `.ts`.
- Type checking comes before the async data layer (Phase 3).

## Consequences
- The server runs the source files as they are, with no build output to deploy.
- The compiler and lint rules find missed `await`s during Phase 3.
- Some TypeScript features are not available. Code that needs them is written another way.
- Types for agent-core start as a local declaration file. Publishing types from Agent-Core is a separate, approved release.
