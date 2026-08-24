# Security policy

## Supported version

Security fixes are applied to the latest revision of the default branch. This project does not currently maintain parallel release branches.

## Reporting a vulnerability

Do not publish vulnerabilities, credentials, private YouTube cookies, signed media URLs, access tokens or proof-of-concept data in a public issue.

Report the problem privately to the repository owner through GitLab. Include:

- the affected command and version or commit;
- the smallest safe reproduction;
- expected and observed behavior;
- potential impact;
- whether temporary files, MPV IPC, child processes, configuration permissions, redaction or catalog publication are involved.

Do not include live credentials. Replace them with unmistakable placeholders.

## Security boundaries

The project is designed to:

- catalog public and indexed metadata rather than bypass access controls;
- avoid persisting downloaded audio;
- keep fingerprint samples temporary and size-bounded;
- invoke external programs without a shell;
- redact common secret-bearing fields from artifacts and diagnostics;
- reject unsafe configuration ownership, permissions and symlinks;
- preserve the last valid catalog when a scan fails or is interrupted.

A report showing that any of these properties can be bypassed is security-relevant.

## Disclosure process

The owner will first reproduce and classify the report, then prepare a regression test and fix on a private branch when appropriate. Public details should be released only after users have a safe version available.
