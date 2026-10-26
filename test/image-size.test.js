// The server's disk: the image must not carry the workflow's scan cache, and deploys must not keep unused images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';

test('the image leaves out the scan cache, and a deploy removes unused images whatever their age', () => {
  const ignore = readFileSync(repoPath('.dockerignore'), 'utf8');
  assert.match(ignore, /^\.cache\/$/m, "Trivy's database stays out of the published image");
  const deploy = readFileSync(repoPath('deploy', 'deploy.sh'), 'utf8');
  assert.match(deploy, /docker image prune -af >/);
  assert.doesNotMatch(deploy, /prune[^\n]*until=/, 'no age filter: old images filled the disk');
});
