#!/usr/bin/env node
'use strict';

/**
 * Validates the structure and entry format of README.md.
 *
 * This repository is a curated "awesome list": a Markdown document with no
 * application code. The checks below enforce the conventions documented in
 * CONTRIBUTING.md (entry format `* [LIBRARY](LINK) - DESCRIPTION`,
 * descriptions ending in a period, no duplicates) plus basic Markdown
 * hygiene (valid URLs, no embedded credentials, no trailing whitespace, no
 * invisible "Trojan Source" characters, and a table of contents that matches
 * the document headings).
 *
 * The module is import-safe: requiring it has no side effects, and the CLI
 * only runs when the file is executed directly.
 *
 * Usage:
 *   node scripts/validate.js                    # validate README.md, exit 1 on errors
 *   node scripts/validate.js --warnings         # also print non-fatal warnings
 *   node scripts/validate.js --strict           # treat warnings as errors
 *   node scripts/validate.js --format=json      # machine-readable report
 *   node scripts/validate.js --format=github    # GitHub Actions annotations
 *
 * Exit codes: 0 = valid, 1 = validation errors, 2 = usage/IO error.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README_PATH = path.join(ROOT, 'README.md');

/** @typedef {'error'|'warning'} Severity */
/** @typedef {{line:number, message:string, severity:Severity}} Finding */
/** @typedef {{line:number, level:number, text:string, slug:string, anchor:string}} Heading */
/** @typedef {{errors:Finding[], warnings:Finding[], headings:Heading[], entries:number}} ValidationResult */

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
 * Control characters and Unicode bidi overrides. These render as nothing (or
 * as a mirrored label) while changing what a reader actually sees, which is
 * the "Trojan Source" trick: a pull request can add a link whose visible
 * domain is not the domain it points at. Tab is excluded (reported
 * separately) and CR/LF cannot occur inside a single line.
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * GitHub-style anchor for a heading: lowercase, punctuation stripped, spaces
 * replaced with hyphens. Underscores, hyphens and non-ASCII letters are
 * preserved because GitHub (github-slugger) keeps them; each remaining space
 * becomes its own hyphen, as GitHub does. Inline images and links are removed
 * first so that a heading such as `# Awesome PHP [![CI](...)](...)` anchors to
 * `#awesome-php`, matching GitHub's behaviour.
 */
function slugify(heading) {
  return heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, '') // links
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** @returns {URL|null} the parsed URL, or null when it is not an http(s) URL. */
function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname.length === 0) return null;
  return parsed;
}

function isValidHttpUrl(value) {
  return parseHttpUrl(value) !== null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @param {string} content - Full text of README.md
 * @param {{maxLineLength?:number}} [options]
 * @returns {ValidationResult}
 */
function validateReadme(content, options = {}) {
  const { maxLineLength = Number.POSITIVE_INFINITY } = options;
  const lines = content.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const headings = [];
  const toc = [];
  const urls = new Map();
  const labels = new Map();
  let entries = 0;

  const error = (line, message) => errors.push({ line, message, severity: 'error' });
  const warn = (line, message) => warnings.push({ line, message, severity: 'warning' });

  const checkUrl = (url, lineNo) => {
    const parsed = parseHttpUrl(url);
    if (parsed === null) {
      error(lineNo, `invalid URL: "${url}"`);
      return;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      // A URL with userinfo in it is a credential pasted into a public
      // document; the credential also leaks via referrers and server logs.
      error(lineNo, `URL must not embed credentials: ${url.split('@').pop()}`);
    }
    if (urls.has(url)) {
      error(lineNo, `duplicate URL (first used on line ${urls.get(url)}): ${url}`);
    } else {
      urls.set(url, lineNo);
    }
  };

  const checkDescription = (desc, lineNo, { warnOnly = false } = {}) => {
    if (!desc || desc.trim() === '') {
      error(lineNo, 'list entry is missing a description');
      return;
    }
    if (!PERIOD_RE.test(desc.trim())) {
      const message = 'description must end with a period (see CONTRIBUTING.md)';
      if (warnOnly) warn(lineNo, message);
      else error(lineNo, message);
    }
  };

  const checkLabel = (label, lineNo) => {
    const key = label.toLowerCase();
    if (labels.has(key)) {
      warn(
        lineNo,
        `duplicate label "${label}" (first used on line ${labels.get(key)}); prefix with the vendor/namespace per CONTRIBUTING.md`
      );
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
      error(lineNo, 'line contains a tab character');
    }
    if (/\s$/.test(line)) {
      error(lineNo, 'line has trailing whitespace');
    }
    if (INVISIBLE_RE.test(line)) {
      error(lineNo, 'line contains invisible or bidi-override characters (possible text-spoofing attempt)');
    }
    if (line.length > maxLineLength) {
      warn(lineNo, `line is ${line.length} characters (limit ${maxLineLength})`);
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      headings.push({ line: lineNo, level: heading[1].length, text: heading[2], slug: slugify(heading[2]), anchor: '' });
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
    error(
      lineNo,
      'list entry does not match the documented format `* [LIBRARY](LINK) - DESCRIPTION` (see CONTRIBUTING.md)'
    );
  }

  // Heading structure: the document must start with a single H1 and no
  // heading may skip a level.
  if (headings.length === 0) {
    error(1, 'document has no headings');
  } else if (headings[0].level !== 1) {
    error(headings[0].line, 'document must start with a level-1 heading');
  }
  let previousLevel = 0;
  for (const h of headings) {
    if (h.level > previousLevel + 1) {
      error(h.line, `heading level ${h.level} skips a level (previous heading was level ${previousLevel})`);
    }
    previousLevel = h.level;
  }

  // GitHub de-duplicates repeated heading names by appending -1, -2, ... to
  // the later anchors. Mirror that so the table of contents keeps matching
  // the rendered document instead of failing on a legitimate duplicate.
  const usedAnchors = new Set();
  for (const h of headings) {
    let anchor = h.slug;
    if (usedAnchors.has(anchor)) {
      warn(h.line, `duplicate heading "${h.text}"; GitHub renders it as "#${h.slug}-1"`);
      let suffix = 1;
      while (usedAnchors.has(`${h.slug}-${suffix}`)) suffix += 1;
      anchor = `${h.slug}-${suffix}`;
    }
    h.anchor = anchor;
    usedAnchors.add(anchor);
  }

  // Table of contents must match the headings in both directions. The
  // "Table of Contents" heading itself is not expected to list itself.
  const headingAnchors = new Set(headings.map((h) => h.anchor));
  const tocAnchors = new Set(toc.map((t) => t.anchor));
  for (const h of headings) {
    if (h.text === 'Table of Contents') {
      continue;
    }
    if (!tocAnchors.has(h.anchor)) {
      error(h.line, `heading "${h.text}" is missing from the table of contents`);
    }
  }
  for (const t of toc) {
    if (!headingAnchors.has(t.anchor)) {
      error(t.line, `table of contents entry "#${t.anchor}" does not match any heading`);
    }
  }

  return { errors, warnings, headings, entries };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Escapes untrusted text for a GitHub Actions workflow command.
 *
 * README.md is attacker-influenced (anyone can open a pull request against
 * it), and workflow commands are read from the log. Without escaping, a
 * crafted line could close our annotation and inject a forged one, spoofing
 * check results. `\r`/`\n`/`%` terminate and interpolate; `,` and `:`
 * separate and terminate annotation properties.
 *
 * @param {string} text
 * @param {{property?:boolean}} [options] - true when the text is a property value
 * @returns {string}
 */
function escapeWorkflowCommand(text, { property = false } = {}) {
  const escaped = String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return property ? escaped.replace(/:/g, '%3A').replace(/,/g, '%2C') : escaped;
}

const REPORT_FORMATS = ['text', 'json', 'github'];

/**
 * Renders a validation result as a report.
 *
 * @param {ValidationResult} result
 * @param {{format?:string, showWarnings?:boolean, strict?:boolean, source?:string, write?:(text:string)=>void}} [options]
 * @returns {{output:string, exitCode:number}}
 */
function renderReport(result, options = {}) {
  const { format = 'text', showWarnings = false, strict = false, source = 'README.md', write = () => {} } = options;
  if (!REPORT_FORMATS.includes(format)) {
    throw new Error(`unknown report format "${format}" (expected one of: ${REPORT_FORMATS.join(', ')})`);
  }

  const { errors, warnings, headings, entries } = result;
  const findings = [...errors, ...(showWarnings || strict ? warnings : [])];
  const exitCode = errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0;

  if (format === 'json') {
    const output = `${JSON.stringify(
      {
        source,
        valid: exitCode === 0,
        summary: { headings: headings.length, entries, errors: errors.length, warnings: warnings.length },
        findings,
      },
      null,
      2
    )}\n`;
    write(output);
    return { output, exitCode };
  }

  if (format === 'github') {
    const lines = findings.map((f) => {
      const level = f.severity === 'warning' ? 'warning' : 'error';
      return `::${level} file=${escapeWorkflowCommand(source, { property: true })},line=${f.line}::${escapeWorkflowCommand(f.message)}`;
    });
    lines.push(
      exitCode === 0
        ? `README.md OK: ${headings.length} headings, ${entries} list entries, ${warnings.length} warning(s).`
        : `README.md failed validation with ${errors.length} error(s).`
    );
    const output = `${lines.join('\n')}\n`;
    write(output);
    return { output, exitCode };
  }

  const lines = [];
  for (const e of errors) {
    lines.push(`error   ${String(e.line).padStart(4)}  ${e.message}`);
  }
  for (const w of showWarnings ? warnings : []) {
    lines.push(`warning ${String(w.line).padStart(4)}  ${w.message}`);
  }
  if (exitCode !== 0) {
    lines.push('', `README.md failed validation with ${errors.length} error(s).`);
  } else {
    lines.push(`README.md OK: ${headings.length} headings, ${entries} list entries, ${warnings.length} warning(s).`);
  }
  const output = `${lines.join('\n')}\n`;
  write(output);
  return { output, exitCode };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'Usage: node scripts/validate.js [--warnings] [--strict] [--format=text|json|github]';

/** @returns {{format:string, showWarnings:boolean, strict:boolean}} */
function parseArgv(argv) {
  const formatArg = argv.find((a) => a.startsWith('--format='));
  return {
    format: formatArg === undefined ? 'text' : formatArg.slice('--format='.length),
    showWarnings: argv.includes('--warnings'),
    strict: argv.includes('--strict'),
  };
}

if (require.main === module) {
  const options = parseArgv(process.argv.slice(2));
  if (!REPORT_FORMATS.includes(options.format)) {
    process.stderr.write(`error   unknown report format "${options.format}"\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    let content;
    try {
      content = fs.readFileSync(README_PATH, 'utf8');
    } catch (err) {
      // A missing or unreadable README is a setup problem, not a validation
      // failure: report it plainly instead of dumping a stack trace.
      process.stderr.write(`error   cannot read ${README_PATH}: ${err.code || err.message}\n`);
      process.exitCode = 2;
      content = undefined;
    }
    if (content !== undefined) {
      const result = validateReadme(content);
      const { exitCode } = renderReport(result, {
        ...options,
        source: path.relative(ROOT, README_PATH).split(path.sep).join('/'),
        write: (text) => process.stdout.write(text),
      });
      process.exitCode = exitCode;
    }
  }
}

module.exports = {
  REPORT_FORMATS,
  escapeWorkflowCommand,
  isValidHttpUrl,
  parseArgv,
  renderReport,
  slugify,
  validateReadme,
};
