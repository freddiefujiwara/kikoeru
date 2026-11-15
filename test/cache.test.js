'use strict';

// The batch cache is the only source of stream URLs. These tests pin
// down how the server judges it: an entry is relayed while its URL is
// unexpired (the URL's own `expire` parameter decides; without one,
// the extraction time plus 6 hours does), missing / expired / broken
// caches are a plain 404, and the server never falls over on a bad
// file. resolveStreamUrl is also unit-tested directly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createServer,
  resolveStreamUrl,
  FALLBACK_FRESH_SEC,
  EXPIRY_MARGIN_SEC,
} = require('../src/server');
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
const SIZE = 4096;
const data = makeData(SIZE);

let upstream;
let upPort;
let tmp;

before(async () => {
  const up = makeMediaUpstream(data);
  upstream = up.server;
  upPort = await listen(upstream);
  tmp = tmpDir();
});

after(async () => {
  await close(upstream);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Start a throwaway kikoeru whose batch cache is `cacheFile`, run `fn`
// against its port, and always close it.
async function withServer(cacheFile, fn) {
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

function cacheWith(entry) {
  const file = path.join(
    tmp,
    `cache-${Math.random().toString(36).slice(2)}.json`,
  );
  writeCache(file, { [VIDEO_ID]: entry });
  return file;
}

function goodEntry(ts) {
  return { url: `http://127.0.0.1:${upPort}/media`, ts };
}

// An entry whose URL carries an `expire` parameter, like a real
// googlevideo URL. The fake upstream serves /media regardless of the
// query string; only kikoeru's freshness judgment reads the value.
function expiringEntry(ts, expire) {
  return { url: `http://127.0.0.1:${upPort}/media?expire=${expire}`, ts };
}

test('fresh entry (just written) is relayed', async () => {
  await withServer(cacheWith(goodEntry(nowSec())), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
    assert.deepEqual(r.body, data.subarray(0, 10));
  });
});

test('entry just inside the fallback freshness window is relayed', async () => {
  const ts = nowSec() - FALLBACK_FRESH_SEC + 120; // 2 minutes of margin
  await withServer(cacheWith(goodEntry(ts)), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
  });
});

test('entry just past the fallback freshness window gets 404', async () => {
  const ts = nowSec() - FALLBACK_FRESH_SEC - 120; // 2 minutes of margin
  await withServer(cacheWith(goodEntry(ts)), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('stale batch cache entry gets 404', async () => {
  const ts = nowSec() - FALLBACK_FRESH_SEC - 120; // older than 6 h
  await withServer(cacheWith(goodEntry(ts)), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-99',
    });
    assert.equal(r.status, 404);
  });
});

// --- expiry-based judgment (the URL's own `expire` parameter) --------

test('old entry is still relayed while its URL is unexpired', async () => {
  // Extracted more than 5 hours ago (past the old fixed window), but
  // the URL itself stays valid for another 30 minutes.
  const entry = expiringEntry(nowSec() - 5 * 3600 - 600, nowSec() + 1800);
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
    assert.deepEqual(r.body, data.subarray(0, 10));
  });
});

test('fresh entry gets 404 once its URL has expired', async () => {
  const entry = expiringEntry(nowSec(), nowSec() - 60);
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('URL expiring within the safety margin gets 404', async () => {
  const entry = expiringEntry(nowSec(), nowSec() + EXPIRY_MARGIN_SEC - 30);
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('URL expiring just beyond the safety margin is relayed', async () => {
  const entry = expiringEntry(nowSec(), nowSec() + EXPIRY_MARGIN_SEC + 120);
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
  });
});

test('unparseable expire falls back to the timestamp window (fresh)', async () => {
  const entry = {
    url: `http://127.0.0.1:${upPort}/media?expire=abc`,
    ts: nowSec(),
  };
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`, {
      Range: 'bytes=0-9',
    });
    assert.equal(r.status, 206);
  });
});

test('unparseable expire falls back to the timestamp window (stale)', async () => {
  const entry = {
    url: `http://127.0.0.1:${upPort}/media?expire=abc`,
    ts: nowSec() - FALLBACK_FRESH_SEC - 120,
  };
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('empty batch cache gets 404 for every video', async () => {
  const file = path.join(tmp, 'cache-empty.json');
  writeCache(file, {});
  await withServer(file, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('missing batch cache file gets 404 and the server stays up', async () => {
  const file = path.join(tmp, 'cache-does-not-exist.json');
  await withServer(file, async (port) => {
    const r1 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r1.status, 404);
    // A second request proves the server did not crash on the bad file.
    const r2 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r2.status, 404);
  });
});

test('batch cache with broken JSON gets 404 and the server stays up', async () => {
  const file = path.join(tmp, 'cache-broken.json');
  fs.writeFileSync(file, '{ this is not json');
  await withServer(file, async (port) => {
    const r1 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r1.status, 404);
    const r2 = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r2.status, 404);
  });
});

test('batch cache that is an empty file gets 404', async () => {
  const file = path.join(tmp, 'cache-zero.json');
  fs.writeFileSync(file, '');
  await withServer(file, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('batch cache that is a JSON array gets 404', async () => {
  const file = path.join(tmp, 'cache-array.json');
  fs.writeFileSync(file, '[]');
  await withServer(file, async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('entry without a url gets 404', async () => {
  await withServer(cacheWith({ ts: nowSec() }), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

test('entry without a timestamp is treated as stale and gets 404', async () => {
  const entry = { url: `http://127.0.0.1:${upPort}/media` };
  await withServer(cacheWith(entry), async (port) => {
    const r = await get(port, `/${TOKEN}/${VIDEO_ID}`);
    assert.equal(r.status, 404);
  });
});

// --- resolveStreamUrl unit tests -------------------------------------------

test('resolveStreamUrl returns the url of a fresh entry', () => {
  const file = cacheWith(goodEntry(nowSec()));
  const url = resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID);
  assert.equal(url, `http://127.0.0.1:${upPort}/media`);
});

test('resolveStreamUrl returns null for an unknown id', () => {
  const file = cacheWith(goodEntry(nowSec()));
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, 'AAAAAAAAAAA'), null);
});

test('resolveStreamUrl returns null when the file cannot be read', () => {
  const file = path.join(tmp, 'no-such-cache.json');
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID), null);
});

test('resolveStreamUrl serves an old entry whose URL is unexpired', () => {
  const entry = expiringEntry(nowSec() - 5 * 3600 - 600, nowSec() + 1800);
  const file = cacheWith(entry);
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID), entry.url);
});

test('resolveStreamUrl returns null for a fresh entry whose URL expired', () => {
  const entry = expiringEntry(nowSec(), nowSec() - 60);
  const file = cacheWith(entry);
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID), null);
});

test('resolveStreamUrl honours an expiryMarginSec override', () => {
  // The URL stays valid for another 30 minutes: fine with the
  // default 60-second margin, unusable with a 1-hour margin.
  const entry = expiringEntry(nowSec(), nowSec() + 1800);
  const file = cacheWith(entry);
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID), entry.url);
  assert.equal(
    resolveStreamUrl({ batchCacheFile: file, expiryMarginSec: 3600 }, VIDEO_ID),
    null,
  );
});

test('resolveStreamUrl honours a fallbackFreshSec override', () => {
  // Extracted 1 hour ago, no expire parameter: fine with the
  // default 6-hour window, stale with a 30-minute window.
  const entry = goodEntry(nowSec() - 3600);
  const file = cacheWith(entry);
  assert.equal(resolveStreamUrl({ batchCacheFile: file }, VIDEO_ID), entry.url);
  assert.equal(
    resolveStreamUrl({ batchCacheFile: file, fallbackFreshSec: 1800 }, VIDEO_ID),
    null,
  );
});
