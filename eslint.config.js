// Lint (v3 Phase 2): only the typed rules that catch promise mistakes, plus type-only imports. A missed await
// fails quietly, and Phase 3 makes every database call async. No style rules: formatting is left as it is.
// `void call()` marks a deliberate fire-and-forget call whose function catches its own errors.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'web/dist/**', 'legacy/**', 'data/**', 'demo-data/**'] },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: { allowDefaultProject: ['*.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // node:test's test() and its kin return a promise the runner itself tracks.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
      '@typescript-eslint/await-thenable': 'error',
      // React ignores what an onClick or onChange handler returns; the page's async handlers catch their own
      // errors (their act, run, and load helpers set an error message). Promises passed anywhere else still count.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // v3 Phase 3: every database call goes through the async engine (db/engine). better-sqlite3 is imported only by the
  // engine and its file helpers, by the migrations (they run on the connection before the engine exists), by the
  // agent-core declarations, and by tests that build synthetic databases or test the engine on its connection.
  // v3 Phase 7 (decision 0009): the layers, in today's folders. tools/ and db/ are the platform and never import the
  // job's logic (agents/) or the server; agents/ is the job's logic and never imports the server or its framework.
  // Fastify belongs to server/ and apps/, pg to the database code (db/, tools/backup), Playwright to tools/browser.ts.
  // ESLint keeps only the last no-restricted-imports setting that matches a file, so each folder's list is whole.
  ...layers(),
);

function layers() {
  const sqlite = { name: 'better-sqlite3', message: 'Use the async engine: store.db, store.admin, or db/engine/files.ts for work on database files.' };
  const fastify = { group: ['fastify', '@fastify/*'], message: 'Fastify belongs to server/ and apps/.' };
  const pg = { group: ['pg'], message: 'pg belongs to the database code (db/, tools/backup): use store.db or store.admin.' };
  const playwright = { group: ['playwright', 'playwright-core'], message: 'Use tools/browser.ts createBrowser.' };
  const up = (dirs, why) => ({ group: dirs.flatMap((d) => [`**/${d}/*`, `**/${d}/**`, `../${d}/*`]), message: why });
  const server = up(['server', 'apps'], 'A lower layer never imports the server: move the shared code down (tools/, db/, agents/).');
  const agents = up(['agents'], "tools/ and db/ are the platform: they never import the job's logic in agents/.");
  const rule = (paths, patterns) => ({ 'no-restricted-imports': ['error', { paths, patterns }] });
  const all = '**/*.{js,jsx,ts,tsx}';
  return [
    // Everywhere else (server, apps, scripts, web, evals, demo): only the better-sqlite3 rule.
    { files: [all], ignores: ['db/engine/**', 'db/migrations/**', 'types/**', 'test/**'], rules: rule([sqlite], []) },
    { files: ['agents/**/*.ts'], rules: rule([sqlite], [server, fastify, pg, playwright]) },
    { files: ['tools/**/*.ts'], ignores: ['tools/backup/**', 'tools/browser.ts'], rules: rule([sqlite], [server, agents, fastify, pg, playwright]) },
    { files: ['tools/backup/**/*.ts'], rules: rule([sqlite], [server, agents, fastify, playwright]) },
    { files: ['tools/browser.ts'], rules: rule([sqlite], [server, agents, fastify, pg]) },
    { files: ['db/**/*.ts'], ignores: ['db/engine/**', 'db/migrations/**'], rules: rule([sqlite], [server, agents, fastify, playwright]) },
    { files: ['db/engine/**/*.ts', 'db/migrations/**/*.ts'], rules: rule([], [server, agents, fastify, playwright]) },
  ];
}
