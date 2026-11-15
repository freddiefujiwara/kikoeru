'use strict';

// The whole point of koed: the upstream is only ever asked for small
// ranged pieces (<= 4 MiB), never for a plain GET and never for one
// big range. These tests record every Range header the fake upstream
// receives for a > 10 MiB payload and check the pieces exactly: size,
// order, and that they join back into the original bytes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, CHUNK_SIZE } = require('../src/server');
const {
  listen,
  close,
  get,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
  makeMediaUpstream,
  parseRangeHeader,
} = require('./helpers');

const TOKEN = '0123456789abcdef0123456789abcdef';
const VIDEO_ID = 'htzMcSM6Ft0';

// 10 MiB + a tail, so the last chunk is short: 3 data chunks in total.
const SIZE = 10 * 1024 * 1024 + 777;
const data = makeData(SIZE);

let upstream;
let upState;
let proxy;
let proxyPort;
let tmp;

before(async () => {
  const up = makeMediaUpstream(data);
  upstream = up.server;
  upState = up.state;
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

// The recorded upstream requests for /media, as [start, end] pairs,
// in the order they arrived. A 1-byte probe (bytes=0-0) is used to
// learn the size; it appears at most once per test because the server
// caches the metadata for a while. Everything else is a data chunk.
function recordedRanges() {
  return upState.requests
    .filter((q) => q.url === '/media')
    .map((q) => parseRangeHeader(q.range));
}

function splitProbe(ranges) {
  const probes = ranges.filter(([s, e]) => s === 0 && e === 0);
  const chunks = ranges.filter(([s, e]) => !(s === 0 && e === 0));
  assert.ok(probes.length <= 1, 'at most one probe request');
  return chunks;
}

function assertChunking(ranges, wantStart, wantEnd) {
  const chunks = splitProbe(ranges);
  assert.ok(chunks.length >= 1, 'expected at least one data chunk');
  let expect = wantStart;
  for (const [s, e] of chunks) {
    assert.equal(s, expect, 'chunks must be contiguous and in order');
    assert.ok(
      e - s + 1 <= CHUNK_SIZE,
      `chunk ${s}-${e} is larger than 4 MiB`,
    );
    expect = e + 1;
  }
  assert.equal(expect - 1, wantEnd, 'chunks must cover the whole span');
  return chunks;
}

test('full GET of a >10MiB file is fetched in <=4MiB chunks, in order', async () => {
  upState.requests = [];
  upState.plainGets = 0;
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers['content-length']), SIZE);
  assert.deepEqual(r.body, data);
  assert.equal(upState.plainGets, 0, 'upstream must never see a plain GET');
  const chunks = assertChunking(recordedRanges(), 0, SIZE - 1);
  assert.equal(chunks.length, 3, 'expected exactly 3 data chunks');
  assert.deepEqual(chunks[0], [0, CHUNK_SIZE - 1]);
  assert.deepEqual(chunks[1], [CHUNK_SIZE, 2 * CHUNK_SIZE - 1]);
  assert.deepEqual(chunks[2], [2 * CHUNK_SIZE, SIZE - 1]);
});

test('a client range spanning several chunks is sub-ranged the same way', async () => {
  const start = 100;
  upState.requests = [];
  upState.plainGets = 0;
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${start}-`,
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers['content-range'],
    `bytes ${start}-${SIZE - 1}/${SIZE}`,
  );
  assert.deepEqual(r.body, data.subarray(start));
  assert.equal(upState.plainGets, 0, 'upstream must never see a plain GET');
  const chunks = assertChunking(recordedRanges(), start, SIZE - 1);
  // Sub-ranges are aligned to the requested start, not to the file.
  assert.deepEqual(chunks[0], [start, start + CHUNK_SIZE - 1]);
});

test('a client range inside one chunk causes exactly one data request', async () => {
  upState.requests = [];
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=1000-1999',
  });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, data.subarray(1000, 2000));
  const dataRequests = splitProbe(recordedRanges());
  assert.deepEqual(dataRequests, [[1000, 1999]]);
});
