'use strict';

// Range handling: parseRange unit tests plus HTTP-level checks on a
// small (1000 byte) payload, where clamping at the file edge is easy
// to see exactly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, parseRange } = require('../src/server');
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

const TOKEN = '0123456789abcdef0123456789abcdef';
const VIDEO_ID = 'htzMcSM6Ft0';
const SIZE = 1000;
const data = makeData(SIZE);

let upstream;
let proxy;
let proxyPort;
let tmp;

before(async () => {
  const up = makeMediaUpstream(data);
  upstream = up.server;
  const upPort = await listen(upstream);
  tmp = tmpDir();
  const cache = path.join(tmp, 'cache.json');
  writeCache(cache, {
    [VIDEO_ID]: { url: `http://127.0.0.1:${upPort}/media`, ts: nowSec() },
  });
  proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cache,
  });
  proxyPort = await listen(proxy);
});

after(async () => {
  await close(proxy);
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- parseRange unit tests ---------------------------------------------------

test('parseRange: no header means the full body', () => {
  assert.equal(parseRange(null, SIZE), null);
  assert.equal(parseRange(undefined, SIZE), null);
  assert.equal(parseRange('', SIZE), null);
});

test('parseRange: closed range', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-599', SIZE), {
    start: 500,
    end: 599,
  });
});

test('parseRange: open-ended range runs to the end of the file', () => {
  assert.deepEqual(parseRange('bytes=900-', SIZE), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 });
});

test('parseRange: suffix range takes the tail', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-1', SIZE), { start: 999, end: 999 });
});

test('parseRange: end past the file size is clamped', () => {
  assert.deepEqual(parseRange('bytes=990-99999', SIZE), {
    start: 990,
    end: 999,
  });
});

test('parseRange: suffix longer than the file is clamped to the whole file', () => {
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
});

test('parseRange: start at the file size is unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', SIZE), 'unsatisfiable');
  assert.equal(parseRange('bytes=1000-1001', SIZE), 'unsatisfiable');
});

test('parseRange: start after end is unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-400', SIZE), 'unsatisfiable');
});

test('parseRange: zero-length suffix is unsatisfiable', () => {
  assert.equal(parseRange('bytes=-0', SIZE), 'unsatisfiable');
});

test('parseRange: unparseable headers mean the full body', () => {
  assert.equal(parseRange('bytes=banana', SIZE), null);
  assert.equal(parseRange('items=0-10', SIZE), null);
  assert.equal(parseRange('bytes=0-1,5-6', SIZE), null);
  assert.equal(parseRange('bytes=-', SIZE), null);
  assert.equal(parseRange('bytes=', SIZE), null);
});

// --- HTTP level ----------------------------------------------------------------

test('range with the end past the file size is clamped', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=990-99999',
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 990-999/${SIZE}`);
  assert.equal(Number(r.headers['content-length']), 10);
  assert.deepEqual(r.body, data.subarray(990));
});

test('suffix range longer than the file returns the whole file as 206', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=-5000',
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-999/${SIZE}`);
  assert.deepEqual(r.body, data);
});

test('range starting exactly at the file size returns 416', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE}-`,
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
  assert.equal(r.body.length, 0);
});

test('range with start after end returns 416', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=500-400',
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
});

test('zero-length suffix range returns 416', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=-0',
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
});

test('the last byte of the file can be fetched on its own', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE - 1}-`,
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers['content-range'],
    `bytes ${SIZE - 1}-${SIZE - 1}/${SIZE}`,
  );
  assert.deepEqual(r.body, data.subarray(SIZE - 1));
});
