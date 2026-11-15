'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, CHUNK_SIZE } = require('../src/server');

const TOKEN = '0123456789abcdef0123456789abcdef';
const VIDEO_ID = 'htzMcSM6Ft0';
const UNKNOWN_ID = 'dQw4w9WgXcQ'; // well-formed, but never in the test cache

// Deterministic upstream payload (~9.4 MB, forces several chunks).
const SIZE = 9 * 1024 * 1024 + 123;
const data = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = i % 251;

let upstream;
let proxy;
let tmp;
let mediaRanges; // Range headers seen by /media
let plainMediaGets; // requests to /media without a Range header

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on('error', reject);
  });
}

before(async () => {
  mediaRanges = [];
  plainMediaGets = 0;
  upstream = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: '/media' });
      res.end();
      return;
    }
    if (req.url !== '/media') {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = req.headers.range;
    if (!range) {
      plainMediaGets++;
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': SIZE,
      });
      res.end(data);
      return;
    }
    mediaRanges.push(range);
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    const s = Number(m[1]);
    const e = Number(m[2]);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${SIZE}`,
      'Content-Length': e - s + 1,
    });
    res.end(data.subarray(s, e + 1));
  });
  const upPort = await listen(upstream);

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otod-test-'));
  const batchCache = path.join(tmp, 'cache.json');
  fs.writeFileSync(
    batchCache,
    JSON.stringify({
      [VIDEO_ID]: {
        url: `http://127.0.0.1:${upPort}/redir`,
        ts: Math.floor(Date.now() / 1000),
      },
    }),
  );
  proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: batchCache,
  });
  proxyPort = await listen(proxy);
});

let proxyPort;

after(() => {
  proxy.close();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wrong token gets 404', async () => {
  const r = await get(
    proxyPort,
    `/deadbeefdeadbeefdeadbeefdeadbeef/${VIDEO_ID}`,
  );
  assert.equal(r.status, 404);
});

test('prefixed path gets 404', async () => {
  const r = await get(proxyPort, `/foo/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 404);
});

test('malformed video id gets 404', async () => {
  const r = await get(proxyPort, `/${TOKEN}/too-short`);
  assert.equal(r.status, 404);
});

test('full GET streams the whole body via <=4MiB ranged chunks', async () => {
  mediaRanges = [];
  plainMediaGets = 0;
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'audio/mp4');
  assert.equal(Number(r.headers['content-length']), SIZE);
  assert.deepEqual(r.body, data);
  assert.equal(plainMediaGets, 0, 'upstream must never see a plain GET');
  assert.ok(mediaRanges.length >= 3, 'expected several chunk requests');
  for (const range of mediaRanges) {
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(
      Number(m[2]) - Number(m[1]) + 1 <= CHUNK_SIZE,
      `chunk too large: ${range}`,
    );
  }
});

test('range GET returns 206 with the exact byte slice', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=1000000-1999999',
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers['content-range'],
    `bytes 1000000-1999999/${SIZE}`,
  );
  assert.deepEqual(r.body, data.subarray(1000000, 2000000));
});

test('suffix range returns the tail', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: 'bytes=-1000',
  });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, data.subarray(SIZE - 1000));
});

test('open-ended range works', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE - 10}-`,
  });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, data.subarray(SIZE - 10));
});

test('unsatisfiable range returns 416', async () => {
  const r = await get(proxyPort, `/${TOKEN}/${VIDEO_ID}`, {
    Range: `bytes=${SIZE + 100}-`,
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
});

test('video id missing from the batch cache gets 404', async () => {
  // The server never extracts URLs itself, so an id the shell pipeline
  // has not cached is a plain 404.
  const r = await get(proxyPort, `/${TOKEN}/${UNKNOWN_ID}`);
  assert.equal(r.status, 404);
});

test('stale batch cache entry gets 404', async () => {
  const upPort = upstream.address().port;
  const staleCache = path.join(tmp, 'cache-stale.json');
  fs.writeFileSync(
    staleCache,
    JSON.stringify({
      [VIDEO_ID]: {
        url: `http://127.0.0.1:${upPort}/media`,
        ts: Math.floor(Date.now() / 1000) - 6 * 3600, // older than 5 h
      },
    }),
  );
  const p2 = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: staleCache,
  });
  const port2 = await listen(p2);
  try {
    const r = await get(port2, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-99',
    });
    assert.equal(r.status, 404);
  } finally {
    p2.close();
  }
});

test('empty batch cache gets 404 for every video', async () => {
  const emptyCache = path.join(tmp, 'cache-empty.json');
  fs.writeFileSync(emptyCache, '{}');
  const p3 = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: emptyCache,
  });
  const port3 = await listen(p3);
  try {
    const r = await get(port3, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  } finally {
    p3.close();
  }
});

test('token file is generated with mode 600 when missing', async () => {
  const tokenFile = path.join(tmp, 'subdir', 'token');
  const p4 = createServer({
    host: '127.0.0.1',
    port: 0,
    tokenFile,
    batchCacheFile: path.join(tmp, 'cache.json'),
  });
  p4.close();
  const st = fs.statSync(tokenFile);
  assert.equal(st.mode & 0o777, 0o600);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{32}$/);
});
