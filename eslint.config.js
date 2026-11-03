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
);
