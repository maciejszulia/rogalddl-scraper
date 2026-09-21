# Auditable Music Catalog CLI

A local Node.js tool that turns public, indexed Rogal DDL listings from YouTube
into a catalog and MPV playlist. It records source provenance, duplicate decisions
and cases needing review. The repository is `rogalddl-scraper`; the command is
`rogalddl`.

- Exact video IDs are grouped. Automatic deduplication needs fingerprint evidence
  for different IDs and keeps explicit variants separate; manual overrides can
  merge them. Similar titles alone produce review candidates.
- Discovery has query/result limits, bounded concurrency, timeouts and retries.
  Incremental updates use cache/checkpoints and retain older observations as stale.
- JSON reports are schema-versioned and sorted. A writer lock and staged directory
  replacement protect publication, with recovery for interrupted replacements.

## Offline quickstart

Use Linux, Node.js **22+**, Git and Bash. There are no npm dependencies or build
step. Cloning needs network access; the remaining commands use local synthetic
fixtures without querying YouTube, downloading media or starting a real player.

```bash
git clone https://gitlab.com/maciejszulia/rogalddl-scraper.git
cd rogalddl-scraper
./test-all.sh
node ./rogalddl.mjs --help
node ./rogalddl.mjs --version
```

`./test-all.sh` checks JavaScript/JSON and Bash syntax, then runs the Node test
suite. Tests cover catalog decisions, partial failures, interruption, process
arguments and installation. [CLI workflow tests](test/signals.test.mjs) exercise
`scan`, `update`, `play` and `update-play` with fake external tools.
[GitLab CI](.gitlab-ci.yml) runs the same gate for merge requests and the default
branch; no deployment job is defined.

### Optional installation

Direct execution with `node ./rogalddl.mjs COMMAND` needs no installation.
To install under your user account:

```bash
./install.sh
"$HOME/.local/bin/rogalddl" --version
"$HOME/.local/bin/rogalddl" doctor
```

The installer replaces application files in `~/.local/lib/rogalddl` and the
launcher in `~/.local/bin/rogalddl`. Override the destination with `PREFIX`; no
root access or background service is required. Add that prefix's `bin` to `PATH`
to use `rogalddl` directly.

| Operation | Additional tools |
| --- | --- |
| Offline tests, help, version | None |
| Live metadata discovery | `yt-dlp` |
| Playback | `mpv` with working YouTube extraction support |
| Fingerprints | `yt-dlp`, Chromaprint's `fpcalc`; also `ffmpeg` for `segments` mode |

`doctor` creates missing default configuration and checks local binary versions.
Its exit code is `1` unless Node, yt-dlp and MPV pass those checks. Optional
fingerprint tools are reported separately; healthy diagnostics do not prove live
extraction works.

## Commands

Live commands contact external services. Check the [rights restrictions](#rights-and-privacy)
before running them. For a permitted, bounded metadata scan:

```bash
node ./rogalddl.mjs scan \
  --query-budget 2 --result-limit 3 \
  --no-second-pass --enrichment-limit 0 \
  --fingerprint-mode metadata-only --json
```

`metadata-only` disables new fingerprint audio downloads, not network access.
The default mode is `candidates`, which can download audio. Other modes are
`fingerprint-all` and `segments`. Repeat `--fingerprint-mode metadata-only` on
later updates if you want the same download boundary.

| Command | Behavior |
| --- | --- |
| `scan` | Build a catalog from discovery results. |
| `update` | Resume compatible checkpoints and retain records outside the current snapshot. |
| `play --shuffle --no-loop` | Play the stored playlist; without flags, playback is audio-only and loops. |
| `update-play` | Update, then play. |
| `reload --ipc-socket PATH` | Replace a running MPV instance's playlist over its local socket. |
| `doctor`, `--help`, `--version` | Local diagnostics or CLI information. |

Inspect `summary.json`, `review.json` and `rejected.json` before increasing scope.
Exit `2` means a partial catalog was published; `1` reports an error. Failures
before publication preserve the previous catalog. Later checkpoint cleanup or
playback can fail after publication, so a failed command alone does not show
which generation is current. A `complete` summary describes the attempted scan,
not complete coverage of the artist's work.

Common controls include `--query-budget`, `--result-limit`, `--concurrency`,
`--timeout-ms`, `--retries`, `--no-cache`, `--enrichment-limit` and
`--fingerprint-max-bytes`. See the [parser](lib/cli.mjs) for every supported flag
and [config.example.json](config.example.json) for defaults. Unknown options,
invalid limits, malformed configuration and conflicting overrides are rejected.

## Files and review decisions

Data, configuration and cache follow XDG paths, defaulting to
`~/.local/share/rogalddl`, `~/.config/rogalddl` and `~/.cache/rogalddl`.
Override them with `--data-dir`, `--config-dir` and `--cache-dir`.

| Data output | Contents |
| --- | --- |
| `catalog.json`, `playlist.m3u8` | Accepted records and playback references |
| `duplicates.json`, `review.json`, `rejected.json` | Merge evidence, uncertain cases and exclusions |
| `long-form.json` | Albums/concerts, chapter mappings and unsegmented records |
| `fingerprints.json` | Fingerprint evidence and capability status |
| `summary.json`, `raw.json` | Run status, budgets, failures and sanitized observations |

The [override example](overrides.example.json) documents `keep`, `merge` and
`reject` decisions in the config directory's `overrides.json`. Rejection excludes
a catalog entry; it does not erase raw history or cache. Classification and
chapter mapping are heuristics. Long-form recordings stay separate; unmatched
chapters can become time-bounded MPV entries. Stale records may no longer be
available upstream.

## Rights and privacy

The adapters filter common secrets and signed media URLs. External tools run
without a shell; yt-dlp ignores ambient configuration, and MPV disables user
configuration and scripts. The CLI does not import browser cookies. Config/cache
directories use private permissions and configuration files use `0600`.
Redaction is not anonymization or a guarantee that every secret format is detected.

Fingerprint downloads pass a size limit to yt-dlp (64 MiB by default), then check
the resulting file before processing. Temporary audio is removed after success
or handled failure; SIGKILL or power loss can leave files behind. This is not
secure erasure or proof of download permission. Cache TTL controls reuse, not
deletion: expired files, catalog observations and fingerprints have no automatic
retention purge.

[YouTube's terms](https://www.youtube.com/t/terms) restrict automated access and
content use. Public visibility, metadata-only mode, temporary storage and a
fingerprint match do not establish permission or copyright ownership. Check
applicable terms and required permissions before live use; the tool cannot decide
which [copyright permission or exception](https://support.google.com/youtube/answer/2797466?hl=en)
applies. Offline tests establish local behavior, not live compatibility or legal
compliance.

There is currently no `LICENSE` file or `package.json` license field. This README
does not select a software license. External tools and third-party content have
separate rights.

## Code and project policies

- [CLI](lib/cli.mjs) and [configuration](lib/config.mjs): commands, validation and paths.
- [Discovery](lib/discovery.mjs), [cache](lib/cache.mjs), [yt-dlp adapter](lib/ytdlp.mjs): bounded queries and metadata.
- [Classification](lib/classify.mjs), [deduplication](lib/dedupe.mjs), [catalog](lib/catalog.mjs): decisions and reports.
- [Pipeline](lib/pipeline.mjs), [file I/O](lib/io.mjs): coordination and publication.
- [Fingerprinting](lib/fingerprint.mjs), [player](lib/player.mjs), [processes](lib/process.mjs), [redaction](lib/security.mjs): external-tool boundaries.

Start review with the [catalog](test/catalog.test.mjs), [pipeline](test/pipeline.test.mjs)
and [I/O/player](test/io-player.test.mjs) tests.
See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and
[CHANGELOG.md](CHANGELOG.md) for project policies.
