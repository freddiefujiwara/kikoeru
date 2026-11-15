'use strict';

// Core behaviour: routing, token / video-id checks, full and ranged
// relaying against a fake upstream. The upstream payload is ~9.4 MB so
// a full GET has to be split into several <= 4 MiB ranged chunks.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, CHUNK_SIZE } = require('../src/server');
const {
  listen,
  close,
  request,
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
const SECOND_ID = 'dQw4w9WgXcQ'; // also present in the test cache
const UNKNOWN_ID = 'AAAAAAAAAAA'; // well-formed, but never in the cache

const SIZE = 9 * 1024 * 1024 + 123;
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
  const batchCache = path.join(tmp, 'cache.json');
  writeCache(batchCache, {
    [VIDEO_ID]: { url: `http://127.0.0.1:${upPort}/redir`, ts: nowSec() },
    [SECOND_ID]: { url: `http://127.0.0.1:${upPort}/media`, ts: nowSec() },
  });
  proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: batchCache,
  });
  proxyPort = await listen(proxy);
});

after(async () => {
  await close(proxy);
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- routing and access checks -------------------------------------------

test('correct token and video id returns 200', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${SECOND_ID}`, {
    Range: 'bytes=0-99',
  });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, data.subarray(0, 100));
});

test('wrong token gets 404', async () => {
  const r = await get(
    proxyPort,
    `/deadbeefdeadbeefdeadbeefdeadbeef/${VIDEO_ID}`,
  );
  assert.equal(r.status, 404);
});

test('token of a different length gets 404', async () => {
  const r = await get(proxyPort, `/abc/${VIDEO_ID}`);
  assert.equal(r.status, 404);
});

test('root path gets 404', async () => {
  const r = await get(proxyPort, '/');
  assert.equal(r.status, 404);
});

test('token without a video id gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}`);
  assert.equal(r.status, 404);
});

test('prefixed path gets 404', async () => {
  const r = await get(proxyPort, `/foo/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 404);
});

test('old prefixed route shape gets 404', async () => {
  const r = await get(proxyPort, `/yt-play/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 404);
});

test('extra path segment gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}/extra`);
  assert.equal(r.status, 404);
});

test('trailing slash gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}/`);
  assert.equal(r.status, 404);
});

test('query string gets 404 (the route must match exactly)', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}?x=1`);
  assert.equal(r.status, 404);
});

test('POST to a valid path gets 404', async () => {
  const r = await request(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    method: 'POST',
  });
  assert.equal(r.status, 404);
});

test('PUT to a valid path gets 404', async () => {
  const r = await request(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    method: 'PUT',
  });
  assert.equal(r.status, 404);
});

// --- video id format ------------------------------------------------------

test('malformed video id gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/too-short`);
  assert.equal(r.status, 404);
});

test('video id of 10 characters gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/htzMcSM6Ft`);
  assert.equal(r.status, 404);
});

test('video id of 12 characters gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/htzMcSM6Ft00`);
  assert.equal(r.status, 404);
});

test('video id with an illegal character gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/htzMcSM6F!0`);
  assert.equal(r.status, 404);
});

test('video id with a dot gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/htzMcSM6F.0`);
  assert.equal(r.status, 404);
});

test('video id with dash and underscore is accepted', async () => {
  // SECOND_ID has neither, so use a dedicated id that is in the cache
  // of a throwaway server.
  const upPort = upstream.address().port;
  const cache = path.join(tmp, 'cache-dash.json');
  writeCache(cache, {
    'a-b_cdefghi': {
      url: `http://127.0.0.1:${upPort}/media`,
      ts: nowSec(),
    },
  });
  const p = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cache,
  });
  const port = await listen(p);
  try {
    const r = await get(port, `/${TOKEN}/a-b_cdefghi`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
    assert.deepEqual(r.body, data.subarray(0, 10));
  } finally {
    await close(p);
  }
});

// --- full and ranged relaying ---------------------------------------------

test('full GET streams the whole body via <=4MiB ranged chunks', async () => {
  upState.requests = [];
  upState.plainGets = 0;
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'audio/mp4');
  assert.equal(Number(r.headers['content-length']), SIZE);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.deepEqual(r.body, data);
  assert.equal(upState.plainGets, 0, 'upstream must never see a plain GET');
  const ranges = upState.requests
    .filter((q) => q.url === '/media')
    .map((q) => q.range);
  assert.ok(ranges.length >= 3, 'expected several chunk requests');
  for (const range of ranges) {
    const se = parseRangeHeader(range);
    assert.ok(se, `unexpected range header: ${range}`);
    assert.ok(
      se[1] - se[0] + 1 <= CHUNK_SIZE,
      `chunk too large: ${range}`,
    );
  }
});

test('a second cached video id is relayed too', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${SECOND_ID}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, data);
});

test('range GET returns 206 with the exact byte slice', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=1000000-1999999',
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 1000000-1999999/${SIZE}`);
  assert.equal(Number(r.headers['content-length']), 1000000);
  assert.deepEqual(r.body, data.subarray(1000000, 2000000));
});

test('suffix range returns the tail', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=-1000',
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers['content-range'],
    `bytes ${SIZE - 1000}-${SIZE - 1}/${SIZE}`,
  );
  assert.deepEqual(r.body, data.subarray(SIZE - 1000));
});

test('open-ended range works', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE - 10}-`,
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers['content-range'],
    `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`,
  );
  assert.deepEqual(r.body, data.subarray(SIZE - 10));
});

test('single byte range returns exactly one byte', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=0-0',
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-0/${SIZE}`);
  assert.deepEqual(r.body, data.subarray(0, 1));
});

test('unsatisfiable range returns 416', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE + 100}-`,
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
});

test('HEAD returns headers and no body', async () => {
  const r = await request(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    method: 'HEAD',
  });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers['content-length']), SIZE);
  assert.equal(r.headers['content-type'], 'audio/mp4');
  assert.equal(r.body.length, 0);
});

test('HEAD with a range returns 206 headers and no body', async () => {
  const r = await request(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    method: 'HEAD',
    headers: { Range: 'bytes=10-19' },
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 10-19/${SIZE}`);
  assert.equal(Number(r.headers['content-length']), 10);
  assert.equal(r.body.length, 0);
});

test('If-Range is ignored and the range is served', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=0-99',
    'If-Range': '"some-other-etag"',
  });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, data.subarray(0, 100));
});

test('an unparseable Range header falls back to the full body', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=banana',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, data);
});

test('a multi-range header falls back to the full body', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=0-1,5-6',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, data);
});

// --- cache misses -----------------------------------------------------------

test('video id missing from the batch cache gets 404', async () => {
  // The server never extracts URLs itself, so an id the shell pipeline
  // has not cached is a plain 404.
  const r = await get(proxyPort, `/${TOKEN}/${UNKNOWN_ID}`);
  assert.equal(r.status, 404);
});
