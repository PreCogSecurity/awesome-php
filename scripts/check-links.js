#!/usr/bin/env node
'use strict';

/**
 * Audits link liveness for every URL referenced in README.md.
 *
 * This is an opt-in maintenance tool, not part of `npm test`: link liveness
 * depends on the network and on third-party sites, which makes it unsuitable
 * as a hard CI gate. Run it periodically to find dead links:
 *
 *   npm run check:links
 *
 * Exit code 0 when every link responds (or is deliberately skipped), 1 when
 * dead links are found, 2 on a usage or configuration error.
 *
 * Because README.md is attacker-influenced (anyone can open a pull request
 * adding an entry), this tool refuses to contact hosts that are not publicly
 * routable. Without that guard a "totally normal" link to
 * `http://169.254.169.254/latest/meta-data/` or `http://localhost:6379/`
 * turns a maintainer's `npm run check:links` into an SSRF probe of their own
 * machine and network. The guard is re-applied on every redirect hop.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const dns = require('dns').promises;

const ROOT = path.join(__dirname, '..');
const README_PATH = path.join(ROOT, 'README.md');
const CONCURRENCY = 16;
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'awesome-php-link-checker/1.0 (+https://github.com/PreCogSecurity/awesome-php)';
/** Statuses that mean "this server does not answer HEAD", so retry with GET. */
const HEAD_RETRY_STATUSES = new Set([403, 405, 406, 501]);

// Matches a bare URL, tolerating one level of balanced parentheses so that
// links such as https://example.org/Foo_(bar) are not truncated at the "(".
const URL_RE = /https?:\/\/[^\s<>()[\]]*(?:\([^\s()]*\)[^\s<>()[\]]*)*/g;

/** @typedef {{url:string, ok:boolean, status:number|null, detail:string, skipped?:boolean}} CheckResult */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Parses CHECK_LINKS_TIMEOUT_MS. An unparseable or out-of-range value used to
 * produce NaN and made every request abort instantly, reporting the whole
 * list as dead; fail loudly and clamp instead.
 *
 * @param {string|undefined} raw
 * @returns {{value:number, warning:string|null}}
 */
function parseTimeoutMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_TIMEOUT_MS, warning: null };
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    throw new Error(`CHECK_LINKS_TIMEOUT_MS must be a number of milliseconds, got "${raw}"`);
  }
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return {
      value: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value)),
      warning: `CHECK_LINKS_TIMEOUT_MS=${raw} is outside ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}ms; using ${Math.min(
        MAX_TIMEOUT_MS,
        Math.max(MIN_TIMEOUT_MS, value)
      )}ms`,
    };
  }
  return { value, warning: null };
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

/**
 * Strips punctuation that delimits a URL in prose, while keeping any closing
 * parenthesis that the URL itself owns (`https://example.org/Foo_(bar)`).
 *
 * @param {string} raw
 * @returns {string}
 */
function trimUrlPunctuation(raw) {
  let index = raw.length - 1;
  while (index >= 0) {
    const ch = raw[index];
    if (!/[),.;:!?]/.test(ch)) break;
    if (ch === ')') {
      const head = raw.slice(0, index);
      const opens = (head.match(/\(/g) || []).length;
      const closes = (head.match(/\)/g) || []).length;
      if (opens > closes) break; // the ")" closes a group the URL owns
    }
    index -= 1;
  }
  return raw.slice(0, index + 1);
}

/**
 * Extracts the unique, http(s) URLs from a Markdown document, in document
 * order. Punctuation that delimits a URL inside prose is stripped.
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractUrls(content) {
  const candidates = content.match(URL_RE) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of candidates) {
    const candidate = trimUrlPunctuation(raw);
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (parsed.username !== '' || parsed.password !== '') continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    urls.push(candidate);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** Hostnames that can only ever resolve inside the network running the check. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** @param {string} hostname @returns {boolean} */
function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Parses an IPv6 literal into 8 hextets, expanding `::` and any embedded
 * IPv4 tail. Returns null when the input is not a valid literal.
 *
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIpv6(ip) {
  const zone = ip.indexOf('%');
  const address = (zone === -1 ? ip : ip.slice(0, zone)).toLowerCase();
  if (!address.includes(':')) return null;
  const parseSide = (text) => {
    if (text === '') return []; // `abc::` and `::abc` both leave one side empty
    const out = [];
    for (const group of text.split(':')) {
      if (group === '') return null;
      if (group.includes('.')) {
        const bytes = parseIpv4(group);
        if (bytes === null) return null;
        out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out.push(parseInt(group, 16));
      }
    }
    return out;
  };
  const gap = address.indexOf('::');
  if (gap === -1) {
    const hextets = parseSide(address);
    return hextets !== null && hextets.length === 8 ? hextets : null;
  }
  const head = parseSide(address.slice(0, gap));
  const tail = parseSide(address.slice(gap + 2));
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/**
 * @param {string} ip
 * @returns {number[]|null} four bytes, or null when the input is not IPv4
 */
function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (bytes.some((b) => !Number.isInteger(b) || b > 255)) return null;
  return bytes;
}

/** @param {number[]} bytes @param {number} base @param {number} bits */
function inV4Range(bytes, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const value = (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
  const baseValue = (((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3]) >>> 0;
  return (value & mask) === (baseValue & mask);
}

/** Non-public IPv4 ranges: loopback, RFC1918, CGNAT, link-local, multicast, reserved. */
const BLOCKED_V4_RANGES = [
  [[0, 0, 0, 0], 8], // this network, incl. 0.0.0.0
  [[10, 0, 0, 0], 8], // RFC1918
  [[100, 64, 0, 0], 10], // RFC6598 carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, incl. 169.254.169.254 cloud metadata
  [[172, 16, 0, 0], 12], // RFC1918
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 168, 0, 0], 16], // RFC1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, incl. 255.255.255.255
];

/**
 * True when the address is not publicly routable on the internet.
 *
 * @param {string} address
 * @returns {boolean}
 */
function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const bytes = parseIpv4(address);
    return bytes === null || BLOCKED_V4_RANGES.some(([base, bits]) => inV4Range(bytes, base, bits));
  }
  if (version !== 6) {
    return true; // not an IP literal: caller must resolve it first
  }
  const h = parseIpv6(address);
  if (h === null) return true;
  const zeros = (from, to) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && h[7] === 1) return true; // ::1
  if (zeros(0, 5) && h[5] === 0xffff) return isBlockedAddress(hexToV4(h[6], h[7])); // ::ffff:a.b.c.d
  if (zeros(0, 6) && h[6] !== 0) return isBlockedAddress(hexToV4(h[6], h[7])); // ::a.b.c.d
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2002) return isBlockedAddress(hexToV4(h[1], h[2])); // 6to4 tunnels to IPv4
  if (h[0] === 0x0064 && h[1] === 0xff9b && zeros(2, 5)) return isBlockedAddress(hexToV4(h[6], h[7])); // NAT64
  if (h[0] === 0x0100 && zeros(1, 4) && h[4] === 0) return true; // 100::/64 discard
  return false;
}

/** @param {number} hi @param {number} lo @returns {string} */
function hexToV4(hi, lo) {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/**
 * Decides whether a URL may be fetched, resolving DNS first so that a
 * public-looking hostname pointing at 127.0.0.1 is caught too.
 *
 * @param {string} url
 * @param {{lookup?:(hostname:string)=>Promise<string[]>, allowPrivateHosts?:boolean}} [options]
 * @returns {Promise<{blocked:boolean, reason:string|null, addresses:string[], lookupError?:string}>}
 */
async function classifyHost(url, options = {}) {
  const { lookup = defaultLookup, allowPrivateHosts = false } = options;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, reason: 'unparseable URL', addresses: [] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: true, reason: `unsupported scheme "${parsed.protocol}"`, addresses: [] };
  }
  if (allowPrivateHosts) return { blocked: false, reason: null, addresses: [] };
  // WHATWG keeps the brackets in IPv6 hostnames; the IP parsers want them gone.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isBlockedHostname(host)) {
    return { blocked: true, reason: `"${host}" is a local-network hostname`, addresses: [] };
  }
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      return { blocked: true, reason: `"${host}" is not a public address`, addresses: [] };
    }
    return { blocked: false, reason: null, addresses: [host] };
  }
  let addresses;
  try {
    addresses = await lookup(host);
  } catch (err) {
    return { blocked: false, reason: null, addresses: [], lookupError: err && err.code ? String(err.code) : String(err) };
  }
  const blocked = addresses.filter((a) => isBlockedAddress(a));
  if (blocked.length > 0) {
    return { blocked: true, reason: `"${host}" resolves to non-public ${blocked[0]}`, addresses };
  }
  return { blocked: false, reason: null, addresses };
}

/** @param {string} hostname @returns {Promise<string[]>} */
async function defaultLookup(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** @param {unknown} err @returns {string} */
function classifyError(err) {
  if (!err || typeof err !== 'object') return String(err);
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  if (err.cause && err.cause.code) return String(err.cause.code);
  if (err.code) return String(err.code);
  return err.message ? String(err.message) : 'unknown error';
}

/**
 * One request with its own timeout budget. Sharing a single AbortController
 * between the HEAD attempt and the GET retry meant that whenever the HEAD
 * attempt hit the timeout, the retry was aborted instantly by the same dead
 * signal and the URL was reported dead even when it was alive.
 *
 * @returns {Promise<{response:Response|null, error:string|null}>}
 */
async function requestOnce(url, { fetchImpl, method, timeoutMs, userAgent }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      // Redirects are followed by hand so that every hop is re-validated
      // against the SSRF guard before it is contacted.
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': userAgent, accept: '*/*' },
    });
    if (method === 'GET' && response.body && typeof response.body.cancel === 'function') {
      // Only the status and Location are needed, so release the connection
      // instead of buffering a whole page; without this a sweep of ~600 URLs
      // can exhaust the socket pool on unconsumed bodies.
      response.body.cancel('body not needed').catch(() => {});
    }
    return { response, error: null };
  } catch (err) {
    return { response: null, error: classifyError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only a 2xx is a healthy link. With `redirect: 'manual'` a 3xx is never
 * "followed for us", so it must be handled as a redirect, not as success.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isSuccess(status) {
  return status >= 200 && status < 300;
}

/**
 * Checks a single URL, following redirects manually and re-validating each
 * hop.
 *
 * @param {string} url
 * @param {{fetchImpl?:Function, lookup?:Function, timeoutMs?:number, userAgent?:string,
 *          maxRedirects?:number, allowPrivateHosts?:boolean}} [options]
 * @returns {Promise<CheckResult>}
 */
async function check(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = USER_AGENT,
    maxRedirects = MAX_REDIRECTS,
    allowPrivateHosts = false,
  } = options;
  const deadline = Date.now() + timeoutMs;

  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation available (Node.js 18.13+ or pass fetchImpl)');
  }

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await classifyHost(current, { allowPrivateHosts, lookup: options.lookup });
    if (verdict.blocked) {
      return { url, ok: false, status: null, detail: `skipped: ${verdict.reason}`, skipped: true };
    }
    if (verdict.lookupError) {
      return { url, ok: false, status: null, detail: verdict.lookupError };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { url, ok: false, status: null, detail: 'timeout' };
    }

    let attempt = await requestOnce(current, { fetchImpl, method: 'HEAD', timeoutMs: remaining, userAgent });
    if (attempt.error !== null) {
      return { url, ok: false, status: null, detail: attempt.error };
    }

    let response = attempt.response;
    if (!isSuccess(response.status) && HEAD_RETRY_STATUSES.has(response.status)) {
      // Some servers reject HEAD; retry the same hop with GET on a fresh
      // timeout budget.
      const retryBudget = deadline - Date.now();
      if (retryBudget <= 0) {
        return { url, ok: false, status: null, detail: 'timeout' };
      }
      attempt = await requestOnce(current, { fetchImpl, method: 'GET', timeoutMs: retryBudget, userAgent });
      if (attempt.error !== null) {
        return { url, ok: false, status: null, detail: attempt.error };
      }
      response = attempt.response;
    }

    if (isSuccess(response.status)) {
      return { url, ok: true, status: response.status, detail: '' };
    }

    const location =
      response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null;
    if (response.status >= 300 && response.status < 400 && location) {
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        return { url, ok: false, status: response.status, detail: `invalid redirect target "${location}"` };
      }
      current = next;
      continue;
    }

    return { url, ok: false, status: response.status, detail: `HTTP ${response.status}` };
  }

  return { url, ok: false, status: null, detail: `too many redirects (>${maxRedirects})` };
}

/**
 * Runs checks in bounded-size batches so a 500-link README does not open
 * 500 sockets at once.
 *
 * @param {string[]} urls
 * @param {object} [options] - forwarded to check(), plus `concurrency`
 * @returns {Promise<CheckResult[]>}
 */
async function runChecks(urls, options = {}) {
  const { concurrency = CONCURRENCY, ...checkOptions } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got "${concurrency}"`);
  }
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((u) => check(u, checkOptions)))));
  }
  return results;
}

/**
 * @param {CheckResult[]} results
 * @returns {{checked:number, ok:number, dead:CheckResult[], skipped:CheckResult[]}}
 */
function summarize(results) {
  const dead = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => !r.ok && r.skipped);
  return { checked: results.length, ok: results.length - dead.length - skipped.length, dead, skipped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Renders a human-readable report. @param {CheckResult[]} results @returns {string} */
function renderReport(results) {
  const { checked, ok, dead, skipped } = summarize(results);
  const lines = [
    `Checked ${checked} unique URLs: ${ok} ok, ${dead.length} dead/unreachable, ${skipped.length} skipped.`,
  ];
  for (const d of dead) {
    lines.push(`  DEAD ${String(d.detail || d.status).padEnd(24)} ${d.url}`);
  }
  for (const s of skipped) {
    lines.push(`  SKIP ${String(s.detail).padEnd(24)} ${s.url}`);
  }
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  let timeout;
  try {
    timeout = parseTimeoutMs(process.env.CHECK_LINKS_TIMEOUT_MS);
  } catch (err) {
    process.stderr.write(`error   ${err.message}\n`);
    process.exitCode = 2;
  }
  if (timeout !== undefined) {
    if (timeout.warning) process.stderr.write(`warning ${timeout.warning}\n`);
    let content;
    try {
      content = fs.readFileSync(README_PATH, 'utf8');
    } catch (err) {
      process.stderr.write(`error   cannot read ${README_PATH}: ${err.code || err.message}\n`);
      process.exitCode = 2;
      content = undefined;
    }
    if (content !== undefined) {
      const urls = extractUrls(content);
      runChecks(urls, { timeoutMs: timeout.value })
        .then((results) => {
          process.stdout.write(renderReport(results));
          process.exitCode = summarize(results).dead.length > 0 ? 1 : 0;
        })
        .catch((err) => {
          process.stderr.write(`error   ${err && err.message ? err.message : err}\n`);
          process.exitCode = 2;
        });
    }
  }
}

module.exports = {
  CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
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
};
