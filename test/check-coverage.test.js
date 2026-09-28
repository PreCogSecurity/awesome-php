'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DEFAULT_MIN_PERCENT, parseArgs, parseCoverageSummary } = require('../scripts/check-coverage.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-coverage.js');

/** Runs the gate the way CI does, against a report written to a temp file. */
function runGate(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function reportFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awesome-php-coverage-')), 'coverage-summary.txt');
  fs.writeFileSync(file, contents);
  return file;
}

// Verbatim captures of the two coverage-table shapes Node has shipped: the
// `% Stmts` header (Node 20/22) and the `line %` header (newer releases).
const NODE_22_REPORT = [
  'ℹ tests 56',
  'ℹ pass 56',
  'ℹ fail 0',
  'ℹ start of coverage report',
  'ℹ --------------------------------------------------------------------------------------------------',
  'ℹ file                 | % Stmts | % Branch | % Funcs | % Lines | Uncovered Lines ',
  'ℹ --------------------------------------------------------------------------------------------------',
  'ℹ scripts              |   93.55 |    85.71 |   93.33 |   93.55 |                     |',
  'ℹ  check-links.js      |   91.30 |    78.00 |   91.11 |   91.30 | 122-123 175-177   |',
  'ℹ  validate.js         |   95.65 |    92.86 |   95.45 |   95.65 | 91-92 98-100        |',
  'ℹ --------------------------------------------------------------------------------------------------',
  'ℹ All files            |   93.55 |    85.71 |   93.33 |   93.55 |                     |',
  'ℹ --------------------------------------------------------------------------------------------------',
  'ℹ end of coverage report',
  '',
].join('\n');

const NODE_26_REPORT = [
  'ℹ all files       |  89.51 |    78.71 |   88.24 | ',
  'ℹ ----------------------------------------------------------------------------------------------------------------------------',
  'ℹ end of coverage report',
  '',
].join('\n');

test('parseCoverageSummary reads the aggregate row on Node 20/22 reports', () => {
  assert.deepEqual(parseCoverageSummary(NODE_22_REPORT), { percent: 93.55, raw: 'ℹ All files            |   93.55 |    85.71 |   93.33 |   93.55 |                     |' });
});

test('parseCoverageSummary reads the aggregate row on newer Node reports', () => {
  assert.equal(parseCoverageSummary(NODE_26_REPORT).percent, 89.51);
});

test('parseCoverageSummary tolerates a non-TAP reporter and CRLF endings', () => {
  const tap = [
    'TAP version 13',
    '1..1',
    '# start of coverage report',
    '# file            | % Stmts | % Branch | % Funcs | % Lines |',
    '# all files       |   90.00 |    80.00 |   90.00 |   90.00 |',
  ].join('\r\n');
  assert.equal(parseCoverageSummary(tap).percent, 90);
});

test('parseCoverageSummary finds the row behind a BOM or mangled prefix', () => {
  // Output that has been through a re-encoding filter (PowerShell's
  // Out-File, a CI log collector) can lose the reporter's own prefix; the
  // aggregate row must still be found.
  assert.equal(parseCoverageSummary('\uFEFF?? all files          |  90.39 |    80.48 |   89.83 | ').percent, 90.39);
  assert.equal(parseCoverageSummary('  node:internal/test_runner  all files | 70.00 | 60.00 | 70.00 |').percent, 70);
});

test('parseCoverageSummary does not mistake a filename for the summary row', () => {
  assert.equal(parseCoverageSummary('  all files.js |  50.00 | 40.00 | 50.00 | 50.00 |'), null);
});

test('parseCoverageSummary returns null when the report is missing or unusable', () => {
  assert.equal(parseCoverageSummary(''), null);
  assert.equal(parseCoverageSummary('ℹ tests 56\nℹ pass 56\n'), null, 'a report that died before printing coverage');
  assert.equal(parseCoverageSummary('ℹ all files       |        |          |         | \n'), null, 'no files were measured');
});

test('parseArgs defaults to a 80% minimum and reading stdin', () => {
  assert.deepEqual(parseArgs([]), { min: 80, report: '-' });
  assert.equal(DEFAULT_MIN_PERCENT, 80);
  assert.deepEqual(parseArgs(['--min=95', '--report=coverage-summary.txt']), {
    min: 95,
    report: 'coverage-summary.txt',
  });
});

test('parseArgs rejects nonsense thresholds and unknown flags', () => {
  assert.throws(() => parseArgs(['--min=soon']), /--min must be a percentage/);
  assert.throws(() => parseArgs(['--min=120']), /--min must be a percentage/);
  assert.throws(() => parseArgs(['--min=-1']), /--min must be a percentage/);
  assert.throws(() => parseArgs(['--verbose']), /unknown argument "--verbose"/);
});

// ---------------------------------------------------------------------------
// CLI contract (what CI depends on)
// ---------------------------------------------------------------------------

test('the gate passes a report that meets the threshold', () => {
  const result = runGate([`--report=${reportFile(NODE_22_REPORT)}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /coverage 93\.55% \(minimum 80%\) OK/);
});

test('the gate fails a report below the threshold', () => {
  const result = runGate([`--report=${reportFile(NODE_26_REPORT)}`, '--min=95']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /line coverage 89\.51% is below the required 95%/);
});

test('the gate fails closed when the report has no coverage summary', () => {
  // A crashed test run or a Node version that drops the report must not be
  // read as "coverage is fine".
  const result = runGate([`--report=${reportFile('ℹ tests 1\nℹ fail 1\n')}`]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no "all files" coverage summary found/);
});

test('the gate reports an unreadable report file and a bad flag', () => {
  assert.equal(runGate(['--report=does-not-exist.txt']).status, 1);
  const bad = runGate(['--min=nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--min must be a percentage/);
});
