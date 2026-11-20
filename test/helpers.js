'use strict';

// Shared helpers for the kikoeru test suites. This file is not a test
// itself (it does not match the *.test.js glob); it only builds fake
// upstreams, temp dirs and small HTTP clients so every suite can stay
// off the real network.

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function request(port, p, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, headers, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function get(port, p, headers = {}) {
  return request(port, p, { headers });
}

// Resolves { timedOut: true } when no response arrives within `ms`.
// Used to prove that upstream errors are answered promptly: the
// caller asserts timedOut is false and checks the status.
function getExpectTimeout(port, p, headers = {}, ms = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => finish({ timedOut: false, status: res.statusCode }));
    });
    req.on('error', () => finish({ timedOut: false, error: true }));
    req.setTimeout(ms, () => {
      req.destroy();
      finish({ timedOut: true });
    });
  });
}

// Deterministic payload: byte i is i % 251, so any slice can be
// compared against the source buffer directly.
function makeData(size) {
  const d = Buffer.alloc(size);
  for (let i = 0; i < size; i++) d[i] = i % 251;
  return d;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kikoeru-test-'));
}

function writeCache(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * A fake googlevideo-like upstream. Serves `data` at /media with
 * single-range support, and /redir as a 302 to /media. Records every
 * request (url + Range header) in state.requests and counts requests
 * that arrived without a Range header in state.plainGets.
 */
function makeMediaUpstream(data, contentType = 'audio/mp4') {
  const state = { requests: [], plainGets: 0 };
  const server = http.createServer((req, res) => {
    const range = req.headers.range || null;
    state.requests.push({ url: req.url, range });
    if (!range) state.plainGets++;
    // Route on the pathname only: stream URLs may carry a query
    // string (e.g. ?expire=...) and must still reach /media.
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/redir') {
      res.writeHead(302, { Location: '/media' });
      res.end();
      return;
    }
    if (pathname !== '/media') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length,
      });
      res.end(data);
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    const s = Number(m[1]);
    const e = Number(m[2]);
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${s}-${e}/${data.length}`,
      'Content-Length': e - s + 1,
    });
    res.end(data.subarray(s, e + 1));
  });
  return { server, state };
}

// Parse a 'bytes=a-b' header into [start, end]; null when different.
function parseRangeHeader(range) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Raw HTTP/1.1 GET over a bare socket with Connection: close.
// Unlike request(), this reports the body bytes exactly as they
// arrived on the wire (de-chunked when the response is chunked), so
// a relay that emits MORE bytes than its declared Content-Length,
// or cuts the response short, is observable instead of being
// normalised away by the HTTP client. Resolves { status,
// contentLength, body, timedOut }; a response that never ends
// resolves with timedOut: true and whatever arrived.
function getRawWire(port, p, headers = {}, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks);
      const idx = raw.indexOf('\r\n\r\n');
      if (idx === -1) {
        resolve({ status: null, contentLength: null, body: raw, timedOut });
        return;
      }
      const head = raw.subarray(0, idx).toString('latin1');
      let body = raw.subarray(idx + 4);
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        const out = [];
        let rest = body;
        for (;;) {
          const eol = rest.indexOf('\r\n');
          if (eol === -1) break;
          const n = parseInt(rest.subarray(0, eol).toString('latin1'), 16);
          if (!Number.isFinite(n) || n <= 0) break;
          out.push(rest.subarray(eol + 2, eol + 2 + n));
          rest = rest.subarray(eol + 2 + n + 2);
        }
        body = Buffer.concat(out);
      }
      const sm = /HTTP\/1\.1 (\d+)/.exec(head);
      const cl = /content-length:\s*(\d+)/i.exec(head);
      resolve({
        status: sm ? Number(sm[1]) : null,
        contentLength: cl ? Number(cl[1]) : null,
        body,
        timedOut,
      });
    };
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${p} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', finish);
    sock.on('error', finish);
    sock.setTimeout(ms, () => {
      timedOut = true;
      sock.destroy();
      finish();
    });
  });
}

module.exports = {
  listen,
  close,
  request,
  get,
  getExpectTimeout,
  getRawWire,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
  makeMediaUpstream,
  parseRangeHeader,
};
