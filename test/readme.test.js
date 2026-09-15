'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateReadme, slugify } = require('../scripts/validate.js');

const README_PATH = path.join(__dirname, '..', 'README.md');
const readme = fs.readFileSync(README_PATH, 'utf8');

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