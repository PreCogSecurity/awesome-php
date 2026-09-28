'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  check,
  classifyError,
  classifyHost,
  extractUrls,
  isBlockedAddress,
  isBlockedHostname,
  parseTimeoutMs,
  renderReport,
  runChecks,
  summarize,
} = require('../scripts/check-links.js');

/** Minimal Response stand-in: `check` only reads `status` and `location`. */
function response(status, location = null) {
  return { status, headers: { get: (name) => (String(name).toLowerCase() === 'location' ? location : null) } };
}

/** Records every request and answers from a { "METHOD url": response } map. */
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers[`${init.method} ${url}`] || handlers[init.method] || handlers.default;
    if (handler === undefined) throw new Error(`unexpected request: ${init.method} ${url}`);
    return typeof handler === 'function' ? handler(url, init) : handler;
  };
  impl.calls = calls;
  return impl;
}

const publicLookup = async () => ['93.184.216.34'];

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

test('extractUrls returns unique http(s) URLs in document order', () => {
  const content = [
    '# Awesome',
    '* [B](https://example.com/b) - Second.',
    '* [A](https://example.com/a) - First.',
    '* [B again](https://example.com/b) - Duplicate.',
  ].join('\n');
  assert.deepEqual(extractUrls(content), ['https://example.com/b', 'https://example.com/a']);
});

test('extractUrls strips prose punctuation but keeps balanced parentheses', () => {
  const content = 'See https://example.com/a, and https://example.org/Foo_(bar). Also ftp://example.net/x';
  assert.deepEqual(extractUrls(content), ['https://example.com/a', 'https://example.org/Foo_(bar)']);
});

test('extractUrls refuses URLs that embed credentials', () => {
  // A credential in README.md is already a leaked secret; the link checker
  // must not replay it in an Authorization-less request either.
  assert.deepEqual(extractUrls('* [X](https://user:hunter2@example.com/x) - Nope.'), []);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('parseTimeoutMs defaults when unset', () => {
  assert.deepEqual(parseTimeoutMs(undefined), { value: 10000, warning: null });
  assert.deepEqual(parseTimeoutMs(''), { value: 10000, warning: null });
});

test('parseTimeoutMs accepts a valid value', () => {
  assert.deepEqual(parseTimeoutMs('2500'), { value: 2500, warning: null });
});

test('parseTimeoutMs clamps out-of-range values instead of aborting every request', () => {
  // A NaN timeout made every request abort instantly, reporting the whole
  // list as dead.
  const low = parseTimeoutMs('1');
  assert.equal(low.value, 100);
  assert.match(low.warning, /outside 100-120000ms/);
  const high = parseTimeoutMs('999999999');
  assert.equal(high.value, 120000);
  assert.ok(high.warning);
});

test('parseTimeoutMs rejects garbage loudly', () => {
  assert.throws(() => parseTimeoutMs('soon'), /must be a number of milliseconds/);
  assert.throws(() => parseTimeoutMs('NaN'), /must be a number of milliseconds/);
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

test('isBlockedHostname rejects local-network names', () => {
  for (const host of ['localhost', 'LOCALHOST', 'db.local', 'api.internal', 'printer.home.arpa', 'cache.localhost']) {
    assert.equal(isBlockedHostname(host), true, `${host} should be blocked`);
  }
  for (const host of ['example.com', 'www.php.net', 'notlocal.example']) {
    assert.equal(isBlockedHostname(host), false, `${host} should be allowed`);
  }
});

test('isBlockedAddress rejects addresses that are not publicly routable', () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1', // carrier-grade NAT
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254', // cloud instance metadata
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1',
    'fc00::1', // unique local
    'fd12:3456::1',
    'fe80::1', // link-local
    'ff02::1', // multicast
    '2002:7f00:1::1', // 6to4 wrapping 127.0.0.1
    '64:ff9b::127.0.0.1', // NAT64 wrapping loopback
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
});

test('isBlockedAddress allows publicly routable IPv6, including `::`-compressed forms', () => {
  // Regression: a parser that mishandled a trailing "::" reported every such
  // address as blocked, so real links were silently skipped by check:links.
  for (const address of [
    '2606:4700::1111',
    '2001:4860:482c:400::', // www.youtube.com, as resolved in the wild
    '2001:db8::1',
    '2a00:1450:4001:80f::200e',
  ]) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
  // ...while the compressed forms of the blocked ranges stay blocked.
  for (const address of ['::', '::1', 'fe80::', 'fe80::1%eth0', 'fc00::', 'ff02::', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
});

test('isBlockedAddress treats non-addresses as blocked (they must be resolved first)', () => {
  assert.equal(isBlockedAddress('example.com'), true);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('classifyHost blocks a public hostname that resolves to a private address', async () => {
  const verdict = await classifyHost('https://evil.example.com/', {
    lookup: async () => ['93.184.216.34', '127.0.0.1'],
  });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /resolves to non-public 127\.0\.0\.1/);
});

test('classifyHost blocks cloud metadata endpoints and private literals', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::1]:6379/',
    'http://192.168.0.1/admin',
    'http://localhost:9200/_cat/indices',
  ]) {
    const verdict = await classifyHost(url, { lookup: publicLookup });
    assert.equal(verdict.blocked, true, `${url} should be blocked`);
  }
});

test('classifyHost reports DNS failures instead of treating them as blocked', async () => {
  const error = new Error('getaddrinfo ENOTFOUND nope.example');
  error.code = 'ENOTFOUND';
  const verdict = await classifyHost('https://nope.example/', {
    lookup: async () => {
      throw error;
    },
  });
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.lookupError, 'ENOTFOUND');
});

test('classifyHost allows public destinations', async () => {
  const verdict = await classifyHost('https://www.php.net/', { lookup: publicLookup });
  assert.deepEqual(verdict, { blocked: false, reason: null, addresses: ['93.184.216.34'] });
});

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

test('check reports a live link', async () => {
  const fetchImpl = fakeFetch({ default: response(200) });
  const result = await check('https://example.com/a', { fetchImpl, lookup: publicLookup });
  assert.deepEqual(result, { url: 'https://example.com/a', ok: true, status: 200, detail: '' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.method, 'HEAD');
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual', 'redirects are followed by hand so each hop is re-validated');
});

test('check does not retry with GET for a link that is genuinely gone', async () => {
  const fetchImpl = fakeFetch({ default: response(404) });
  const result = await check('https://example.com/gone', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.detail, 'HTTP 404');
  assert.equal(fetchImpl.calls.length, 1, 'a 404 must not cost a second request');
});

test('check retries with GET when the server rejects HEAD, on a fresh signal', async () => {
  // Regression: the old implementation shared one AbortController between the
  // HEAD attempt and the GET retry, so a HEAD that hit the timeout aborted the
  // retry too and alive links were reported dead.
  const fetchImpl = fakeFetch({
    'HEAD https://example.com/headless': response(405),
    'GET https://example.com/headless': response(200),
  });
  const result = await check('https://example.com/headless', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.init.method),
    ['HEAD', 'GET']
  );
  const [head, get] = fetchImpl.calls.map((c) => c.init.signal);
  assert.notEqual(head, get, 'the retry must not reuse the aborted controller');
  assert.equal(head.aborted, false);
  assert.equal(get.aborted, false);
});

test('check releases the response body of a GET retry instead of buffering it', async () => {
  let cancelled = 0;
  const withBody = (status) => {
    const r = response(status);
    r.body = { cancel: () => { cancelled += 1; return Promise.resolve(); } };
    return r;
  };
  const fetchImpl = fakeFetch({
    'HEAD https://example.com/headless': response(405),
    'GET https://example.com/headless': withBody(200),
  });
  const result = await check('https://example.com/headless', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, true);
  assert.equal(cancelled, 1, 'the unneeded body must be released');
});

test('check reports a timeout when the host never answers', async () => {
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const result = await check('https://example.com/slow', {
    fetchImpl: hangingFetch,
    lookup: publicLookup,
    timeoutMs: 25,
  });
  assert.deepEqual(result, { url: 'https://example.com/slow', ok: false, status: null, detail: 'timeout' });
});

test('check surfaces DNS and connection errors as a reason string', async () => {
  const cause = new Error('getaddrinfo ENOTFOUND nope.example');
  cause.code = 'ENOTFOUND';
  const fetchImpl = async () => {
    const err = new Error('fetch failed');
    err.cause = cause;
    throw err;
  };
  const result = await check('https://nope.example/', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'ENOTFOUND');
});

test('check follows a redirect and reports the final status', async () => {
  const fetchImpl = fakeFetch({
    'HEAD https://example.com/old': response(301, 'https://example.com/new'),
    'HEAD https://example.com/new': response(200),
  });
  const result = await check('https://example.com/old', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.url, 'https://example.com/old', 'the reported URL stays the one from the README');
});

test('check refuses to follow a redirect into the private network', async () => {
  const fetchImpl = fakeFetch({
    'HEAD https://example.com/pivot': response(302, 'http://169.254.169.254/latest/meta-data/'),
  });
  const result = await check('https://example.com/pivot', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.detail, /skipped: .*not a public address/);
  assert.equal(fetchImpl.calls.length, 1, 'the metadata endpoint must never be contacted');
});

test('check gives up after the redirect limit', async () => {
  const fetchImpl = fakeFetch({ default: (url) => response(302, `${url}next/`) });
  const result = await check('https://example.com/', { fetchImpl, lookup: publicLookup, maxRedirects: 2 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /too many redirects/);
});

test('check skips a private destination before opening a socket', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return response(200);
  };
  const result = await check('http://127.0.0.1:6379/', { fetchImpl, lookup: publicLookup });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('classifyError normalises the errors fetch can throw', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const cause = new Error('nope');
  cause.code = 'ECONNREFUSED';
  const wrapped = new Error('fetch failed');
  wrapped.cause = cause;
  assert.equal(classifyError(abort), 'timeout');
  assert.equal(classifyError(wrapped), 'ECONNREFUSED');
  assert.equal(classifyError(new Error('plain')), 'plain');
  assert.equal(classifyError('weird'), 'weird');
});

// ---------------------------------------------------------------------------
// Orchestration and reporting
// ---------------------------------------------------------------------------

test('runChecks keeps at most `concurrency` requests in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return response(200);
  };
  const urls = Array.from({ length: 7 }, (unused, i) => `https://example.com/${i}`);
  const results = await runChecks(urls, { fetchImpl, lookup: publicLookup, concurrency: 2 });
  assert.equal(results.length, 7);
  assert.ok(results.every((r) => r.ok));
  assert.ok(peak <= 2, `expected at most 2 concurrent requests, saw ${peak}`);
});

test('runChecks rejects a nonsensical concurrency', async () => {
  await assert.rejects(() => runChecks(['https://example.com/'], { concurrency: 0 }), /positive integer/);
});

test('summarize separates dead links from deliberately skipped ones', () => {
  const results = [
    { url: 'a', ok: true, status: 200, detail: '' },
    { url: 'b', ok: false, status: 404, detail: 'HTTP 404' },
    { url: 'c', ok: false, status: null, detail: 'skipped: local', skipped: true },
  ];
  const summary = summarize(results);
  assert.equal(summary.checked, 3);
  assert.equal(summary.ok, 1);
  assert.equal(summary.dead.length, 1);
  assert.equal(summary.skipped.length, 1);
  const report = renderReport(results);
  assert.match(report, /Checked 3 unique URLs: 1 ok, 1 dead\/unreachable, 1 skipped\./);
  assert.match(report, /DEAD HTTP 404\s+b/);
  assert.match(report, /SKIP skipped: local\s+c/);
});
