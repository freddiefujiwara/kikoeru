'use strict';

// Shared helpers for the koed test suites. This file is not a test
// itself (it does not match the *.test.js glob); it only builds fake
// upstreams, temp dirs and small HTTP clients so every suite can stay
// off the real network.

const http = require('node:http');
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
// Used to pin down the current behaviour for mid-stream upstream
// errors, where the handler gives up without answering.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'koed-test-'));
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

module.exports = {
  listen,
  close,
  request,
  get,
  getExpectTimeout,
  makeData,
  tmpDir,
  writeCache,
  nowSec,
  makeMediaUpstream,
  parseRangeHeader,
};
