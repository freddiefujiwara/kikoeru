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
 * Route: GET /<token>/<videoId>  (served at the root of https://y.ze.gs/)
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
 * the request is retried; if that still fails, the answer is 404.
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
const FALLBACK_FRESH_SEC = 6 * 3600; // no expire param: ts + 6 h decides
const EXPIRY_MARGIN_SEC = 60; // stop serving this long before a URL expires
const META_TTL_MS = 50 * 60 * 1000; // resolved size/type/final-URL cache
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROUTE_RE = /^\/([^/]+)\/([^/]+)$/;

function loadConfig(env = process.env) {
  const home = os.homedir();
  return {
    host: env.KIKOERU_HOST || '127.0.0.1',
    port: Number(env.KIKOERU_PORT || 8791),
    token: env.KIKOERU_TOKEN || null,
    tokenFile:
      env.KIKOERU_TOKEN_FILE || path.join(home, '.config/kikoeru/token'),
    batchCacheFile:
      env.YT_AUDIO_CACHE || path.join(home, '.yt-audio/cache.json'),
  };
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
  const batch = readJsonFile(cfg.batchCacheFile);
  const entry = batch && batch[videoId];
  if (!entry || !entry.url) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = urlExpirySec(entry.url);
  if (exp !== null) {
    return now < exp - EXPIRY_MARGIN_SEC ? entry.url : null;
  }
  const ts = entry.ts || 0;
  if (!ts || now - ts >= FALLBACK_FRESH_SEC) return null;
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
 * Probe total size and content type with a 1-byte range request, following
 * redirects manually. Every upstream request carries a Range header:
 * automatic redirect handlers tend to drop it, and a plain GET would both
 * lose the range and hit the throttled path. Returns the final URL along
 * with the metadata.
 */
async function probeMeta(startUrl) {
  let url = startUrl;
  for (let i = 0; i < 5; i++) {
    const res = await openUpstream(url, { Range: 'bytes=0-0' });
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
      throw new Error(`unexpected probe status ${status}`);
    }
    const cr = res.headers['content-range'] || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    const contentType = res.headers['content-type'] || 'audio/x-m4a';
    res.destroy();
    if (!m) throw new Error(`no total size in Content-Range: ${cr}`);
    return { finalUrl: url, size: Number(m[1]), contentType };
  }
  throw new Error('too many redirects');
}

async function getMeta(cfg, state, videoId, force = false) {
  if (!force) {
    const hit = state.meta.get(videoId);
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit;
  }
  const url = resolveStreamUrl(cfg, videoId);
  if (!url) return null;
  let probed;
  try {
    probed = await probeMeta(url);
  } catch (e) {
    if (e.code === 'UPSTREAM_EXPIRED' && !force) {
      // The shell may have refreshed the cache since we last read it;
      // re-read it once and retry before giving up with a 404.
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
    try {
      const firstEnd = Math.min(start + CHUNK_SIZE - 1, end);
      const up = await openUpstream(meta.finalUrl, {
        Range: `bytes=${start}-${firstEnd}`,
      });
      const status = up.statusCode || 0;
      if (status === 403) {
        up.destroy();
        throw expiredError();
      }
      if (status !== 206) {
        up.destroy();
        throw new Error(`unexpected chunk status ${status}`);
      }
      tracker.committed = true;
      res.writeHead(range ? 206 : 200, headers);
      for await (const buf of up) {
        if (res.destroyed || res.writableEnded) {
          up.destroy();
          return;
        }
        tracker.wrote = true;
        if (!res.write(buf)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      if (firstEnd < end) {
        await streamRest(meta.finalUrl, firstEnd + 1, end, res, tracker);
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

async function streamRest(finalUrl, start, end, res, tracker) {
  let pos = start;
  while (pos <= end) {
    if (res.destroyed || res.writableEnded) return;
    const chunkEnd = Math.min(pos + CHUNK_SIZE - 1, end);
    const up = await openUpstream(finalUrl, {
      Range: `bytes=${pos}-${chunkEnd}`,
    });
    const status = up.statusCode || 0;
    if (status === 403) {
      up.destroy();
      throw expiredError();
    }
    if (status !== 206) {
      up.destroy();
      throw new Error(`unexpected chunk status ${status}`);
    }
    for await (const buf of up) {
      if (res.destroyed || res.writableEnded) {
        up.destroy();
        return;
      }
      tracker.wrote = true;
      if (!res.write(buf)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    pos = chunkEnd + 1;
  }
}

function createServer(cfg) {
  const token = ensureToken(cfg);
  const state = { meta: new Map() };
  const server = http.createServer((req, res) => {
    handle(cfg, state, token, req, res).catch((e) => {
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
  ensureToken,
  parseRange,
  resolveStreamUrl,
  urlExpirySec,
  CHUNK_SIZE,
  FALLBACK_FRESH_SEC,
  EXPIRY_MARGIN_SEC,
};
