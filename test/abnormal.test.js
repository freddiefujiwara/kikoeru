'use strict';

// Abnormal cases: inputs and upstreams that do not play by the
// rules. The request side can carry any Range header a client (or an
// attacker) cares to send; the upstream side is a remote server
// whose answers can lie — a Content-Range naming different bytes
// than were asked for, a body longer than the range it answers, a
// redirect to a non-HTTP URL. The invariant throughout: the relay
// may refuse (404/416/502) or cut the response short, but the bytes
// it does emit are always an exact prefix of the source — never
// wrong bytes, never more bytes than the declared Content-Length.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, parseRange, urlExpirySec } = require('../src/server');
const {
  listen,
  close,
  get,
  getExpectTimeout,
  getRawWire,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
} = require('./helpers');

const TOKEN = '0123456789abcdef0123456789abcdef';
const VIDEO_ID = 'htzMcSM6Ft0';
const SECOND_ID = 'dQw4w9WgXcQ';
const SIZE = 3000;
const data = makeData(SIZE);
const CHUNK = 1024; // proxy chunkSize override: 3 chunks per full GET

let tmp;
let cacheFile;

before(() => {
  tmp = tmpDir();
  cacheFile = path.join(tmp, 'cache.json');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Start a throwaway kikoeru whose cache maps VIDEO_ID (and SECOND_ID
// when given) at paths on `upstreamServer`.
async function withProxy(upstreamServer, paths, fn) {
  const upPort = await listen(upstreamServer);
  const entries = {};
  for (const [id, p] of Object.entries(paths)) {
    entries[id] = { url: `http://127.0.0.1:${upPort}${p}`, ts: nowSec() };
  }
  writeCache(cacheFile, entries);
  const proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
    chunkSize: CHUNK,
  });
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    await close(proxy);
    await close(upstreamServer);
  }
}

// An honest range server over `data`: 206, a Content-Range matching
// the request, exactly the requested bytes.
function serveHonest(req, res) {
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

function isProbe(req) {
  return (req.headers.range || '') === 'bytes=0-0';
}

// --- parseRange: hostile numbers ---------------------------------------------

test('parseRange: absurdly long digit strings cannot overflow the result', () => {
  const huge = '9'.repeat(400); // Number(huge) is Infinity
  // A start at +Infinity is simply unsatisfiable.
  assert.equal(parseRange(`bytes=${huge}-`, SIZE), 'unsatisfiable');
  assert.equal(parseRange(`bytes=${huge}-${huge}`, SIZE), 'unsatisfiable');
  // A suffix longer than any file is the whole file (RFC 9110).
  assert.deepEqual(parseRange(`bytes=-${huge}`, SIZE), {
    start: 0,
    end: SIZE - 1,
  });
  // An end at +Infinity clamps to the last byte.
  assert.deepEqual(parseRange(`bytes=0-${huge}`, SIZE), {
    start: 0,
    end: SIZE - 1,
  });
});

test('parseRange: a zero-length file has no satisfiable range', () => {
  assert.equal(parseRange(null, 0), null); // full body (of nothing)
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-0', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=-1', 0), 'unsatisfiable');
});

// --- urlExpirySec: hostile expire parameters ----------------------------------

test('urlExpirySec: junk expire values are all "no expiry"', () => {
  const base = 'http://127.0.0.1:9/media';
  assert.equal(urlExpirySec(base), null);
  assert.equal(urlExpirySec(`${base}?expire=`), null);
  assert.equal(urlExpirySec(`${base}?expire=abc`), null);
  assert.equal(urlExpirySec(`${base}?expire=0`), null);
  assert.equal(urlExpirySec(`${base}?expire=-5`), null);
  // Number('1e999') is Infinity; that is not a usable expiry.
  assert.equal(urlExpirySec(`${base}?expire=1e999`), null);
  assert.equal(urlExpirySec('not a url at all'), null);
  assert.equal(urlExpirySec(''), null);
});

// --- request side --------------------------------------------------------------

test('a range with leading zeros is served exactly', async () => {
  const up = http.createServer(serveHonest);
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=007-009',
    });
    assert.equal(r.status, 206);
    assert.deepEqual(r.body, data.subarray(7, 10));
  });
});

test('HEAD with an unsatisfiable range returns 416', async () => {
  const up = http.createServer(serveHonest);
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await getRawWire(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: `bytes=${SIZE}-`,
    });
    assert.equal(r.status, 416);
    assert.equal(r.body.length, 0);
  });
});

// --- batch cache entries with non-URL urls -------------------------------------

test('a cache entry whose url is not a string gets 404 and the server stays up', async () => {
  writeCache(cacheFile, { [VIDEO_ID]: { url: 12345, ts: nowSec() } });
  const proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
    chunkSize: CHUNK,
  });
  const port = await listen(proxy);
  try {
    const r1 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r1.status, 404);
    const r2 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r2.status, 404, 'the server did not fall over');
  } finally {
    await close(proxy);
  }
});

test('a cache entry whose url is not a URL gets 404', async () => {
  writeCache(cacheFile, {
    [VIDEO_ID]: { url: 'not a url at all', ts: nowSec() },
  });
  const proxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'token'),
    batchCacheFile: cacheFile,
    chunkSize: CHUNK,
  });
  const port = await listen(proxy);
  try {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  } finally {
    await close(proxy);
  }
});

// --- upstream bodies that are longer than the range they answer -----------------

test('an upstream chunk that delivers more bytes than its range cannot corrupt the stream', async () => {
  // Every data chunk arrives chunked (no Content-Length) with the
  // requested slice PLUS 64 garbage bytes appended. The relay must
  // emit exactly the source bytes: never the garbage, and never
  // more bytes than the Content-Length it declared to the client.
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
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
    });
    res.end(
      Buffer.concat([data.subarray(s, e + 1), Buffer.alloc(64, 0xee)]),
    );
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await getRawWire(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 200);
    assert.equal(r.contentLength, SIZE);
    assert.equal(
      r.body.length,
      SIZE,
      'no more bytes on the wire than the declared Content-Length',
    );
    assert.deepEqual(r.body, data);
  });
});

test('over-delivery confined to the first chunk cannot skip source bytes', async () => {
  // Only the first data chunk over-delivers. If the relay counted
  // the garbage as streamed audio, the resume would start 64 bytes
  // too late and those source bytes would never reach the client.
  let dataAttempts = 0;
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
    dataAttempts++;
    if (dataAttempts > 1) return serveHonest(req, res);
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const s = Number(m[1]);
    const e = Number(m[2]);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${SIZE}`,
    });
    res.end(
      Buffer.concat([data.subarray(s, e + 1), Buffer.alloc(64, 0xee)]),
    );
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await getRawWire(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, SIZE);
    assert.deepEqual(r.body, data);
  });
});

// --- upstream Content-Range that names different bytes than requested -----------

test('a first chunk answered with a Content-Range for a different range is refused', async () => {
  // Asked for bytes 1000-1999, the upstream serves bytes 0-999 and
  // its Content-Range says so. Relaying those bytes under a
  // 1000-1999 Content-Range would hand the client the wrong audio
  // with no sign of error; the chunk must be rejected instead.
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes 0-999/${SIZE}`,
      'Content-Length': 1000,
    });
    res.end(data.subarray(0, 1000));
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=1000-1999',
    });
    assert.equal(r.status, 502, 'the lying chunk is rejected, not relayed');
  });
});

test('a later chunk answered with the wrong Content-Range cuts the response at the last good byte', async () => {
  // The first chunk is honest; later chunks serve from byte 0 with
  // a Content-Range that admits it. The client keeps the honest
  // first chunk and sees the response end there — a strict prefix
  // of the source, never the wrong bytes.
  const up = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    const s = Number(m[1]);
    const e = Number(m[2]);
    if (s === 0) return serveHonest(req, res);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes 0-${e - s}/${SIZE}`,
      'Content-Length': e - s + 1,
    });
    res.end(data.subarray(0, e - s + 1));
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await getRawWire(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 200);
    assert.equal(r.contentLength, SIZE);
    assert.deepEqual(r.body, data.subarray(0, CHUNK));
    assert.ok(r.body.length < r.contentLength, 'the body ends incomplete');
  });
});

test('a chunk answered with a Content-Range extending past the requested end is refused', async () => {
  // Asked for 0-1023, the upstream claims bytes 0-2047 and sends
  // them. The extra bytes belong to a later position; accepting the
  // chunk would duplicate them when the next chunk is fetched.
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const s = Number(m[1]);
    const e = Math.min(Number(m[2]) + CHUNK, SIZE - 1);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${SIZE}`,
      'Content-Length': e - s + 1,
    });
    res.end(data.subarray(s, e + 1));
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 502, 'the over-long chunk is rejected, not relayed');
  });
});

// --- redirects -------------------------------------------------------------------

test('a redirect chain of five is followed to the media', async () => {
  // Five redirects, then the media. "Follow at most 5 redirects"
  // must still fetch the URL the fifth redirect points at.
  const hops = { '/c0': '/c1', '/c1': '/c2', '/c2': '/c3', '/c3': '/c4', '/c4': '/media' };
  const up = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (hops[pathname]) {
      res.writeHead(302, { Location: hops[pathname] });
      res.end();
      return;
    }
    serveHonest(req, res);
  });
  await withProxy(up, { [VIDEO_ID]: '/c0' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, data);
  });
});

test('a redirect chain of six is refused promptly', async () => {
  const hops = {
    '/d0': '/d1', '/d1': '/d2', '/d2': '/d3',
    '/d3': '/d4', '/d4': '/d5', '/d5': '/media',
  };
  const up = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (hops[pathname]) {
      res.writeHead(302, { Location: hops[pathname] });
      res.end();
      return;
    }
    serveHonest(req, res);
  });
  await withProxy(up, { [VIDEO_ID]: '/d0' }, async (port) => {
    const r = await getExpectTimeout(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false, 'kikoeru must answer, not hang');
    assert.equal(r.status, 404, 'the probe never resolves, so no video');
  });
});

test('a redirect to a non-HTTP URL is refused cleanly and the server stays up', async () => {
  const up = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/trap') {
      if (isProbe(req)) return serveHonest(req, res);
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    serveHonest(req, res);
  });
  await withProxy(
    up,
    { [VIDEO_ID]: '/trap', [SECOND_ID]: '/media' },
    async (port) => {
      const r = await getExpectTimeout(port, `/${TOKEN}/${VIDEO_ID}`);
      assert.equal(r.timedOut, false, 'kikoeru must answer, not hang');
      assert.equal(r.status, 502);
      const ok = await get(port, `/${TOKEN}/${SECOND_ID}`, {
        Range: 'bytes=0-9',
      });
      assert.equal(ok.status, 206, 'the server still serves other videos');
      assert.deepEqual(ok.body, data.subarray(0, 10));
    },
  );
});

// --- upstream status and probe shapes ----------------------------------------------

test('an upstream that answers a range request with 200 is refused, not relayed', async () => {
  // A plain 200 to a ranged request means the server ignored the
  // Range header; relaying it as a chunk would corrupt every
  // offset. The probe fails, the retry fails, the answer is 404.
  const up = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mp4',
      'Content-Length': SIZE,
    });
    res.end(data);
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('a probe whose Content-Range has no total size gets 404', async () => {
  const up = http.createServer((req, res) => {
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': 'bytes 0-0/*',
      'Content-Length': 1,
    });
    res.end(data.subarray(0, 1));
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('a probe without a Content-Range gets 404', async () => {
  const up = http.createServer((req, res) => {
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Length': 1,
    });
    res.end(data.subarray(0, 1));
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

// --- chunk bodies that end early -----------------------------------------------------

test('chunks that end empty every time cut the response instead of looping or lying', async () => {
  // Every data chunk ends cleanly with zero bytes despite a
  // Content-Range promising the full chunk. The resume budget is
  // finite: the response must be cut promptly, never loop forever
  // and never pretend the body arrived. Because not one byte is
  // ever written, the buffered response headers never reach the
  // wire either: the client sees the connection close with no
  // response at all, which is the detectable truncation here.
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const s = Number(m[1]);
    const e = Number(m[2]);
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${SIZE}`,
      'Content-Length': 0,
    });
    res.end();
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await getRawWire(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.timedOut, false, 'kikoeru must end the response, not hang');
    assert.equal(r.status, null, 'no response ever reached the wire');
    assert.equal(r.body.length, 0);
  });
});

test('a first chunk that ends short but cleanly is resumed at the missing byte', async () => {
  // The first chunk's first attempt ends cleanly after half its
  // bytes (its Content-Length admits it; the Content-Range does
  // not). The byte count exposes the shortfall and the relay
  // resumes at exactly the first missing byte.
  let dataAttempts = 0;
  const up = http.createServer((req, res) => {
    if (isProbe(req)) return serveHonest(req, res);
    dataAttempts++;
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const s = Number(m[1]);
    const e = Number(m[2]);
    if (dataAttempts === 1) {
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': `bytes ${s}-${e}/${SIZE}`,
        'Content-Length': 512,
      });
      res.end(data.subarray(s, s + 512));
      return;
    }
    serveHonest(req, res);
  });
  await withProxy(up, { [VIDEO_ID]: '/media' }, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, data);
  });
});
