import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mainJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/main.js'
);

/**
 * Starts the server on a throwaway config and waits for it to exit.
 * Every case here aborts during config loading, so the process never reaches listen().
 * @param {object} config Config object, written to a temporary config.json.
 * @param {Record<string, string>} [env] Extra environment variables.
 * @returns {{status: number|null, output: string}} Exit status and combined stdout/stderr.
 */
function runWithConfig(config, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgl-config-env-'));
  try {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const baseEnv = { ...process.env };
    for (const name of Object.keys(baseEnv)) {
      if (name.startsWith('TSGL_TEST_')) {
        // eslint-disable-next-line security/detect-object-injection -- name is an own key of the env copy, filtered to TSGL_TEST_*
        delete baseEnv[name];
      }
    }
    const result = spawnSync(process.execPath, [mainJs, '--config', configPath], {
      env: { ...baseEnv, NODE_ENV: 'test', ...env },
      encoding: 'utf8',
      timeout: 30000
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Config environment variable substitution', function () {
  this.timeout(35000);

  it('aborts naming every unset required variable once', function () {
    const { status, output } = runWithConfig({
      options: { paths: { root: '${TSGL_TEST_ROOT}' } },
      data: {
        a: { pmtiles: '${TSGL_TEST_PMTILES_URL}' },
        b: { pmtiles: '${TSGL_TEST_PMTILES_URL}', s3Region: '${TSGL_TEST_REGION}' }
      }
    });
    expect(status).to.equal(1);
    expect(output).to.include(
      'Config file references environment variable(s) that are not set: TSGL_TEST_ROOT, TSGL_TEST_PMTILES_URL, TSGL_TEST_REGION'
    );
  });

  it('treats an empty required variable as unset', function () {
    const { status, output } = runWithConfig(
      { data: { a: { pmtiles: '${TSGL_TEST_PMTILES_URL}' } } },
      { TSGL_TEST_PMTILES_URL: '' }
    );
    expect(status).to.equal(1);
    expect(output).to.include('not set: TSGL_TEST_PMTILES_URL');
  });

  it('applies ${VAR:-default} without reporting the variable as missing', function () {
    // The default points at a path that does not exist, so startup still aborts - but on the path check, proving the default was used.
    const missingDir = path.join(os.tmpdir(), 'tsgl-config-env-does-not-exist');
    const { status, output } = runWithConfig({
      options: { paths: { root: `\${TSGL_TEST_ROOT:-${missingDir}}` } }
    });
    expect(status).to.equal(1);
    expect(output).to.not.include('not set');
    expect(output).to.include(`does not exist (${missingDir})`);
  });

  it('substitutes a set variable', function () {
    const missingDir = path.join(os.tmpdir(), 'tsgl-config-env-from-env');
    const { status, output } = runWithConfig(
      { options: { paths: { root: '${TSGL_TEST_ROOT}' } } },
      { TSGL_TEST_ROOT: missingDir }
    );
    expect(status).to.equal(1);
    expect(output).to.not.include('not set');
    expect(output).to.include(`does not exist (${missingDir})`);
  });
});
