'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REPORT_FORMATS, escapeWorkflowCommand, parseArgv, renderReport, slugify, validateReadme } = require('../scripts/validate.js');

const README_PATH = path.join(__dirname, '..', 'README.md');
const readme = fs.readFileSync(README_PATH, 'utf8');

/**
 * Builds a minimal document with a table of contents that matches its
 * headings, so a test can assert "no errors" without the TOC rule firing
 * first.
 *
 * @param {string[]} sectionTitles
 * @param {string} body
 * @returns {string}
 */
function document(sectionTitles, body) {
  const toc = sectionTitles.map((title) => `    - [${title}](#${slugify(title)})`).join('\n');
  const headings = sectionTitles.map((title) => `## ${title}\n`).join('\n');
  return ['# Test', '', '## Table of Contents', '- [Test](#test)', toc, '', headings, '', body].join('\n');
}

test('README.md exists and is non-empty', () => {
  assert.ok(readme.trim().length > 0, 'README.md should contain content');
});

test('README.md passes all validation rules', () => {
  const { errors } = validateReadme(readme);
  const detail = errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n');
  assert.deepEqual(errors, [], `README.md validation errors:\n${detail}`);
});

test('README.md identifies itself as a curated resource list', () => {
  assert.match(readme, /curated resource list/i);
});

test('slugify produces GitHub-style anchors', () => {
  assert.equal(slugify('Dependency Management'), 'dependency-management');
  assert.equal(slugify('E-commerce'), 'e-commerce');
  assert.equal(slugify('Third Party APIs'), 'third-party-apis');
  assert.equal(slugify('Internationalisation and Localisation'), 'internationalisation-and-localisation');
});

test('validator rejects an entry that does not match the documented format', () => {
  const bad = '# Test\n\n## Section\n\n* [Broken](https://example.com) no dash here\n';
  const { errors } = validateReadme(bad);
  assert.ok(
    errors.some((e) => /does not match the documented format/.test(e.message)),
    'expected a format error'
  );
});

test('validator rejects duplicate URLs', () => {
  const bad = '# Test\n\n## Section\n\n* [A](https://example.com) - First.\n* [B](https://example.com) - Second.\n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /duplicate URL/.test(e.message)), 'expected a duplicate URL error');
});

test('validator rejects entries without a description', () => {
  const bad = '# Test\n\n## Section\n\n* [A](https://example.com)\n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /missing a description/.test(e.message)), 'expected a missing description error');
});

test('validator rejects descriptions without a trailing period', () => {
  const bad = '# Test\n\n## Section\n\n* [A](https://example.com) - No period here\n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /end with a period/.test(e.message)), 'expected a period error');
});

test('validator rejects trailing whitespace', () => {
  const bad = '# Test\n\n## Section\n\n* [A](https://example.com) - First. \n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /trailing whitespace/.test(e.message)), 'expected a trailing whitespace error');
});

test('validator rejects invalid URLs', () => {
  const bad = '# Test\n\n## Section\n\n* [A](not-a-url) - First.\n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /does not match the documented format/.test(e.message)), 'expected a format error');
});

test('validator flags duplicate labels as warnings', () => {
  const bad = '# Test\n\n## Section\n\n* [Same](https://example.com/a) - First.\n* [Same](https://example.com/b) - Second.\n';
  const { warnings } = validateReadme(bad);
  assert.ok(warnings.some((w) => /duplicate label/.test(w.message)), 'expected a duplicate label warning');
});

test('validator accepts the documented paired and numbered entry formats', () => {
  const good =
    '# Test\n\n' +
    '## Table of Contents\n' +
    '- [Test](#test)\n' +
    '    - [Section](#section)\n\n' +
    '## Section\n\n' +
    '* [A](https://example.com/a)/[B](https://example.com/b) - A paired entry.\n' +
    '* Series: [1](https://example.com/1) [2](https://example.com/2) - A numbered entry.\n';
  const { errors } = validateReadme(good);
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.map((e) => e.message).join('\n')}`);
});

// ---------------------------------------------------------------------------
// slugify fidelity with GitHub's anchor algorithm
// ---------------------------------------------------------------------------

test('slugify keeps underscores and strips punctuation GitHub strips', () => {
  assert.equal(slugify('Rate_Limiting'), 'rate_limiting');
  assert.equal(slugify('The Tangled Web — Securing Web Applications'), 'the-tangled-web--securing-web-applications');
  assert.equal(slugify('  Spaced  Out  '), 'spaced--out');
  assert.equal(slugify('php[architect]'), 'phparchitect');
  assert.equal(slugify('Café & Crème'), 'café--crème', 'the ampersand is dropped, leaving the two spaces GitHub also keeps');
});

test('slugify removes badge images and links from a heading', () => {
  // The README's H1 carries a CI badge; the TOC anchor must stay #awesome-php.
  assert.equal(slugify('Awesome PHP [![CI](https://ci.example/badge.svg)](https://ci.example)'), 'awesome-php');
});

// ---------------------------------------------------------------------------
// Security-relevant content checks
// ---------------------------------------------------------------------------

test('validator rejects URLs that embed credentials', () => {
  // A userinfo section in a public document is a leaked credential: it is
  // visible in the file, in rendered HTML and in every referrer header.
  const bad = document(['Section'], '* [A](https://user:hunter2@example.com/a) - Leaks a secret.\n');
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /must not embed credentials/.test(e.message)), 'expected a credentials error');
  assert.ok(
    !errors.some((e) => e.message.includes('hunter2')),
    'the reported error must not echo the credential back into the log'
  );
});

test('validator rejects invisible and bidi-override characters', () => {
  // "Trojan Source": a crafted label can render as one domain while the link
  // points at another. Control characters render as nothing at all.
  const bad = document(['Section'], '* [php\u202Egnp.exe](https://evil.example/x) - Spoofed.\n');
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /invisible or bidi-override/.test(e.message)), 'expected a text-spoofing error');
});

test('validator accepts ordinary non-ASCII prose such as an em dash', () => {
  const good = document(['Section'], '* [A](https://example.com/a) - Uses an em dash — like this.\n');
  const { errors } = validateReadme(good);
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.map((e) => e.message).join('\n')}`);
});

test('validator warns about lines longer than the configured limit', () => {
  const good = document(['Section'], `* [A](https://example.com/a) - ${'x'.repeat(80)}.\n`);
  const { errors, warnings } = validateReadme(good, { maxLineLength: 60 });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /line is \d+ characters/.test(w.message)), 'expected a line-length warning');
});

// ---------------------------------------------------------------------------
// Heading de-duplication
// ---------------------------------------------------------------------------

test('validator mirrors GitHub anchor de-duplication and accepts the disambiguated TOC', () => {
  const good =
    '# Test\n\n' +
    '## Table of Contents\n' +
    '- [Test](#test)\n' +
    '    - [Section](#section)\n' +
    '    - [Section](#section-1)\n\n' +
    '## Section\n\n' +
    '## Section\n';
  const { errors, warnings, headings } = validateReadme(good);
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.map((e) => e.message).join('\n')}`);
  assert.deepEqual(
    headings.map((h) => h.anchor),
    ['test', 'table-of-contents', 'section', 'section-1']
  );
  assert.ok(warnings.some((w) => /duplicate heading "Section"/.test(w.message)), 'expected a duplicate-heading warning');
});

test('validator still rejects a table of contents entry that matches no heading', () => {
  const bad = '# Test\n\n## Table of Contents\n- [Nope](#nope)\n';
  const { errors } = validateReadme(bad);
  assert.ok(errors.some((e) => /does not match any heading/.test(e.message)), 'expected a TOC error');
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('validator findings carry a severity', () => {
  const bad = document(['Section'], '* [A](https://example.com/a) - No period\n');
  const { errors, warnings } = validateReadme(bad);
  assert.ok(errors.length > 0, 'expected an error for the missing period');
  assert.ok(errors.every((e) => e.severity === 'error'));
  assert.ok(warnings.every((w) => w.severity === 'warning'));
});

test('parseArgv reads the supported flags', () => {
  assert.deepEqual(parseArgv([]), { format: 'text', showWarnings: false, strict: false });
  assert.deepEqual(parseArgv(['--warnings', '--strict', '--format=json']), {
    format: 'json',
    showWarnings: true,
    strict: true,
  });
});

test('renderReport exits 0 on a clean document and 1 when there are errors', () => {
  const clean = validateReadme(document(['Section'], '* [A](https://example.com/a) - First.\n'));
  assert.equal(renderReport(clean, { write: () => {} }).exitCode, 0);
  const broken = validateReadme(document(['Section'], '* [A](not-a-url) - Bad.\n'));
  assert.equal(renderReport(broken, { write: () => {} }).exitCode, 1);
});

test('renderReport --strict promotes warnings to a failure', () => {
  const warned = validateReadme(
    document(['Section'], '* [Same](https://example.com/a) - First.\n* [Same](https://example.com/b) - Second.\n')
  );
  assert.equal(renderReport(warned, { write: () => {} }).exitCode, 0);
  assert.equal(renderReport(warned, { strict: true, write: () => {} }).exitCode, 1);
});

test('renderReport emits a machine-readable JSON report', () => {
  const result = validateReadme(document(['Section'], '* [A](https://example.com/a) - First.\n'));
  let sink = '';
  const { output, exitCode } = renderReport(result, { format: 'json', write: (t) => (sink += t) });
  const parsed = JSON.parse(output);
  assert.equal(sink, output, 'the report is also written to the injected sink');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.source, 'README.md');
  assert.equal(parsed.summary.entries, 1);
  assert.deepEqual(parsed.findings, []);
  assert.equal(exitCode, 0);
});

test('renderReport emits GitHub Actions annotations on the right lines', () => {
  const source = document(['Section'], '* [A](https://example.com/a) - First.\n* [A](https://example.com/a) - Second.\n');
  const { errors } = validateReadme(source);
  let sink = '';
  const { output, exitCode } = renderReport(validateReadme(source), {
    format: 'github',
    showWarnings: true,
    write: (t) => (sink += t),
  });
  assert.equal(sink, output);
  assert.equal(exitCode, 1);
  assert.match(output, new RegExp(`^::error file=README\\.md,line=${errors[0].line}::duplicate URL`, 'm'));
  assert.ok(output.endsWith('README.md failed validation with 1 error(s).\n'));
});

test('renderReport rejects an unknown format instead of printing nothing', () => {
  assert.throws(() => renderReport(validateReadme('# Test\n'), { format: 'yaml' }), /unknown report format "yaml"/);
  for (const format of REPORT_FORMATS) {
    assert.doesNotThrow(() => renderReport(validateReadme('# Test\n'), { format, write: () => {} }));
  }
});

test('escapeWorkflowCommand neutralises forged workflow commands', () => {
  // README.md is attacker-influenced and workflow commands are read from the
  // log, so an unescaped message could forge an annotation.
  assert.equal(escapeWorkflowCommand('100% done'), '100%25 done');
  assert.equal(escapeWorkflowCommand('a\n::warning::spoofed'), 'a%0A::warning::spoofed');
  assert.equal(escapeWorkflowCommand('a\r\nb'), 'a%0D%0Ab');
  assert.equal(escapeWorkflowCommand('README.md,line=1', { property: true }), 'README.md%2Cline=1');
  assert.equal(escapeWorkflowCommand('C:\\path', { property: true }), 'C%3A\\path');
});

test('renderReport output cannot be used to forge a workflow command', () => {
  const forged = document(
    ['Section'],
    '* [A](https://example.com/a) - First. \n::warning::forged annotation\n* [A](https://example.com/a) - Second.\n'
  );
  let sink = '';
  const { output } = renderReport(validateReadme(forged), {
    format: 'github',
    showWarnings: true,
    write: (t) => (sink += t),
  });
  const commands = output.split('\n').filter((line) => line.startsWith('::'));
  assert.ok(commands.length >= 1, 'expected at least one annotation');
  for (const line of commands) {
    assert.match(line, /^::(error|warning) file=README\.md,line=\d+::/, `unexpected command: ${line}`);
  }
  assert.equal(sink, output);
});