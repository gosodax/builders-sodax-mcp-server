# Security policy

**Don't open a public issue for a security vulnerability.** SODAX software moves user funds, and a public report can put those users at risk before a fix ships.

## Reporting a vulnerability

Report privately, by either:

1. **GitHub private vulnerability reporting:** [open a draft security advisory](https://github.com/gosodax/builders-sodax-mcp-server/security/advisories/new). This is preferred, because the report stays attached to the repository.
2. **Email:** `security@sodax.com` with **SECURITY** in the subject.

Include the affected component and version or commit, the impact, steps to reproduce, and any relevant chain or transaction references. Never include secrets, private keys or live credentials in a report.

## What to expect

- We aim to acknowledge a report within a few business days.
- We confirm the issue, keep you updated on the fix, and agree on disclosure timing with you.
- We publish the advisory once the fix has shipped.
- Please give us reasonable time to fix the issue before any public disclosure.

## Scope

This policy covers the code in this repository (`gosodax/builders-sodax-mcp-server`). If you are not sure whether a finding belongs here, report it anyway and say so; a maintainer routes it.

## Security issue or ordinary bug?

Treat it as a security issue if it can lead to loss or theft of funds, unauthorised access, leaked or reusable keys or signatures, forged or replayed cross-chain messages, or malicious code reaching a release. Anything else is an ordinary bug: open a public issue.
