// The API types generator (scripts/api-types.ts): schema conversion on synthetic schemas, the generated file's shape,
// and that the document it reads covers every route. No network, no real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiTypes, buildSpec, schemaToTs } from '../scripts/api-types.ts';

test('schemas become TypeScript types', () => {
  assert.equal(schemaToTs({ type: 'string' }), 'string');
  assert.equal(schemaToTs({ type: 'integer' }), 'number');
  assert.equal(schemaToTs({ type: 'boolean' }), 'boolean');
  assert.equal(schemaToTs({ type: ['string', 'null'] }), 'string | null');
  assert.equal(schemaToTs({ type: 'string', nullable: true }), 'string | null');
  assert.equal(schemaToTs({ enum: ['a', 'b'] }), '"a" | "b"');
  assert.equal(schemaToTs({ const: 3 }), '3');
  assert.equal(schemaToTs({ type: 'object', nullable: true, enum: [null] }), 'null', "swagger's form of type null");
  assert.equal(schemaToTs({ anyOf: [{ type: 'string' }, { type: 'object', nullable: true, enum: [null] }, { type: 'string', maxLength: 0 }] }), 'string | null');
  assert.equal(schemaToTs({ allOf: [{ type: 'string' }, { enum: ['x'] }] }), '(string) & ("x")');
  assert.equal(schemaToTs({ type: 'array', items: { type: 'integer' } }), 'number[]');
  assert.equal(schemaToTs({ type: 'array', items: { enum: ['a', 'b'] } }), 'Array<"a" | "b">');
  assert.equal(schemaToTs({}), 'unknown');
  assert.equal(schemaToTs(undefined), 'unknown');
  assert.equal(schemaToTs({ $ref: '#/components/schemas/Id' }, '', { Id: { type: 'integer' } }), 'number');
});

test('objects: required and optional properties, closed or open, quoted names, and descriptions', () => {
  const closed = schemaToTs({
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer' }, 'x-name': { type: 'string', description: 'A name */ here' } },
  });
  assert.equal(closed, '{\n  id: number;\n  /** A name * / here */\n  "x-name"?: string;\n}');
  assert.equal(schemaToTs({ type: 'object' }), '{\n  [key: string]: unknown;\n}', 'an open object');
  assert.equal(schemaToTs({ type: 'object', additionalProperties: { type: 'number' } }), '{\n  [key: string]: number | undefined;\n}');
  assert.equal(schemaToTs({ type: 'object', additionalProperties: false }), 'Record<string, never>');
});

test('the generated file: Fastify-style paths, sorted, with params, query, body, and the 2xx responses', () => {
  const text = apiTypes({
    paths: {
      '/api/b/{id}': {
        patch: {
          summary: 'Edit b',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } } } } },
          responses: { 200: { content: { 'application/json': { schema: { type: 'string' } } } }, 202: { content: { 'application/json': { schema: { type: 'integer' } } } }, 404: { content: { 'application/json': { schema: { type: 'boolean' } } } } },
        },
        get: { responses: { 204: {} } },
      },
      '/api/a': { get: { parameters: [{ in: 'query', name: 'q', schema: { type: 'string' } }] } },
    },
  });
  const routes = [...text.matchAll(/^ {2}"([^"]+)": \{$/gm)].map((m) => m[1]);
  assert.deepEqual(routes, ['GET /api/a', 'GET /api/b/:id', 'PATCH /api/b/:id']);
  assert.match(text, /"GET \/api\/a": \{\n {4}params: Record<string, never>;\n {4}query: \{\n {6}q\?: string;\n {4}\};\n {4}body: never;\n {4}response: unknown;/);
  assert.match(text, /"GET \/api\/b\/:id": \{[^]*?response: null;/, 'a 2xx with no content');
  assert.match(text, /\/\*\* Edit b \*\/\n {2}"PATCH \/api\/b\/:id": \{\n {4}params: \{\n {6}id: number;\n {4}\};[^]*?body: \{\n {6}name\?: string;\n {4}\};\n {4}response: string \| number;/);
  assert.match(text, /export type ApiRoute = keyof ApiOperations;\n$/);
});

test('the document covers every API route: the signed-in app, Admin, and the demo-only sample', async () => {
  const spec = await buildSpec();
  const routes = new Set(Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`)));
  for (const must of ['GET /api/postings', 'PATCH /api/postings/:id', 'GET /api/admin/users', 'POST /api/inbox/check', 'POST /api/pipeline/run', 'GET /api/postings/:id/find-contact/sample']) {
    assert.ok(routes.has(must), must);
  }
  assert.ok(!routes.has('GET /api/openapi.json'), 'the document itself is hidden');
  assert.ok(routes.size >= 100, `${routes.size} routes`);
});
