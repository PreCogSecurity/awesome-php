# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automated validation suite (`npm test`) that checks README structure, entry
  format, table-of-contents consistency and URL syntax.
- GitHub Actions CI workflow (`ci.yml`) running the validation on every push
  and pull request.
- `npm run lint` — standalone validation command, with `--warnings`,
  `--strict`, `--format=json` and `--format=github` (GitHub Actions
  annotations) options.
- `npm run check:links` — opt-in link-liveness auditing tool.
- `npm run test:coverage` and `npm run coverage:check` — coverage measurement
  and an 80% threshold enforced in CI, using Node's built-in coverage output
  and no new dependency.
- `npm run verify` — the lint, test and audit sequence CI runs, in one command.
- Tests for `scripts/check-links.js` (URL extraction, timeout parsing, the
  HEAD-to-GET retry, redirects, DNS failure handling, private-network blocking)
  and for the coverage gate, taking the suite from 12 to 70 tests across three
  files.
- Docker Compose service (`docker compose run --rm validate`) for running the
  validation suite in an isolated container.
- `.nvmrc` pinning the recommended Node.js version, and an `engines` field
  that matches it.
- `.gitignore`, `.gitattributes` and `.editorconfig`, so dependency
  directories, local `.env` files, CRLF churn and trailing whitespace cannot
  reach a commit.
- `SECURITY.md` documenting what a vulnerability means for a documentation
  repository, how to report one privately, and the security properties the
  tooling maintains.
- PR and issue templates (`.github/PULL_REQUEST_TEMPLATE.md`,
  `.github/ISSUE_TEMPLATE.md`).
- `.github/dependabot.yml` keeping `package.json` and the GitHub Actions
  versions current.
- `.github/repo-metadata.yml` identifying this as a curated awesome list.
- Repository classification note at the top of README.md.
- Development section in README.md documenting install, test, lint, coverage
  and audit commands, plus the supported environment variables.
- This changelog.

### Security

- `scripts/validate.js` now rejects URLs that embed credentials
  (`https://user:pass@host/`) and reports the host instead of the secret, and
  rejects lines containing control characters or Unicode bidi overrides, which
  can be used to make a link's visible text differ from its destination.
- `scripts/validate.js` escapes `%`, newlines and annotation property
  separators before printing findings as GitHub Actions annotations, so a
  crafted README line cannot inject a forged workflow command into CI output.
- `scripts/check-links.js` refuses to contact any host that is not publicly
  routable — loopback, RFC1918, CGNAT, link-local (including
  `169.254.169.254`), multicast, unique-local IPv6 and IPv4-mapped forms of all
  of those — both for the URL in the README and for every redirect hop. DNS is
  resolved first, so a public-looking hostname pointing at a private address is
  caught too.
- CI declares `permissions: contents: read`, uses no secrets, installs with
  `npm ci --ignore-scripts` and gates on `npm audit --audit-level=high`.
- `.gitignore` covers `.env` files so a local secret cannot be committed by
  accident.

### Fixed

- `scripts/check-links.js` no longer reports a live link as dead when the HEAD
  attempt hits the timeout: the GET retry used to share the already-aborted
  `AbortController`. Each attempt now gets its own timeout budget.
- `scripts/check-links.js` validates `CHECK_LINKS_TIMEOUT_MS` instead of
  passing it straight to `setTimeout`, where a non-numeric or negative value
  made every request abort instantly and the whole list look dead.
- `scripts/check-links.js` no longer extracts a truncated URL from a link with
  balanced parentheses, and no longer spends a second request on links that
  answer `404`.
- `scripts/validate.js` matches GitHub's anchor algorithm for underscores,
  non-ASCII letters and repeated spaces, and de-duplicates repeated heading
  names the way GitHub does, so a legitimate duplicate heading no longer fails
  the table-of-contents check.
- Malformed list entries (URL whitespace, missing dash separator, missing
  description).
- 14 list entries missing trailing periods per CONTRIBUTING.md.
- Three missing TOC entries (Scraping, Other Books, PHP Magazines).
- Escaped brackets in the `php[architect]` label for link validity.

### Removed

- `.travis.yml`. GitHub Actions is the only CI system, and the README badge
  pointed at a dead travis-ci.org URL for the upstream project.
