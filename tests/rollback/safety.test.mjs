import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { rehearsalEnvironment } from './environment.mjs';

const guard = join(dirname(fileURLToPath(import.meta.url)), 'loopback-only.cjs');
const directory = mkdtempSync(join(tmpdir(), 'shario-rollback-safety-'));
test('rejects remote, authenticated and non-test database destinations', () => {
  for (const mongoUri of ['mongodb+srv://production.example/db', 'mongodb://example.com/shario-rollback-test-a', 'mongodb://user:password@127.0.0.1/shario-rollback-test-a', 'mongodb://127.0.0.1/production']) {
    assert.throws(() => rehearsalEnvironment({ mongoUri, directory, guard }), /loopback test Mongo/);
  }
});
test('does not inherit credentials, environment files, proxies or Node hooks', () => {
  const names = ['STRIPE_KEY', 'MONGO_URI', 'AWS_SECRET_ACCESS_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  try {
    for (const key of names) process.env[key] = 'must-not-inherit';
    const env = rehearsalEnvironment({ mongoUri: 'mongodb://127.0.0.1:27017/shario-rollback-test-a', directory, guard });
    for (const value of Object.values(env)) assert.ok(!value.includes('must-not-inherit'));
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.E2E_TEST_MODE, undefined, 'worker queues must remain enabled');
    assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6379/15');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('blocks a non-loopback socket before it can connect', () => {
  const result = spawnSync(process.execPath, ['--require', guard, '-e', "require('node:net').connect({host:'203.0.113.1',port:443})"], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 3000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /blocked non-loopback network/);
});
test('allows loopback communication and binds unspecified listeners to loopback', () => {
  const result = spawnSync(process.execPath, ['--require', guard, '-e', "const net=require('node:net');const s=net.createServer(c=>c.end('safe'));s.listen(0,()=>{if(s.address().address!=='127.0.0.1')throw Error('not loopback');net.connect({port:s.address().port,host:'127.0.0.1'}).on('data',()=>s.close())})"], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
