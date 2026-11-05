// Writes web/src/api-types.ts: the request and response types of every API route, read from the server's
// /api/openapi.json. The app is built in memory (no network, no real data) in google mode, plus the demo's
// demo-only routes. Run it after changing a route's schema; CI runs --check, which fails when the file is out of date.
// Our own small generator rather than openapi-typescript (decision 0005).
//   npm run api:types              write web/src/api-types.ts
//   npm run api:types -- --check   exit 1 when web/src/api-types.ts is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { repoPath } from '../tools/paths.ts';
import type { AppServices } from '../server/app.ts';

const OUT = repoPath('web', 'src', 'api-types.ts');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** The JSON Schema keywords the route schemas use (OpenAPI 3.0, as @fastify/swagger writes them). */
export interface Schema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  description?: string;
  $ref?: string;
}
interface Parameter {
  in: string;
  name: string;
  required?: boolean;
  schema?: Schema;
  description?: string;
}
interface Operation {
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
export interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
const comment = (text: string | undefined, pad: string) => (text ? `${pad}/** ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */\n` : '');
const union = (parts: string[]) => [...new Set(parts)].join(' | ') || 'never';
const literal = (v: unknown) => JSON.stringify(v) ?? 'unknown';

/** The TypeScript type for a schema. refs: components.schemas, for $ref. */
export function schemaToTs(schema: Schema | undefined, indent = '', refs: Record<string, Schema> = {}): string {
  if (!schema) return 'unknown';
  if (schema.$ref) return schemaToTs(refs[schema.$ref.replace('#/components/schemas/', '')], indent, refs);
  const withNull = (t: string) => (schema.nullable && t !== 'null' && t !== 'unknown' ? `${t} | null` : t);
  if (schema.const !== undefined) return withNull(literal(schema.const));
  if (schema.enum) return withNull(union(schema.enum.map(literal)));
  if (schema.anyOf || schema.oneOf) return withNull(union((schema.anyOf ?? schema.oneOf ?? []).map((s) => schemaToTs(s, indent, refs))));
  if (schema.allOf) return withNull(schema.allOf.map((s) => `(${schemaToTs(s, indent, refs)})`).join(' & ') || 'unknown');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : schema.properties ? ['object'] : [];
  if (!types.length) return 'unknown';
  return withNull(union(types.map((t) => typeOf(t, schema, indent, refs))));
}

function typeOf(type: string, schema: Schema, indent: string, refs: Record<string, Schema>): string {
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const item = schemaToTs(schema.items, indent, refs);
    return /^[\w.]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
  }
  if (type === 'object') return objectType(schema, indent, refs);
  return 'unknown';
}

function objectType(schema: Schema, indent: string, refs: Record<string, Schema>): string {
  const pad = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties ?? {}).map(
    ([name, s]) => `${comment(s.description, pad)}${pad}${key(name)}${required.has(name) ? '' : '?'}: ${schemaToTs(s, pad, refs)};`,
  );
  const extra = schema.additionalProperties;
  if (extra !== false) lines.push(`${pad}[key: string]: ${extra && extra !== true ? `${schemaToTs(extra, pad, refs)} | undefined` : 'unknown'};`);
  return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : 'Record<string, never>';
}

/** Path or query parameters as one object type. */
function parametersType(params: Parameter[], indent: string, refs: Record<string, Schema>): string {
  if (!params.length) return 'Record<string, never>';
  const pad = `${indent}  `;
  const lines = params.map((p) => `${comment(p.description ?? p.schema?.description, pad)}${pad}${key(p.name)}${p.required ? '' : '?'}: ${schemaToTs(p.schema, pad, refs)};`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

const jsonSchema = (content: Record<string, { schema?: Schema }> | undefined) => content?.['application/json']?.schema;

/** web/src/api-types.ts for an OpenAPI document. */
export function apiTypes(spec: Spec): string {
  const refs = spec.components?.schemas ?? {};
  const ops: Array<{ route: string; op: Operation }> = [];
  for (const path of Object.keys(spec.paths).sort()) {
    for (const method of METHODS) {
      const op = spec.paths[path]?.[method];
      if (op) ops.push({ route: `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`, op });
    }
  }
  const out = [
    "// Every API route's request and response types. Generated by npm run api:types from the server's /api/openapi.json;",
    '// do not edit. Routes whose response schema is only "an object" say so here too: tighten the route schema to type it.',
    '',
    'export interface ApiOperations {',
  ];
  const pad = '    ';
  for (const { route, op } of ops) {
    const params = op.parameters ?? [];
    const body = jsonSchema(op.requestBody?.content);
    const ok = Object.entries(op.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code));
    const response = ok.length ? union(ok.map(([, r]) => (r.content ? schemaToTs(jsonSchema(r.content), pad, refs) : 'null'))) : 'unknown';
    out.push(
      `${comment(op.summary, '  ')}  ${JSON.stringify(route)}: {`,
      `${pad}params: ${parametersType(params.filter((p) => p.in === 'path'), pad, refs)};`,
      `${pad}query: ${parametersType(params.filter((p) => p.in === 'query'), pad, refs)};`,
      `${pad}body: ${body ? schemaToTs(body, pad, refs) : 'never'};`,
      `${pad}response: ${response};`,
      '  };',
    );
  }
  out.push('}', '', '/** A route as "METHOD /api/path", with Fastify-style :params. */', 'export type ApiRoute = keyof ApiOperations;', '');
  return out.join('\n');
}

/**
 * The OpenAPI document of every route: the signed-in app's (google mode), plus routes only the demo has. Built in
 * memory with stand-in services, which building the document never calls.
 */
export async function buildSpec(): Promise<Spec> {
  const services = {
    claude: null,
    createBrowser: null,
    http: null,
    knowledge: async () => '',
    runPipeline: async () => ({ code: 0, lastError: null }),
    runScript: async () => ({ code: 0, lastError: null }),
    inbox: { ready: () => false, gmail: () => { throw new Error('no Gmail here'); }, key: () => null, cfg: {} },
    notices: {},
    log: { info() {}, warn() {}, error() {} },
  } as unknown as AppServices; // stand-ins: building the document calls none of them
  const spec = async (authMode: 'google' | 'demo') => {
    const store = openJobStore(':memory:', { snapshot: false });
    const settings =
      authMode === 'google'
        ? authSettings({
            AUTH_MODE: 'google',
            PUBLIC_URL: 'https://app.example.com',
            GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
            GOOGLE_WEB_CLIENT_SECRET: 'secret',
            AUTH_ALLOWED_EMAILS: 'owner@example.com',
            SESSION_SECRET: randomBytes(48).toString('base64'),
          })
        : authSettings({ AUTH_MODE: 'demo', PUBLIC_URL: 'https://demo.example.com' });
    const app = await buildApp({
      store,
      config: { search: {}, candidate: {} } as never, // no route schema reads the config
      authMode,
      auth: { settings, exchange: async () => { throw new Error('no sign-in here'); } },
      services,
    });
    try {
      await app.ready();
      return app.swagger() as unknown as Spec; // @fastify/swagger's OpenAPI 3 document
    } finally {
      await app.close();
      store.close();
    }
  };
  const merged = await spec('google');
  for (const [path, ops] of Object.entries((await spec('demo')).paths)) {
    for (const [method, op] of Object.entries(ops)) {
      merged.paths[path] ??= {};
      merged.paths[path][method] ??= op; // the signed-in app's schema wins; the demo adds only its own routes
    }
  }
  return merged;
}

async function main() {
  const spec = await buildSpec();
  const text = apiTypes(spec);
  const count = (text.match(/^ {2}"[A-Z]+ \//gm) ?? []).length;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // missing counts as out of date
    }
    if (current !== text) {
      console.error('web/src/api-types.ts does not match the route schemas. Run npm run api:types and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log(`web/src/api-types.ts matches the route schemas (${count} routes).`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`Wrote web/src/api-types.ts (${count} routes).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
