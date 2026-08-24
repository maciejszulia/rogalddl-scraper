# Contributing

## Scope

Changes should preserve the project's core boundary: catalog public and indexed metadata without bypassing access controls or building a persistent downloaded-audio library.

Before starting substantial work, open an issue describing the intended behavior, affected commands and compatibility impact.

## Development setup

Use Node.js 22 or newer. The project intentionally has no required npm dependencies.

Run the complete offline suite before opening a merge request:

```bash
./test-all.sh
```

Tests must not require live YouTube access, cookies, a user account or production configuration. Use deterministic fixtures and temporary directories.

## Merge requests

A merge request should contain:

- one focused change;
- the user-visible or operational outcome;
- exact verification commands and results;
- a regression test for a bug fix when practical;
- compatibility and migration notes when schemas or CLI flags change;
- confirmation that generated artifacts and diagnostics contain no credentials.

Keep commits in English and use an imperative Conventional Commit subject, for example:

```text
fix(scan): preserve the previous catalog after enrichment failure
```

## Security and privacy

Read `SECURITY.md` before reporting a vulnerability. Never commit or paste:

- YouTube cookies, signed media URLs or authentication headers;
- access tokens, private keys or shell histories;
- downloaded audio samples or local fingerprint scratch data;
- private configuration from another user.

Fixtures must use unmistakably synthetic values. Redaction tests should prove that a secret-like input is removed without including a live secret.

## Design expectations

Prefer:

- standard-library implementations when practical;
- explicit schemas and deterministic ordering;
- atomic publication and fail-safe recovery;
- bounded concurrency, timeouts and resource limits;
- conservative classification and deduplication;
- `spawn()` with argument arrays and `shell: false`;
- clear partial-success reporting over silent data loss.

Avoid adding a dependency or network service when the same property can be achieved with the existing runtime and test structure.
