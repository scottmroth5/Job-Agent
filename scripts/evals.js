// Runs the evals. Both call Claude and cost money.
//   npm run evals            the inbox eval (synthetic cases, a few cents)
//   npm run evals -- --all   also the scoring eval (your real cases in data/evals/score, about $2);
//                            pass its options after --all, e.g. --all --models=claude-sonnet-5-5 --max-usd=3
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const run = (script, args) => {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(process.execPath, ['--env-file=.env', script, ...args], { stdio: 'inherit' });
  return r.status ?? 1;
};

let failed = run('scripts/eval-inbox.js', argv.filter((a) => a.startsWith('--max-usd=') || a === '--verbose'));
if (argv.includes('--all')) {
  const scoreArgs = argv.filter((a) => a !== '--all' && a !== '--verbose');
  if (!scoreArgs.some((a) => a.startsWith('--models='))) scoreArgs.push('--models=claude-sonnet-5-5');
  failed ||= run('scripts/eval-score.js', scoreArgs);
}
process.exitCode = failed;
