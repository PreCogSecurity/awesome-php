#!/usr/bin/env node
'use strict';

/**
 * Validates the structure and entry format of README.md.
 *
 * This repository is a curated "awesome list": a Markdown document with no
 * application code. The checks below enforce the conventions documented in
 * CONTRIBUTING.md (entry format `* [LIBRARY](LINK) - DESCRIPTION`,
 * descriptions ending in a period, no duplicates) plus basic Markdown
 * hygiene (valid URLs, no trailing whitespace, a table of contents that
 * matches the document headings).
 *
 * Usage:
 *   node scripts/validate.js             # validate README.md, exit 1 on errors
 *   node scripts/validate.js --warnings  # also print non-fatal warnings
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README_PATH = path.join(ROOT, 'README.md');

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TOC_ENTRY_RE = /^\s*- \[([^\]]+)\]\(#([^)]+)\)\s*$/;

// Standard entry: * [Label](url) - Description
const ENTRY_RE = /^\* \[((?:[^\[\]]|\\[\[\]])+)\]\((https?:\/\/[^)\s]+)\)(?:\s*-\s*(.+))?$/;
// Two linked labels sharing one description: * [A](url)/[B](url) - Description
const PAIRED_ENTRY_RE =
  /^\* \[((?:[^\[\]]|\\[\[\]])+)\]\((https?:\/\/[^)\s]+)\)\/\[((?:[^\[\]]|\\[\[\]])+)\]\((https?:\/\/[^)\s]+)\)\s*-\s*(.+)$/;
// Numbered multi-link entries: * Label: [1](url) [2](url) ... - Description
const NUMBERED_ENTRY_RE = /^\* [^:]+: (?:\[\d+\]\((https?:\/\/[^)\s]+)\)\s*)+\-\s*(.+)$/;

const URL_RE = /https?:\/\/[^\s)]+/g;
const PERIOD_RE = /[.!?:;]$/;

/**
 * GitHub-style anchor for a heading (lowercase, punctuation stripped,
 * spaces replaced with hyphens). Inline images and links are removed first
 * so that a heading such as `# Awesome PHP [![Build Status](...)](...)`
 * anchors to `#awesome-php`, matching GitHub's behaviour.
 */
function slugify(heading) {
  return heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, '') // links
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @param {string} content - Full text of README.md
 * @returns {{ errors: Array<{line:number,message:string}>, warnings: Array<{line:number,message:string}>, headings: Array, entries: number }}
 */
function validateReadme(content) {
  const lines = content.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const headings = [];
  const toc = [];
  const urls = new Map();
  const labels = new Map();
  let entries = 0;

  const checkUrl = (url, lineNo) => {
    if (!isValidHttpUrl(url)) {
      errors.push({ line: lineNo, message: `invalid URL: "${url}"` });
      return;
    }
    if (urls.has(url)) {
      errors.push({ line: lineNo, message: `duplicate URL (first used on line ${urls.get(url)}): ${url}` });
    } else {
      urls.set(url, lineNo);
    }
  };

  const checkDescription = (desc, lineNo, { warnOnly = false } = {}) => {
    if (!desc || desc.trim() === '') {
      errors.push({ line: lineNo, message: 'list entry is missing a description' });
      return;
    }
    if (!PERIOD_RE.test(desc.trim())) {
      const message = 'description must end with a period (see CONTRIBUTING.md)';
      if (warnOnly) warnings.push({ line: lineNo, message });
      else errors.push({ line: lineNo, message });
    }
  };

  const checkLabel = (label, lineNo) => {
    const key = label.toLowerCase();
    if (labels.has(key)) {
      warnings.push({
        line: lineNo,
        message: `duplicate label "${label}" (first used on line ${labels.get(key)}); prefix with the vendor/namespace per CONTRIBUTING.md`,
      });
    } else {
      labels.set(key, lineNo);
    }
  };

  const checkEntry = (label, url, desc, lineNo) => {
    entries += 1;
    checkUrl(url, lineNo);
    checkLabel(label, lineNo);
    checkDescription(desc, lineNo);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    if (/\t/.test(line)) {
      errors.push({ line: lineNo, message: 'line contains a tab character' });
    }
    if (/\s$/.test(line)) {
      errors.push({ line: lineNo, message: 'line has trailing whitespace' });
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      headings.push({ line: lineNo, level: heading[1].length, text: heading[2], slug: slugify(heading[2]) });
      continue;
    }

    const tocEntry = line.match(TOC_ENTRY_RE);
    if (tocEntry) {
      toc.push({ line: lineNo, label: tocEntry[1], anchor: tocEntry[2] });
      continue;
    }

    if (!line.startsWith('* ')) {
      continue;
    }

    let m = line.match(ENTRY_RE);
    if (m) {
      checkEntry(m[1], m[2], m[3], lineNo);
      continue;
    }
    m = line.match(PAIRED_ENTRY_RE);
    if (m) {
      checkEntry(m[1], m[2], m[5], lineNo);
      checkEntry(m[3], m[4], m[5], lineNo);
      continue;
    }
    m = line.match(NUMBERED_ENTRY_RE);
    if (m) {
      entries += 1;
      for (const url of line.match(URL_RE) || []) {
        checkUrl(url, lineNo);
      }
      checkDescription(m[2], lineNo, { warnOnly: true });
      continue;
    }
    errors.push({
      line: lineNo,
      message: 'list entry does not match the documented format `* [LIBRARY](LINK) - DESCRIPTION` (see CONTRIBUTING.md)',
    });
  }

  // Heading structure: the document must start with a single H1 and no
  // heading may skip a level.
  if (headings.length === 0) {
    errors.push({ line: 1, message: 'document has no headings' });
  } else if (headings[0].level !== 1) {
    errors.push({ line: headings[0].line, message: 'document must start with a level-1 heading' });
  }
  let previousLevel = 0;
  for (const h of headings) {
    if (h.level > previousLevel + 1) {
      errors.push({ line: h.line, message: `heading level ${h.level} skips a level (previous heading was level ${previousLevel})` });
    }
    previousLevel = h.level;
  }

  // Table of contents must match the headings in both directions. The
  // "Table of Contents" heading itself is not expected to list itself.
  const headingSlugs = new Set(headings.map((h) => h.slug));
  const tocAnchors = new Set(toc.map((t) => t.anchor));
  for (const h of headings) {
    if (h.text === 'Table of Contents') {
      continue;
    }
    if (!tocAnchors.has(h.slug)) {
      errors.push({ line: h.line, message: `heading "${h.text}" is missing from the table of contents` });
    }
  }
  for (const t of toc) {
    if (!headingSlugs.has(t.anchor)) {
      errors.push({ line: t.line, message: `table of contents entry "#${t.anchor}" does not match any heading` });
    }
  }

  return { errors, warnings, headings, entries };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const content = fs.readFileSync(README_PATH, 'utf8');
  const { errors, warnings, headings, entries } = validateReadme(content);
  const showWarnings = process.argv.includes('--warnings');

  for (const e of errors) {
    console.error(`error   ${String(e.line).padStart(4)}  ${e.message}`);
  }
  if (showWarnings) {
    for (const w of warnings) {
      console.warn(`warning ${String(w.line).padStart(4)}  ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nREADME.md failed validation with ${errors.length} error(s).`);
    process.exitCode = 1;
  } else {
    console.log(`README.md OK: ${headings.length} headings, ${entries} list entries, ${warnings.length} warning(s).`);
  }
}

module.exports = { validateReadme, slugify };