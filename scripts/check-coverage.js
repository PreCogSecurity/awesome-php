#!/usr/bin/env node
'use strict';

/**
 * Enforces a minimum code-coverage percentage for `npm run test:coverage`.
 *
 * Node's built-in test runner already prints a coverage table, so this script
 * adds the one thing it cannot do: fail the build when coverage regresses.
 * Keeping the gate in-repo (instead of adding c8 as a dependency) preserves
 * the zero-runtime-dependency, fully reproducible install.
 *
 * Usage:
 *   npm run test:coverage 2>&1 | tee coverage-summary.txt
 *   node scripts/check-coverage.js --min=80 --report=coverage-summary.txt
 *   node --test --experimental-test-coverage | node scripts/check-coverage.js
 *
 * Exit codes: 0 = threshold met, 1 = threshold missed or report unreadable.
 */

const fs = require('fs');

const DEFAULT_MIN_PERCENT = 80;
const USAGE = 'Usage: node scripts/check-coverage.js [--min=<percent>] [--report=<path>|-]';

/**
 * The aggregate row, wherever it appears in the line. The spec reporter
 * prefixes lines with `ℹ`, the TAP reporter with `# `, and output that has
 * been through a re-encoding filter can arrive with any other leading noise,
 * so the row is located by content rather than by position.
 */
const SUMMARY_ROW_RE = /(?:^|[^A-Za-z])all files\s*\|/i;

/**
 * Extracts the "all files" line from a Node test-runner coverage report.
 *
 * The column header has changed between Node releases (`% Stmts` on 20/22,
 * `line %` on newer versions) but the first numeric column after `all files`
 * is always the aggregate coverage, so the summary is parsed by position
 * rather than by header name.
 *
 * @param {string} output
 * @returns {{percent:number, raw:string}|null}
 */
function parseCoverageSummary(output) {
  for (const rawLine of String(output).split(/\r?\n/)) {
    const start = rawLine.search(SUMMARY_ROW_RE);
    if (start === -1) continue;
    const line = rawLine.slice(start).trim();
    const firstNumber = line
      .split('|')
      .map((cell) => cell.trim())
      .find((cell) => /^\d{1,3}(?:\.\d+)?%?$/.test(cell));
    if (firstNumber === undefined) return null;
    const percent = Number.parseFloat(firstNumber);
    if (!Number.isFinite(percent)) return null;
    return { percent, raw: rawLine };
  }
  return null;
}

/**
 * @param {string[]} argv
 * @returns {{min:number, report:string}}
 * @throws {Error} on an unknown flag or a non-numeric threshold
 */
function parseArgs(argv) {
  const options = { min: DEFAULT_MIN_PERCENT, report: '-' };
  for (const arg of argv) {
    if (arg.startsWith('--min=')) {
      const min = Number.parseFloat(arg.slice('--min='.length));
      if (!Number.isFinite(min) || min < 0 || min > 100) {
        throw new Error(`--min must be a percentage between 0 and 100, got "${arg.slice('--min='.length)}"`);
      }
      options.min = min;
    } else if (arg.startsWith('--report=')) {
      options.report = arg.slice('--report='.length);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

/** @param {string} report @returns {Promise<string>} */
async function readReport(report) {
  if (report === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  // A UTF-8 BOM (PowerShell's default for `Out-File`) must not become part of
  // the first line.
  return fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, '');
}

if (require.main === module) {
  const options = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch (err) {
      process.stderr.write(`error   ${err.message}\n${USAGE}\n`);
      process.exitCode = 2;
      return null;
    }
  })();

  if (options !== null) {
    readReport(options.report)
      .then((output) => {
        const summary = parseCoverageSummary(output);
        if (summary === null) {
          // Fail closed: a report we cannot read must not be read as "fine".
          process.stderr.write(
            `error   no "all files" coverage summary found in ${options.report === '-' ? 'stdin' : options.report}.\n` +
              '         Run `npm run test:coverage` first, or raise --min only when you have measured the new figure.\n'
          );
          process.exitCode = 1;
          return;
        }
        if (summary.percent + Number.EPSILON < options.min) {
          process.stderr.write(
            `error   line coverage ${summary.percent}% is below the required ${options.min}%.\n` +
              '         Add tests rather than lowering the threshold.\n'
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`coverage ${summary.percent}% (minimum ${options.min}%) OK\n`);
      })
      .catch((err) => {
        process.stderr.write(`error   cannot read coverage report: ${err.code || err.message}\n${USAGE}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = { DEFAULT_MIN_PERCENT, parseArgs, parseCoverageSummary };
