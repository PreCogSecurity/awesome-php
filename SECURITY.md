# Security Policy

## What this repository is

Awesome PHP is a **curated Markdown list**, not a software package. It has no
runtime, no dependencies and no secrets. The only executable code is the Node
maintenance tooling in `scripts/`:

| Script                     | Purpose                                                              | Network |
| -------------------------- | -------------------------------------------------------------------- | ------- |
| `scripts/validate.js`     | Validates README structure, entry format, URLs, headings and table of contents | no |
| `scripts/check-links.js`  | Opt-in audit of whether the listed links still resolve                | yes     |
| `scripts/check-coverage.js` | Enforces the CI coverage threshold from a coverage report           | no |

Because the list is public, "vulnerability" here usually means a reader being
misled or attacked rather than a running service being exploited.

## Supported versions

This project has no released versions and no end-of-life surface to patch: the
list is updated on `master`. Security fixes are applied to `master` as part of
the next merge.

## Reporting a vulnerability

**Do not open a public issue for anything that could be used against a reader
or a maintainer.** Use GitHub's private vulnerability reporting
("Security" → "Report a vulnerability") at
<https://github.com/PreCogSecurity/awesome-php/security/advisories/new>.

Please include the entry (section plus the full `* [Name](URL) - Description.`
line), what the problem is, and how someone could notice it. We aim to respond
within a few days.

Dead or merely outdated links are **not** security issues: report those with the
[dead-link issue template](.github/ISSUE_TEMPLATE.md).

## What counts as a security issue here

- An entry whose visible text or domain does not match the link it points at
  (Unicode bidi-override or homoglyph tricks, look-alike domains, `javascript:`
  or data-URI style redirects).
- A link that a reader would reasonably follow to a page that serves malware,
  credential harvesting, or a browser exploit kit.
- Anything that makes `scripts/check-links.js` contact a host a reader or
  maintainer did not intend, such as loopback, RFC1918, link-local or cloud
  instance-metadata addresses.
- A workflow or dependency change that would execute unreviewed code in CI.
- A committed secret of any kind (tokens, keys, `.env` files). `.env` files are
  in `.gitignore`; if one is ever committed, treat it as compromised and rotate
  it rather than removing it.

## Security properties this repository maintains

- **Zero third-party dependencies.** There is no runtime or development
  dependency tree to audit or hijack; CI installs with `--ignore-scripts` and
  gates on `npm audit --audit-level=high`.
- **No inline code in the list.** Entries are plain links and descriptions. The
  validator rejects URLs that embed credentials, and rejects lines containing
  control characters or bidi overrides.
- **Refuse to probe private networks.** `scripts/check-links.js` resolves DNS
  and skips any host that is not publicly routable, on the first hop and on
  every redirect hop.
- **Least privilege in CI.** The workflow declares `permissions: contents: read`
  and no workflow secrets, so a compromised step cannot push, comment or read
  credentials.
- **Untrusted input is escaped before it reaches CI output.** Validator findings
  are attacker-influenceable text; `scripts/validate.js` escapes `%`, newlines
  and annotation property separators so a crafted README cannot forge a
  workflow annotation.
- **Line endings and whitespace are enforced** (`.gitattributes`,
  `.editorconfig`) so that a patch cannot smuggle a CRLF-only change past review.
