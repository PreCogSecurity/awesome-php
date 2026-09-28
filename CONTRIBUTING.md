# Contribution Guidelines
Unfortunately, not every library, tool or framework can be considered for inclusion. The aim of Awesome PHP is to be a concise list of noteworthy and interesting software written in modern PHP. Therefore, suggested software should: 

a) Be widely recommended regardless of personal opinion  
b) Well known or discussed within the PHP community  
c) Be unique in its approach or function  
d) Fill a niche gap in the market  

Self-promotion is frowned upon, so please consider seriously whether your project meets the criteria before opening a pull request, otherwise it may be closed without being reviewed.

Also, please ensure your pull request adheres to the following guidelines:

* Software that is PHP 5.5+, Composer-installable, PSR compliant, semantically versioned, united tested and well documented in English is preferred.
* Please search previous suggestions before making a new one, as yours may be a duplicate.
* Enter a meaningful pull request description.
* Please make an individual commit for each suggestion in a separate pull request.
* Put a link to each library in your pull request ticket so it's easier to review.
* Use the following format for libraries: \[LIBRARY\]\(LINK\) - DESCRIPTION.
* Prefix duplicate library names with their vendor or namespace followed by a space: Foo\Bar would be Foo Bar.
* New categories, or improvements to the existing categorisation, are always welcome.
* Please keep descriptions short, simple and unbiased. No buzzwords or marketing jargon. 
* End all descriptions with a full stop/period.
* Check your spelling and grammar.
* Make sure your text editor is set to remove trailing whitespace (the included `.editorconfig` does this for you).
* Do not paste credentials, tokens or private URLs into an entry. The validator rejects URLs that embed credentials, but a leaked secret is leaked even if the entry is later removed — rotate it.

## Before you open a pull request

Everything below runs on Node.js 22 (see `.nvmrc`); the project has no third-party dependencies, so the install is instant.

```sh
npm ci
npm run verify    # lint + test + npm audit
```

* `npm run lint` checks the entry format, descriptions, URLs, headings and table of contents. Add `--warnings` to see advisory findings such as duplicate labels.
* `npm test` runs the test suite for the maintenance tooling itself. If you change anything in `scripts/`, add or update the test that pins the new behaviour in the same pull request.
* If you change `scripts/`, also run `npm run test:coverage` and keep coverage at or above the 80% threshold CI enforces.
* `npm run check:links` confirms the link you added resolves. It only contacts publicly routable addresses, so a link to an internal host is reported as skipped rather than fetched.

## Templates

Please use the provided pull request and issue templates when contributing:

* **[Pull Request Template](../.github/PULL_REQUEST_TEMPLATE.md)** — required for new library suggestions.
* **[Issue Template](../.github/ISSUE_TEMPLATE.md)** — for reporting dead links or removal requests.

## Commit messages

One logical change per commit, described with [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `fix: reject URLs with embedded credentials`, `test: cover the HEAD-to-GET retry`, `ci: enforce the coverage threshold`. Please also update [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]` when a change is visible to contributors or to users of the tooling.

If you believe a change has a security impact, follow [SECURITY.md](SECURITY.md) rather than describing it in a public issue.

Thank you for your suggestions!
