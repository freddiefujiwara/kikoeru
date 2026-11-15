'use strict';

// Configuration and the token file. The token is the only secret:
// it is taken from the environment when set, read from the token
// file when present, and generated (mode 600) on first start. A
// restart must reuse the same token, or every published URL breaks.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, loadConfig, ensureToken } = require('../src/server');
const {
  listen,
  close,
  get,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
  makeMediaUpstream,
} = require('./helpers');

const VIDEO_ID = 'htzMcSM6Ft0';
const data = makeData(2048);

let tmp;
let upstream;
let upPort;

before(async () => {
  tmp = tmpDir();
  const up = makeMediaUpstream(data);
  upstream = up.server;
  upPort = await listen(upstream);
});

after(async () => {
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- loadConfig ---------------------------------------------------------------

test('loadConfig uses the documented defaults', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 8791);
  assert.equal(cfg.token, null);
  assert.equal(
    cfg.tokenFile,
    path.join(os.homedir(), '.config/kikoeru/token'),
  );
  assert.equal(
    cfg.batchCacheFile,
    path.join(os.homedir(), '.yt-audio/cache.json'),
  );
});

test('loadConfig honours every environment override', () => {
  const cfg = loadConfig({
    KIKOERU_HOST: '0.0.0.0',
    KIKOERU_PORT: '9999',
    KIKOERU_TOKEN: 'from-env',
    KIKOERU_TOKEN_FILE: '/tmp/somewhere/token',
    YT_AUDIO_CACHE: '/tmp/somewhere/cache.json',
  });
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 9999, 'the port is a number, not a string');
  assert.equal(cfg.token, 'from-env');
  assert.equal(cfg.tokenFile, '/tmp/somewhere/token');
  assert.equal(cfg.batchCacheFile, '/tmp/somewhere/cache.json');
});

test('loadConfig defaults the numeric knobs to the built-in values', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.chunkSize, 4 * 1024 * 1024);
  assert.equal(cfg.fallbackFreshSec, 6 * 3600);
  assert.equal(cfg.expiryMarginSec, 60);
  assert.equal(cfg.metaTtlMs, 50 * 60 * 1000);
});

test('loadConfig honours the numeric knob overrides', () => {
  const cfg = loadConfig({
    KIKOERU_CHUNK_SIZE: '1048576',
    KIKOERU_FALLBACK_FRESH_SEC: '7200',
    KIKOERU_EXPIRY_MARGIN_SEC: '300',
    KIKOERU_META_TTL_MS: '60000',
  });
  assert.equal(cfg.chunkSize, 1048576);
  assert.equal(cfg.fallbackFreshSec, 7200);
  assert.equal(cfg.expiryMarginSec, 300);
  assert.equal(cfg.metaTtlMs, 60000);
});

test('loadConfig falls back to the defaults for invalid knob values', () => {
  for (const bad of ['abc', '0', '-5', '']) {
    const cfg = loadConfig({
      KIKOERU_CHUNK_SIZE: bad,
      KIKOERU_FALLBACK_FRESH_SEC: bad,
      KIKOERU_EXPIRY_MARGIN_SEC: bad,
      KIKOERU_META_TTL_MS: bad,
    });
    const label = JSON.stringify(bad);
    assert.equal(cfg.chunkSize, 4 * 1024 * 1024, `chunkSize for ${label}`);
    assert.equal(cfg.fallbackFreshSec, 6 * 3600, `fallbackFreshSec for ${label}`);
    assert.equal(cfg.expiryMarginSec, 60, `expiryMarginSec for ${label}`);
    assert.equal(cfg.metaTtlMs, 50 * 60 * 1000, `metaTtlMs for ${label}`);
  }
});

// --- ensureToken ----------------------------------------------------------------

test('ensureToken returns the configured token without touching the file', () => {
  const tokenFile = path.join(tmp, 'env-token');
  const token = ensureToken({ token: 'fixed-token', tokenFile });
  assert.equal(token, 'fixed-token');
  assert.equal(fs.existsSync(tokenFile), false);
});

test('ensureToken reads an existing token file and trims it', () => {
  const tokenFile = path.join(tmp, 'existing-token');
  fs.writeFileSync(tokenFile, 'abcdef0123456789abcdef0123456789\n');
  const token = ensureToken({ token: null, tokenFile });
  assert.equal(token, 'abcdef0123456789abcdef0123456789');
});

test('ensureToken generates a 32 hex digit token with mode 600', () => {
  const tokenFile = path.join(tmp, 'gen', 'token');
  const token = ensureToken({ token: null, tokenFile });
  assert.match(token, /^[0-9a-f]{32}$/);
  const st = fs.statSync(tokenFile);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token);
});

test('ensureToken reuses the generated token on the next call', () => {
  const tokenFile = path.join(tmp, 'reuse-token');
  const first = ensureToken({ token: null, tokenFile });
  const second = ensureToken({ token: null, tokenFile });
  assert.equal(second, first);
});

test('an empty token file is replaced by a generated token', () => {
  const tokenFile = path.join(tmp, 'empty-token');
  fs.writeFileSync(tokenFile, '');
  const token = ensureToken({ token: null, tokenFile });
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token);
});

// --- token across restarts (HTTP level) ------------------------------------------

test('a restarted server accepts the token generated by the first start', async () => {
  const tokenFile = path.join(tmp, 'restart', 'token');
  const cache = path.join(tmp, 'restart-cache.json');
  writeCache(cache, {
    [VIDEO_ID]: { url: `http://127.0.0.1:${upPort}/media`, ts: nowSec() },
  });
  const opts = {
    host: '127.0.0.1',
    port: 0,
    tokenFile,
    batchCacheFile: cache,
  };
  const first = createServer(opts);
  await listen(first);
  await close(first);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{32}$/);

  const second = createServer(opts);
  const port = await listen(second);
  try {
    const r = await get(port, `/${token}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
    assert.deepEqual(r.body, data.subarray(0, 10));
    const wrong = await get(port, `/00000000000000000000000000000000/${VIDEO_ID}`);
    assert.equal(wrong.status, 404);
  } finally {
    await close(second);
  }
});

test('token file is generated with mode 600 when missing', async () => {
  const tokenFile = path.join(tmp, 'subdir', 'token');
  const p = createServer({
    host: '127.0.0.1',
    port: 0,
    tokenFile,
    batchCacheFile: path.join(tmp, 'cache.json'),
  });
  await close(p);
  const st = fs.statSync(tokenFile);
  assert.equal(st.mode & 0o777, 0o600);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{32}$/);
});
