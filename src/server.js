'use strict';

/**
 * kikoeru: a streaming relay for YouTube audio.
 *
 * Clients (e.g. a phone browser) that play a googlevideo audio URL directly
 * are throttled to roughly the playback bitrate when they fetch the file
 * sequentially. The same URL answers ranged requests at full speed, but a
 * single large range is throttled again, so this server fetches the upstream
 * stream in small (<= 4 MiB) ranged chunks and forwards the bytes as they
 * arrive. Nothing is stored on disk.
 *
 * Route: GET /<token>/<videoId>  (served at the root of the public host)
 *   - token: shared secret read from a token file (generated on first run).
 *   - videoId: 11-char YouTube video id.
 *
 * Stream URL resolution is NOT this server's job. Extracting stream URLs
 * with yt-dlp belongs to the shell pipeline (yt-audio / yt-audio-batch);
 * this server only reads its cache (~/.yt-audio/cache.json) and relays:
 *   - entry present and its URL not yet expired -> relay that URL.
 *     (The URL's own `expire` parameter decides; a URL without one is
 *     used until 6 h after its extraction time.)
 *   - entry missing or expired -> 404 (the shell refreshes it on its cycle).
 * If the upstream answers 403 (URL expired server-side), the batch cache
 * is re-read once (the shell may have refreshed it in the meantime) and
 * the request is retried; if that still fails, the answer is 404. The
 * probe is retried the same way on any other failure (a timeout, a
 * 5xx), and when even the retry fails, the last metadata probed for
 * the video is served stale rather than answering 404: its size and
 * type do not change, and a stream URL that died in the meantime
 * still surfaces as a 403 on the chunk fetch, which the retry path
 * handles.
 *
 * Redirects are followed for every chunk request, not just the probe:
 * googlevideo redirects data chunks too, and an unfollowed redirect
 * used to cut the stream at that chunk boundary. A chunk that still
 * fails partway through is resumed from the first byte the client is
 * missing, after re-resolving the stream URL; only when the resume
 * also fails is the response cut short.
 *
 * A failure while streaming is always answered, never left hanging:
 * before the response is committed the client gets a 502, and once
 * bytes are flowing the response is cut short instead.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CHUNK_SIZE = 4 * 1024 * 1024; // upstream sub-range size
const MAX_STREAM_RECOVERIES = 2; // consecutive resumes per chunk position
const FALLBACK_FRESH_SEC = 6 * 3600; // no expire param: ts + 6 h decides
const EXPIRY_MARGIN_SEC = 60; // stop serving this long before a URL expires
const META_TTL_MS = 50 * 60 * 1000; // resolved size/type/final-URL cache
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROUTE_RE = /^\/([^/]+)\/([^/]+)$/;

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInt(raw, fallback) {
  return Math.max(1, Math.floor(positiveNumber(raw, fallback)));
}

/**
 * Fill the numeric knobs of a config object with validated values.
 * loadConfig feeds it the raw environment strings; createServer and
 * resolveStreamUrl run it too, so a hand-built config object gets
 * the same treatment. Anything that is not a positive number falls
 * back to the built-in default, so a typo can never change the
 * behaviour silently.
 */
function normalizeConfig(cfg) {
  const c = cfg || {};
  return {
    ...c,
    chunkSize: positiveInt(c.chunkSize, CHUNK_SIZE),
    fallbackFreshSec: positiveNumber(c.fallbackFreshSec, FALLBACK_FRESH_SEC),
    expiryMarginSec: positiveNumber(c.expiryMarginSec, EXPIRY_MARGIN_SEC),
    metaTtlMs: positiveNumber(c.metaTtlMs, META_TTL_MS),
  };
}

function loadConfig(env = process.env) {
  const home = os.homedir();
  return normalizeConfig({
    host: env.KIKOERU_HOST || '127.0.0.1',
    port: Number(env.KIKOERU_PORT || 8791),
    token: env.KIKOERU_TOKEN || null,
    tokenFile:
      env.KIKOERU_TOKEN_FILE || path.join(home, '.config/kikoeru/token'),
    batchCacheFile:
      env.YT_AUDIO_CACHE || path.join(home, '.yt-audio/cache.json'),
    chunkSize: env.KIKOERU_CHUNK_SIZE,
    fallbackFreshSec: env.KIKOERU_FALLBACK_FRESH_SEC,
    expiryMarginSec: env.KIKOERU_EXPIRY_MARGIN_SEC,
    metaTtlMs: env.KIKOERU_META_TTL_MS,
  });
}

function ensureToken(cfg) {
  if (cfg.token) return cfg.token;
  try {
    const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    if (t) return t;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(cfg.tokenFile), { recursive: true });
  fs.writeFileSync(cfg.tokenFile, token + '\n', { mode: 0o600 });
  return token;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The expiry (epoch seconds) a googlevideo stream URL carries in its
 * `expire` query parameter, or null when the URL has none that parses.
 */
function urlExpirySec(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get('expire');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Resolve a still-usable stream URL for the video from the shell
 * pipeline's batch cache, or null. This server never extracts URLs
 * itself (no yt-dlp, no cache of its own).
 *
 * Usability follows the URL itself: googlevideo URLs carry an
 * `expire` parameter (epoch seconds, roughly 6 h after extraction)
 * and are served until just before that moment. URLs without a
 * parseable `expire` fall back to the extraction timestamp plus
 * FALLBACK_FRESH_SEC.
 */
function resolveStreamUrl(cfg, videoId) {
  const c = normalizeConfig(cfg);
  const batch = readJsonFile(c.batchCacheFile);
  const entry = batch && batch[videoId];
  if (!entry || !entry.url) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = urlExpirySec(entry.url);
  if (exp !== null) {
    return now < exp - c.expiryMarginSec ? entry.url : null;
  }
  const ts = entry.ts || 0;
  if (!ts || now - ts >= c.fallbackFreshSec) return null;
  return entry.url;
}

function openUpstream(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers }, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('upstream timeout')));
  });
}

function expiredError() {
  const e = new Error('upstream returned 403 (stream URL expired)');
  e.code = 'UPSTREAM_EXPIRED';
  return e;
}

/**
 * Open one ranged chunk, following redirects manually. Every upstream
 * request carries a Range header: automatic redirect handlers tend to
 * drop it, and a plain GET would both lose the range and hit the
 * throttled path. The probe and the data chunks share this, because
 * googlevideo redirects both. Returns the response together with the
 * URL that finally answered, so later chunks can go straight there.
 */
async function openChunk(startUrl, start, end) {
  let url = startUrl;
  for (let i = 0; i < 5; i++) {
    const res = await openUpstream(url, { Range: `bytes=${start}-${end}` });
    const status = res.statusCode || 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      url = new URL(location, url).toString();
      continue;
    }
    if (status === 403) {
      res.destroy();
      throw expiredError();
    }
    if (status !== 206) {
      res.destroy();
      throw new Error(`unexpected chunk status ${status}`);
    }
    return { res, finalUrl: url };
  }
  throw new Error('too many redirects');
}

/**
 * Probe total size and content type with a 1-byte range request.
 * Returns the final URL along with the metadata.
 */
async function probeMeta(startUrl) {
  const { res, finalUrl } = await openChunk(startUrl, 0, 0);
  const cr = res.headers['content-range'] || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  const contentType = res.headers['content-type'] || 'audio/x-m4a';
  res.destroy();
  if (!m) throw new Error(`no total size in Content-Range: ${cr}`);
  return { finalUrl, size: Number(m[1]), contentType };
}

async function getMeta(cfg, state, videoId, force = false) {
  if (!force) {
    const hit = state.meta.get(videoId);
    if (hit && Date.now() - hit.at < cfg.metaTtlMs) return hit;
  }
  const url = resolveStreamUrl(cfg, videoId);
  if (!url) return null;
  let probed;
  try {
    probed = await probeMeta(url);
  } catch (e) {
    if (!force) {
      // Re-read the batch cache once and retry, whatever the error
      // was: on a 403 the shell may have refreshed the URL, and on a
      // transient failure (a timeout, a 5xx) the second attempt
      // often answers even with the same URL.
      return getMeta(cfg, state, videoId, true);
    }
    throw e;
  }
  const meta = { ...probed, at: Date.now() };
  state.meta.set(videoId, meta);
  return meta;
}

/** Parse a single Range header against the total size. */
function parseRange(header, size) {
  if (!header) return null; // full body
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // unparseable: serve the full body
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

function tokenMatches(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(cfg, state, token, req, res) {
  const m = ROUTE_RE.exec(req.url || '');
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
    return;
  }
  const [, givenToken, videoId] = m;
  if (!tokenMatches(givenToken, token) || !VIDEO_ID_RE.test(videoId)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  let retried = false;
  for (;;) {
    let meta;
    try {
      meta = await getMeta(cfg, state, videoId, retried);
    } catch (e) {
      console.error(`[kikoeru] meta failed for ${videoId}: ${e.message}`);
      meta = null;
    }
    if (!meta) {
      // Fall back to the last metadata this process probed, however
      // old: a video's size and type do not change, and if its stream
      // URL has died since, the chunk fetch below surfaces that as a
      // 403 the retry path already handles. A probe outage must not
      // turn a playable video into a 404.
      meta = state.meta.get(videoId) || null;
      if (meta) {
        console.error(`[kikoeru] serving stale meta for ${videoId}`);
      }
    }
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    const range = parseRange(req.headers.range, meta.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'Content-Range': `bytes */${meta.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : meta.size - 1;
    const headers = {
      'Content-Type': meta.contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
    if (req.method === 'HEAD') {
      res.writeHead(range ? 206 : 200, headers);
      res.end();
      return;
    }
    // Fetch the first chunk before committing to a status line, so an
    // expired upstream URL can be retried once against a freshly
    // re-read batch cache.
    const tracker = { committed: false, wrote: false };
    // Re-resolve the stream URL from the batch cache (the shell may
    // have refreshed it) for a mid-stream resume; null when the cache
    // has nothing usable.
    const refresh = async () => {
      state.meta.delete(videoId);
      try {
        const m = await getMeta(cfg, state, videoId, true);
        return m ? m.finalUrl : null;
      } catch {
        return null;
      }
    };
    try {
      const firstEnd = Math.min(start + cfg.chunkSize - 1, end);
      const first = await openChunk(meta.finalUrl, start, firstEnd);
      tracker.committed = true;
      res.writeHead(range ? 206 : 200, headers);
      const counter = { n: 0 };
      let gone = false;
      try {
        gone = await writeBody(first.res, res, tracker, counter);
      } catch {
        // The first chunk died partway; streamRange below resumes
        // from the first byte the client is missing.
      }
      if (gone || res.destroyed || res.writableEnded) return;
      const restStart = start + counter.n;
      if (restStart <= end) {
        await streamRange({
          url: first.finalUrl,
          refresh,
          start: restStart,
          end,
          res,
          tracker,
          chunkSize: cfg.chunkSize,
        });
      }
      res.end();
      return;
    } catch (e) {
      if (e.code === 'UPSTREAM_EXPIRED' && !tracker.wrote && !retried) {
        state.meta.delete(videoId);
        retried = true;
        continue;
      }
      if (e.code !== 'UPSTREAM_EXPIRED') {
        console.error(`[kikoeru] stream failed for ${videoId}: ${e.message}`);
      }
      if (!tracker.committed && !res.headersSent && !res.writableEnded) {
        // Nothing has been sent to the client yet, so the failure can
        // still be answered honestly: 502, promptly, instead of
        // leaving the request hanging until the client gives up.
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('bad gateway\n');
      } else if (!res.writableEnded) {
        // The status line (and possibly part of the body) is already
        // out, so no error status can be sent. Cut the response so
        // the client is not left waiting for bytes that never come.
        res.destroy();
      }
      return;
    }
  }
}

/**
 * Write an upstream body to the client, counting the bytes into
 * counter.n. The count stays accurate even when the upstream dies
 * partway and the iteration throws, so the caller knows exactly
 * which byte to resume from. Returns true when the client went away
 * mid-write and the caller should stop quietly.
 */
async function writeBody(up, res, tracker, counter) {
  for await (const buf of up) {
    if (res.destroyed || res.writableEnded) {
      up.destroy();
      return true;
    }
    tracker.wrote = true;
    counter.n += buf.length;
    if (!res.write(buf)) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }
  return false;
}

/**
 * Stream [start, end] in chunkSize pieces. A chunk that fails (an
 * upstream error, or a body that ends short) is resumed from the
 * first byte the client is missing: refresh() re-resolves the stream
 * URL and the chunk is retried from that offset. After
 * MAX_STREAM_RECOVERIES consecutive failures at the same position
 * the error is thrown, and the caller cuts the response.
 */
async function streamRange({ url, refresh, start, end, res, tracker, chunkSize }) {
  let pos = start;
  let current = url;
  let recoveries = 0;
  while (pos <= end) {
    if (res.destroyed || res.writableEnded) return;
    const chunkEnd = Math.min(pos + chunkSize - 1, end);
    const counter = { n: 0 };
    try {
      const chunk = await openChunk(current, pos, chunkEnd);
      current = chunk.finalUrl;
      const gone = await writeBody(chunk.res, res, tracker, counter);
      if (gone || res.destroyed || res.writableEnded) return;
      if (counter.n !== chunkEnd - pos + 1) {
        throw new Error(
          `short chunk at ${pos}: got ${counter.n} of ${chunkEnd - pos + 1} bytes`,
        );
      }
    } catch (e) {
      pos += counter.n;
      if (pos > chunkEnd) {
        // The whole chunk arrived despite the error; move on.
        recoveries = 0;
        continue;
      }
      if (recoveries >= MAX_STREAM_RECOVERIES) throw e;
      const fresh = await refresh();
      if (!fresh) throw e;
      recoveries += 1;
      current = fresh;
      continue;
    }
    pos = chunkEnd + 1;
    recoveries = 0;
  }
}

function createServer(cfg) {
  const full = normalizeConfig(cfg);
  const token = ensureToken(full);
  const state = { meta: new Map() };
  const server = http.createServer((req, res) => {
    handle(full, state, token, req, res).catch((e) => {
      console.error(`[kikoeru] handler error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end();
    });
  });
  return server;
}

module.exports = {
  createServer,
  loadConfig,
  normalizeConfig,
  ensureToken,
  parseRange,
  resolveStreamUrl,
  urlExpirySec,
  CHUNK_SIZE,
  FALLBACK_FRESH_SEC,
  EXPIRY_MARGIN_SEC,
  META_TTL_MS,
};
