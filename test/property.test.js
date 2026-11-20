'use strict';

// Property-based tests (fast-check). The pure parsers are checked
// over generated inputs: they must never throw, and whatever they
// return must stay inside the file. The streaming property is the
// core invariant of the whole server, exercised end to end: for a
// generated payload and a generated script of upstream faults
// (socket drops, clean-but-short chunks, over-long chunks, 500s,
// 403s), the bytes the client receives are always a prefix of the
// source — complete and exact when the response completes, a
// strict prefix when it is cut — and never more bytes than the
// Content-Length the relay declared.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const {
  createServer,
  parseRange,
  urlExpirySec,
  normalizeConfig,
  resolveStreamUrl,
} = require('../src/server');
const {
  listen,
  close,
  getRawWire,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
} = require('./helpers');

const TOKEN = '0123456789abcdef0123456789abcdef';

// --- parseRange ------------------------------------------------------------------

const sizeArb = fc.integer({ min: 1, max: 100_000 });

test('property: parseRange never throws and stays inside the file', () => {
  const part = fc.oneof(
    fc.constant(''),
    fc.nat({ max: 200_000 }).map(String),
    fc.constantFrom('007', '00', '0'),
  );
  fc.assert(
    fc.property(sizeArb, part, part, (size, a, b) => {
      const r = parseRange(`bytes=${a}-${b}`, size);
      if (r === null || r === 'unsatisfiable') return;
      assert.ok(
        r.start >= 0 && r.start <= r.end && r.end < size,
        `out of bounds: ${JSON.stringify(r)} for size ${size}`,
      );
    }),
    { numRuns: 100 },
  );
});

test('property: parseRange returns in-range requests exactly', () => {
  fc.assert(
    fc.property(
      sizeArb.chain((size) =>
        fc.record({
          size: fc.constant(size),
          start: fc.integer({ min: 0, max: size - 1 }),
        }),
      ).chain(({ size, start }) =>
        fc.record({
          size: fc.constant(size),
          start: fc.constant(start),
          end: fc.integer({ min: start, max: size - 1 }),
        }),
      ),
      ({ size, start, end }) => {
        assert.deepEqual(parseRange(`bytes=${start}-${end}`, size), {
          start,
          end,
        });
      },
    ),
    { numRuns: 100 },
  );
});

test('property: parseRange clamps an end past the file to the last byte', () => {
  fc.assert(
    fc.property(
      sizeArb,
      fc.integer({ min: 0, max: 99_999 }),
      fc.integer({ min: 1, max: 100_000 }),
      (size, startRaw, extra) => {
        const start = startRaw % size;
        const end = size - 1 + extra;
        assert.deepEqual(parseRange(`bytes=${start}-${end}`, size), {
          start,
          end: size - 1,
        });
      },
    ),
    { numRuns: 100 },
  );
});

test('property: parseRange suffix ranges take exactly the tail', () => {
  fc.assert(
    fc.property(sizeArb, fc.integer({ min: 1, max: 100_000 }), (size, nRaw) => {
      const n = ((nRaw - 1) % size) + 1; // 1..size
      assert.deepEqual(parseRange(`bytes=-${n}`, size), {
        start: size - n,
        end: size - 1,
      });
      // A suffix longer than the file is the whole file.
      assert.deepEqual(parseRange(`bytes=-${size + nRaw}`, size), {
        start: 0,
        end: size - 1,
      });
    }),
    { numRuns: 100 },
  );
});

// --- urlExpirySec ------------------------------------------------------------------

test('property: urlExpirySec never throws and returns null or a positive integer', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.webUrl(),
        fc.constantFrom(
          'http://127.0.0.1:9/media?expire=',
          'http://127.0.0.1:9/media?expire=abc',
          'http://127.0.0.1:9/media?expire=-1',
          'http://127.0.0.1:9/media?expire=0',
          'http://127.0.0.1:9/media?expire=1e999',
          'not a url at all',
          '',
        ),
      ),
      (raw) => {
        const r = urlExpirySec(raw);
        assert.ok(
          r === null || (Number.isInteger(r) && r > 0),
          `unexpected expiry: ${r}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test('property: urlExpirySec reads back a generated expire parameter', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1_700_000_000, max: 4_102_444_800 }),
      (exp) => {
        assert.equal(
          urlExpirySec(`http://127.0.0.1:9/media?foo=1&expire=${exp}&bar=2`),
          exp,
        );
      },
    ),
    { numRuns: 100 },
  );
});

// --- normalizeConfig -----------------------------------------------------------------

// The knob domain is what loadConfig can produce (environment
// strings) plus numeric literals in a hand-built config: scalars.
// Object values are operator code, not data, and are out of domain
// here (the altd sweep drew the same line for its registry).
test('property: normalizeConfig always yields usable knobs for scalar junk', () => {
  const scalar = fc.oneof(
    fc.double(),
    fc.integer(),
    fc.string(),
    fc.boolean(),
    fc.constantFrom(null, undefined, NaN, Infinity, -Infinity),
  );
  fc.assert(
    fc.property(
      fc.record({
        chunkSize: scalar,
        fallbackFreshSec: scalar,
        expiryMarginSec: scalar,
        metaTtlMs: scalar,
      }),
      (raw) => {
        const c = normalizeConfig(raw);
        assert.ok(Number.isInteger(c.chunkSize) && c.chunkSize >= 1);
        for (const k of ['fallbackFreshSec', 'expiryMarginSec', 'metaTtlMs']) {
          assert.ok(
            Number.isFinite(c[k]) && c[k] > 0,
            `${k} not a usable knob: ${c[k]}`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

// --- shared fixtures for the file-backed and streaming properties ----------------------

let tmp;
let boundaryCache;
let faultUpstreamPort;

before(() => {
  tmp = tmpDir();
  boundaryCache = path.join(tmp, 'boundary-cache.json');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- resolveStreamUrl: the expiry boundary ---------------------------------------------

test('property: resolveStreamUrl serves exactly while the URL is outside the expiry margin', () => {
  fc.assert(
    fc.property(fc.integer({ min: -3600, max: 3600 }), (delta) => {
      // Guard band around the 60 s margin: the server's clock and
      // the generator's clock can disagree by a second.
      fc.pre(delta > 70 || delta < 50);
      const url = `http://127.0.0.1:9/media?expire=${nowSec() + delta}`;
      // An old extraction time: only the expire parameter can save
      // this entry, so the assertion isolates the expiry path.
      writeCache(boundaryCache, {
        AAAAAAAAAAA: { url, ts: nowSec() - 100_000 },
      });
      const got = resolveStreamUrl(
        { batchCacheFile: boundaryCache, expiryMarginSec: 60 },
        'AAAAAAAAAAA',
      );
      if (delta > 70) assert.equal(got, url);
      else assert.equal(got, null);
    }),
    { numRuns: 100 },
  );
});

// --- streaming: byte exactness under generated fault scripts ---------------------------

const STREAM_CHUNK = 512;

let faultData = null; // payload of the current run
let faultScript = []; // one fault per data (non-probe) attempt
let faultAttempts = 0;
let faultUpstream;
let faultProxy;
let faultProxyPort;
let streamCache;
let runCounter = 0;

function serveFaultRange(req, res) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(416);
    res.end();
    return;
  }
  const s = Number(m[1]);
  const e = Number(m[2]);
  const total = faultData.length;
  const slice = faultData.subarray(s, e + 1);
  const honest = () => {
    res.writeHead(206, {
      'Content-Type': 'audio/mp4',
      'Content-Range': `bytes ${s}-${e}/${total}`,
      'Content-Length': e - s + 1,
    });
    res.end(slice);
  };
  // The 1-byte probe always answers honestly: metadata resolution
  // has its own suites; this property is about the byte stream.
  // (Payloads are >= 1024 bytes and chunks are 512, so no data
  // chunk is ever the 0-0 probe range.)
  if (s === 0 && e === 0) return honest();
  const f = faultScript[faultAttempts++] || { kind: 'ok' };
  switch (f.kind) {
    case 'status':
      res.writeHead(f.status);
      res.end();
      return;
    case 'drop': {
      // Deliver the first `at` bytes, then the socket dies.
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': `bytes ${s}-${e}/${total}`,
        'Content-Length': e - s + 1,
      });
      const k = Math.min(f.at, slice.length);
      if (k === 0) {
        res.socket.destroy();
        return;
      }
      res.write(slice.subarray(0, k), () => res.socket.destroy());
      return;
    }
    case 'short': {
      // End cleanly after `at` bytes; the Content-Range still
      // promises the whole chunk, the Content-Length admits less.
      const k = Math.min(f.at, slice.length);
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': `bytes ${s}-${e}/${total}`,
        'Content-Length': k,
      });
      res.end(slice.subarray(0, k));
      return;
    }
    case 'over': {
      // The whole slice plus garbage, chunked (no Content-Length).
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': `bytes ${s}-${e}/${total}`,
      });
      res.end(Buffer.concat([slice, Buffer.alloc(f.extra, 0xee)]));
      return;
    }
    default:
      return honest();
  }
}

before(async () => {
  faultUpstream = http.createServer(serveFaultRange);
  faultUpstreamPort = await listen(faultUpstream);
  streamCache = path.join(tmp, 'stream-cache.json');
  writeCache(streamCache, {});
  faultProxy = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    tokenFile: path.join(tmp, 'stream-token'),
    batchCacheFile: streamCache,
    chunkSize: STREAM_CHUNK,
  });
  faultProxyPort = await listen(faultProxy);
});

after(async () => {
  await close(faultProxy);
  await close(faultUpstream);
});

const faultArb = fc.oneof(
  fc.constant({ kind: 'ok' }),
  fc.constant({ kind: 'ok' }),
  fc.constant({ kind: 'ok' }),
  fc.record({ kind: fc.constant('drop'), at: fc.integer({ min: 0, max: 600 }) }),
  fc.record({ kind: fc.constant('short'), at: fc.integer({ min: 0, max: 600 }) }),
  fc.record({
    kind: fc.constant('over'),
    extra: fc.integer({ min: 1, max: 64 }),
  }),
  fc.constant({ kind: 'status', status: 500 }),
  fc.constant({ kind: 'status', status: 403 }),
);

test('property: emitted bytes are always an exact prefix of the source, whatever the upstream does', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1024, max: 3000 }),
      fc.array(faultArb, { maxLength: 6 }),
      async (size, script) => {
        faultData = makeData(size);
        faultScript = script;
        faultAttempts = 0;
        runCounter += 1;
        const id = `fc${String(runCounter).padStart(9, '0')}`;
        writeCache(streamCache, {
          [id]: {
            url: `http://127.0.0.1:${faultUpstreamPort}/media`,
            ts: nowSec(),
          },
        });
        const r = await getRawWire(faultProxyPort, `/${TOKEN}/${id}`);
        assert.equal(r.timedOut, false, 'the relay must always answer');
        if (r.status === 200) {
          assert.ok(
            r.body.length <= r.contentLength,
            `emitted ${r.body.length} bytes against a declared ${r.contentLength}`,
          );
          assert.ok(
            faultData.subarray(0, r.body.length).equals(r.body),
            'emitted bytes are not a prefix of the source',
          );
          // Completeness (body length == declared length) plus the
          // prefix check together mean the body equals the source.
        } else {
          assert.equal(
            r.status,
            502,
            `unexpected status ${r.status} (a refusal must be a clean 502)`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
