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
 * Exit code 0 when every link responds, 1 when dead links are found.
 */

const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', 'README.md');
const CONCURRENCY = 16;
const TIMEOUT_MS = Number(process.env.CHECK_LINKS_TIMEOUT_MS || 10000);

const content = fs.readFileSync(README_PATH, 'utf8');
const urls = [...new Set(content.match(/https?:\/\/[^\s)]+/g) || [])]
  .map((u) => u.replace(/[),.;]+$/, ''))
  .filter((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  });

async function check(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (head.status >= 200 && head.status < 400) {
      return { url, ok: true, status: head.status };
    }
    // Some servers reject HEAD; retry with GET.
    const get = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    return { url, ok: get.status >= 200 && get.status < 400, status: get.status };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.cause && err.cause.code ? err.cause.code : err.message;
    return { url, ok: false, status: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(check))));
  }

  const dead = results.filter((r) => !r.ok);
  const ok = results.filter((r) => r.ok);
  console.log(`Checked ${results.length} unique URLs: ${ok.length} ok, ${dead.length} dead/unreachable.`);
  for (const d of dead) {
    console.log(`  DEAD ${String(d.status).padEnd(12)} ${d.url}`);
  }
  process.exitCode = dead.length > 0 ? 1 : 0;
}

main();