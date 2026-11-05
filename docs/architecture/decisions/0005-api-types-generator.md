# 0005: Our own API types generator

Status: accepted, 2026-11-05

## Context
Phase 2 asks for the web client's API types to be generated from `/api/openapi.json`, with a CI check for drift. The planned tool, openapi-typescript (7.13.0, February 2026), declares support for TypeScript 5 only, and this repository uses TypeScript 6, so npm refuses it without an override. It would also add 32 development packages. The spec it reads comes from two app modes: the signed-in app, and the demo, which has one route of its own.

## Decision
- `scripts/api-types.ts` builds the app in memory in google mode and in demo mode, merges their OpenAPI documents, and writes `web/src/api-types.ts`: for each route, as `"METHOD /api/path"` with Fastify-style `:params`, the types of its path parameters, query, body, and 2xx responses.
- It converts only the JSON Schema keywords the routes use. Anything else becomes `unknown`, never `any`.
- `npm run api:types -- --check` runs in CI, the same way as `db:types`.

## Consequences
- No new dependency, and no peer conflict on TypeScript upgrades.
- A route schema that uses a keyword the generator does not know yields `unknown` until the generator learns it.
- Response types are only as precise as the route schemas. Most responses are open objects today, so tightening them is what makes them useful.
- Revisit when openapi-typescript supports TypeScript 6, or when Phase 6 builds `packages/contracts`, which may want a standard generator.
