import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/version-sync.js'
);

describe('Version', function () {
  it('package.json, CHANGELOG.md and the dev compose files agree on the version', function () {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [script, '--check'],
      { encoding: 'utf8' }
    );
    expect(status, stderr || stdout).to.equal(0);
  });
});
