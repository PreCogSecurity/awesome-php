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
- `npm run lint` — standalone validation command.
- `npm run check:links` — opt-in link-liveness auditing tool.
- Docker Compose service (`docker compose run --rm validate`) for running the
  validation suite in an isolated container.
- `.nvmrc` pinning the recommended Node.js version.
- PR and issue templates (`.github/PULL_REQUEST_TEMPLATE.md`,
  `.github/ISSUE_TEMPLATE.md`).
- `.github/repo-metadata.yml` identifying this as a curated awesome list.
- Repository classification note at the top of README.md.
- Development section in README.md documenting install, test, and lint commands.
- This changelog.

### Fixed

- Malformed list entries (URL whitespace, missing dash separator, missing
  description).
- 14 list entries missing trailing periods per CONTRIBUTING.md.
- Three missing TOC entries (Scraping, Other Books, PHP Magazines).
- Escaped brackets in the `php[architect]` label for link validity.
