'use strict';

// Upstream failures. Stream URLs die after a few hours, so the
// important path is: upstream answers 403 -> the batch cache is
// re-read once (the shell pipeline may have refreshed it) -> retry
// with the new URL. These tests use a custom upstream whose behaviour
// can be switched per path, and which can rewrite the batch cache
// file mid-request to simulate the shell refreshing it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, CHUNK_SIZE } = require('../src/server');
const {
  listen,
  close,
  get,
  getExpectTimeout,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
} = require('./helpers');

const TOKEN = '0123456789abcdef0123456789abcdef';
const VIDEO_ID = 'htzMcSM6Ft0';
const SIZE = 8192;
const data = makeData(SIZE);

let upstream;
let upPort;
let tmp;
let hits; // per-path request counts
let cacheFile; // the batch cache the running kikoeru reads
let onFlakyChunk; // hook fired when /flaky gets a data (non-probe) request

function serveRange(req, res) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(416);
    res.end();
    return;
  }
  const s = Number(m[1]);
  const e = Number(m[2]);
  res.writeHead(206, {
    'Content-Type': 'audio/mp4',
    'Content-Range': `bytes ${s}-${e}/${SIZE}`,
    'Content-Length': e - s + 1,
  });
  res.end(data.subarray(s, e + 1));
}

before(async () => {
  hits = {};
  upstream = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const range = req.headers.range || '';
    switch (req.url) {
      case '/good':
        serveRange(req, res);
        return;
      case '/expired':
        // Always 403. The first hit refreshes the batch cache to
        // point at /good, like the shell pipeline would.
        if (hits['/expired'] === 1) {
          writeCache(cacheFile, {
            [VIDEO_ID]: {
              url: `http://127.0.0.1:${upPort}/good`,
              ts: nowSec(),
            },
          });
        }
        res.writeHead(403);
        res.end();
        return;
      case '/dead':
        // Always 403, and the cache never changes.
        res.writeHead(403);
        res.end();
        return;
      case '/flaky':
        // The 1-byte probe succeeds, data chunks get a 403. The hook
        // refreshes the batch cache to /good before answering.
        if (range === 'bytes=0-0') {
          serveRange(req, res);
          return;
        }
        if (onFlakyChunk) onFlakyChunk();
        res.writeHead(403);
        res.end();
        return;
      case '/probe500':
        res.writeHead(500);
        res.end();
        return;
      case '/chunk500':
        // Probe succeeds, every data chunk fails with 500.
        if (range === 'bytes=0-0') {
          serveRange(req, res);
          return;
        }
        res.writeHead(500);
        res.end();
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  upPort = await listen(upstream);
  tmp = tmpDir();
  cacheFile = path.join(tmp, 'cache.json');
});

after(async () => {
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Start an kikoeru whose cache points VIDEO_ID at `upstreamPath`.
async function withServerAt(upstreamPath, fn) {
  writeCache(cacheFile, {
    [VIDEO_ID]: {
      url: `http://127.0.0.1:${upPort}${upstreamPath}`,
      ts: nowSec(),
    },
  });
  const p = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
  });
  const port = await listen(p);
  try {
    await fn(port);
  } finally {
    await close(p);
  }
}

test('403 on the probe retries once with the refreshed cache URL', async () => {
  hits = {};
  await withServerAt('/expired', async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, data);
  });
  assert.equal(hits['/expired'], 1, 'the dead URL is probed only once');
  assert.ok(hits['/good'] >= 2, 'the refreshed URL is probed and streamed');
});

test('403 with no cache refresh gives 404 after one retry', async () => {
  hits = {};
  await withServerAt('/dead', async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
  assert.equal(hits['/dead'], 2, 'the probe is tried, then retried once');
});

test('403 on the first data chunk retries with the refreshed cache URL', async () => {
  hits = {};
  onFlakyChunk = () => {
    writeCache(cacheFile, {
      [VIDEO_ID]: {
        url: `http://127.0.0.1:${upPort}/good`,
        ts: nowSec(),
      },
    });
  };
  try {
    await withServerAt('/flaky', async (port) => {
      const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, data);
    });
  } finally {
    onFlakyChunk = null;
  }
  assert.ok(hits['/good'] >= 2, 'the refreshed URL is probed and streamed');
});

test('403 on a data chunk with no cache refresh gives a prompt 502', async () => {
  // The retry re-reads the same dead URL and fails again. Nothing
  // has been sent to the client at that point, so kikoeru must answer
  // promptly with 502 instead of leaving the request hanging.
  hits = {};
  onFlakyChunk = () => {};
  try {
    await withServerAt('/flaky', async (port) => {
      const r = await getExpectTimeout(port, `/${TOKEN}/${VIDEO_ID}`);
      assert.equal(r.timedOut, false, 'kikoeru must answer, not hang');
      assert.equal(r.status, 502);
    });
  } finally {
    onFlakyChunk = null;
  }
});

test('500 on the probe gives 404', async () => {
  await withServerAt('/probe500', async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('500 on a data chunk gives a prompt 502', async () => {
  // A non-403 error on the first data chunk happens before anything
  // is sent to the client, so it is answered with a prompt 502.
  await withServerAt('/chunk500', async (port) => {
    const r = await getExpectTimeout(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false, 'kikoeru must answer, not hang');
    assert.equal(r.status, 502);
  });
});

// Fetch and report how the exchange ended: { status, bytes,
// complete, timedOut }. Used for the mid-body failure below, where
// the response starts normally and is then cut short.
function getObserveEnd(port, p, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    let status = null;
    let bytes = 0;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve({ status, bytes, ...v });
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      status = res.statusCode;
      res.on('data', (c) => {
        bytes += c.length;
      });
      res.on('end', () => finish({ complete: res.complete, timedOut: false }));
      res.on('aborted', () =>
        finish({ complete: res.complete, timedOut: false }),
      );
      res.on('close', () =>
        finish({ complete: res.complete, timedOut: false }),
      );
    });
    req.on('error', () => finish({ complete: false, timedOut: false }));
    req.setTimeout(ms, () => {
      req.destroy();
      finish({ complete: false, timedOut: true });
    });
  });
}

test('500 on a later chunk cuts the response short instead of hanging', async () => {
  // The payload is one chunk plus a little more, so the first chunk
  // is streamed to the client and the failure only happens in
  // streamRest, after the 200 status and the first bytes are out.
  // No error status can be sent then; kikoeru must cut the response so
  // the client sees it end (incomplete) right away, not hang.
  const bigSize = CHUNK_SIZE + 1024;
  const big = makeData(bigSize);
  const up = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    const s = Number(m[1]);
    const e = Number(m[2]);
    if (s >= CHUNK_SIZE) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${bigSize}`,
      'Content-Length': e - s + 1,
    });
    res.end(big.subarray(s, e + 1));
  });
  const upPort2 = await listen(up);
  writeCache(cacheFile, {
    [VIDEO_ID]: { url: `http://127.0.0.1:${upPort2}/big`, ts: nowSec() },
  });
  const p = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
  });
  const port = await listen(p);
  try {
    const r = await getObserveEnd(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false, 'kikoeru must end the response, not hang');
    assert.equal(r.status, 200);
    assert.equal(r.bytes, CHUNK_SIZE, 'only the first chunk was delivered');
    assert.equal(r.complete, false, 'the body ends incomplete');
  } finally {
    await close(p);
    await close(up);
  }
});

test('upstream connection refused gives 404', async () => {
  // Grab a port and immediately release it so nothing listens there.
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await close(dead);
  writeCache(cacheFile, {
    [VIDEO_ID]: { url: `http://127.0.0.1:${deadPort}/media`, ts: nowSec() },
  });
  const p = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
  });
  const port = await listen(p);
  try {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  } finally {
    await close(p);
  }
});
