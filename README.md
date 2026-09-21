# Auditable Music Catalog CLI

A local Node.js tool for organizing public, indexed Rogal DDL music listings from
YouTube into a reviewable catalog and MPV playlist. Repository and command names
remain `rogalddl-scraper` and `rogalddl`.

Music search results mix original recordings, reuploads, remixes, interviews and
full concerts. This project makes those decisions inspectable: each record keeps
its source history, uncertain matches go to a review queue, and duplicate decisions
record their evidence. It stores metadata and links; audio fingerprinting is an
optional processing path that uses temporary downloads.

**Stack:** Node.js 22+ · JavaScript ESM · built-in Node test runner · Bash installer.
No npm dependencies, database server or background service is required.

## Engineering highlights

- **Explainable decisions.** Source provenance, separate review/rejection reports,
  schema-versioned JSON and reproducible ordering make catalog changes traceable.
- **Conservative deduplication.** Exact IDs are grouped; similar titles alone do
  not merge uploads. Fingerprint evidence or explicit human overrides are needed,
  while remixes, live recordings and other explicit variants remain distinct.
- **Failure-aware operation.** Bounded concurrency, timeouts, retries, cache and
  resumable updates handle unreliable upstream results. Partial publication has
  an explicit exit code; failed scans preserve the last published catalog.
- **Careful local execution.** External commands use argument arrays without a
  shell. Configuration validation, secret redaction, private file permissions,
  a writer lock and staged publication protect local operation.
- **Reproducible review.** Offline tests exercise the real CLI with synthetic
  tools, including interruption, partial results and installation into paths
  containing spaces. The same command runs in GitLab CI.

**Project ownership:** an AI-assisted project coordinated by Maciej Szulia.
The repository presents the implementation and its verification evidence; commit
identity is not a claim that every line was written manually or by one person.

## Start here: offline evaluation

Use Linux with Node.js 22 or newer, Git and Bash. No npm install is needed.
The clone requires network access; every command after checkout below runs locally
without querying YouTube, downloading media or starting a real player.

```bash
git clone https://gitlab.com/maciejszulia/rogalddl-scraper.git
cd rogalddl-scraper
node --version
./test-all.sh
node ./rogalddl.mjs --help
node ./rogalddl.mjs --version
```

`./test-all.sh` checks JavaScript/JSON syntax, Bash syntax and the full Node test
suite. Fixtures replace external services and media tools. The CLI workflow tests
in [test/signals.test.mjs](test/signals.test.mjs) run `scan`, `update`, `play` and
`update-play` against isolated synthetic data, then check exit codes and output.
This is the recommended interview demonstration.

### Optional local installation

Run directly with `node ./rogalddl.mjs COMMAND`, or install for your user:

```bash
./install.sh
"$HOME/.local/bin/rogalddl" --version
"$HOME/.local/bin/rogalddl" doctor
```

The installer copies application files into `~/.local/lib/rogalddl` and replaces
`~/.local/bin/rogalddl`. It supports a separate prefix, for example
`PREFIX="$PWD/.tmp/install" ./install.sh`. No root access or service manager is
required. Add the chosen `bin` directory to `PATH` to use the short command name.

`doctor` creates default configuration when absent and checks local binary
versions; it does not scan YouTube. Exit `1` means required scan/playback tools
are missing or unavailable, even if the offline suite passes.

| Operation | Additional local tools |
| --- | --- |
| Offline tests and CLI help | None |
| Live metadata discovery | `yt-dlp` |
| Playback | `mpv` with working YouTube extraction support |
| Audio fingerprints | `yt-dlp` and `fpcalc` from Chromaprint |
| Segmented fingerprints | The above plus `ffmpeg` |

## Commands and external access

Live discovery and playback contact external services. Use them only where your
access and use are permitted under the applicable platform terms and content
rights; see [rights and privacy boundaries](#rights-and-privacy-boundaries).

| Command | Behavior |
| --- | --- |
| `scan` | Build a catalog from the configured discovery sources. |
| `update` | Resume compatible checkpoints and retain prior records outside the current bounded snapshot. |
| `play` | Open the stored playlist in MPV; audio-only playback loops by default. |
| `update-play` | Update, then play. |
| `reload --ipc-socket PATH` | Replace the playlist through a running MPV instance's local IPC socket. |
| `doctor` | Report local paths, binary versions and available capabilities as JSON. |
| `--help`, `--version` | Inspect the CLI without creating configuration. |

For a permitted, bounded metadata-only run:

```bash
rogalddl scan \
  --query-budget 2 --result-limit 3 \
  --no-second-pass --enrichment-limit 0 \
  --fingerprint-mode metadata-only --json
```

Inspect `summary.json`, `review.json` and `rejected.json` before increasing the
scope. `metadata-only` disables audio downloads for fingerprinting, **not network
access**. The default fingerprint mode is `candidates`, which can download audio.
An update requires the same explicit mode if you want to stay metadata-only:

```bash
rogalddl update --fingerprint-mode metadata-only --json
rogalddl play --shuffle --no-loop
```

Exit `0` means the command completed; `1` reports an error or unhealthy `doctor`;
`2` means usable output was published with discovery, enrichment or fingerprint
failures. Handled SIGINT/SIGTERM return `130`/`143`. A `complete` summary describes
the executed scan, not complete coverage of an artist's work. Query budgets can
end discovery before all planned sources run.

### Controls worth knowing

| Area | Supported flags |
| --- | --- |
| Discovery | `--query-budget N`, `--result-limit N`, `--concurrency N`, `--no-second-pass` |
| Second pass | `--second-pass-limit N`, `--second-pass-results N` |
| Enrichment | `--enrichment-limit N` (`0` disables long-form metadata lookups) |
| Process limits | `--timeout-ms N`, `--retries N`, `--fingerprint-timeout-ms N`, `--fingerprint-max-bytes N` |
| Cache | `--no-cache`, `--refresh-fingerprints` |
| Storage | `--data-dir PATH`, `--config-dir PATH`, `--cache-dir PATH` |
| Tool paths | `--yt-dlp PATH`, `--mpv PATH`, `--fpcalc PATH`, `--ffmpeg PATH` |
| Playback | `--shuffle`, `--no-loop`, `--video`, `--variant remix,live`, `--pick`, `--ipc-socket PATH` |

The full parser is [lib/cli.mjs](lib/cli.mjs); defaults are documented in
[config.example.json](config.example.json). Unknown options, invalid limits,
malformed configuration and conflicting overrides fail explicitly.

Fingerprint modes are `metadata-only`, `candidates` (default), `fingerprint-all`
and `segments`. Fingerprint downloads pass a size limit to yt-dlp (64 MiB by
default) and check the resulting file before processing. Audio is removed in a
`finally` block after success or a handled error. Abrupt termination such as
SIGKILL or a power failure can leave temporary files; cleanup is not secure erasure.
A fingerprint supports an audio-comparison decision, not an ownership claim.

## Data flow and audit trail

Discovery queries the configured artist and Topic channels plus bounded search
variants. A second pass derives additional queries from accepted titles and
collaborators. Results are normalized, classified and conservatively deduplicated
before publication. Long-form recordings stay separate; usable chapters can map
to existing tracks or become time-bounded MPV EDL entries.

Default paths follow XDG conventions:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/rogalddl
${XDG_CONFIG_HOME:-$HOME/.config}/rogalddl
${XDG_CACHE_HOME:-$HOME/.cache}/rogalddl
```

| Output | Purpose |
| --- | --- |
| `catalog.json`, `playlist.m3u8` | Accepted records and playback references. |
| `duplicates.json` | Selected upload, duplicate copies, method and supporting evidence. |
| `review.json`, `rejected.json` | Uncertain cases and exclusions with reasons. |
| `long-form.json` | Albums/concerts, chapter mappings and unsegmented items. |
| `fingerprints.json` | Available fingerprint evidence and capability status. |
| `summary.json` | Run status, counts, query budget and stage failures. |
| `raw.json` | Sanitized discovery observations and provenance. |

JSON outputs carry `schemaVersion`. Publication stages a complete set, syncs it to
disk and swaps directories with recovery support; a lock rejects concurrent
writers. Incremental updates mark carried-forward observations `stale: true`.
Inspect that flag rather than assuming an old link remains available.

Human decisions belong in `overrides.json` under the config directory:
`keep` preserves a pair, `merge` selects a confirmed winner, and `reject` excludes
a false match. See [overrides.example.json](overrides.example.json) for the schema.
A reject decision is a catalog decision, not deletion from raw history or cache.

## Rights and privacy boundaries

These are implemented safeguards and known limits, not a legal certification.

| Mechanism | What it does and does not establish |
| --- | --- |
| Metadata selection and redaction | Keeps catalog fields while filtering credential-bearing fields, signed media URLs and common secrets. Public titles/channel identifiers remain data; redaction is not anonymization. |
| Explicit external-tool configuration | yt-dlp ignores ambient configuration; MPV disables user config and scripts. The CLI does not import browser cookies or offer an access-control bypass. This does not establish permission to automate access. |
| Local files and temporary audio | Config/cache directories use private permissions; config files use `0600`. Fingerprint audio has bounded processing and handled-path cleanup. This does not establish download or reproduction rights. |
| Provenance and review | Records where metadata came from and why records were merged. It does not verify copyright ownership, permission or licensing. |
| Cache and retention | Query cache has a reuse TTL (seven days by default); expired files are not automatically deleted. Catalogs, raw observations and fingerprints have no automatic retention purge or consent-management workflow. |

YouTube's [Terms of Service](https://www.youtube.com/t/terms) restrict automated
access and uses of content outside the permissions they specify. Public visibility
or metadata-only operation does not itself grant scraping or reuse permission.
Check the terms applicable to your location and obtain any required permissions
before using live commands. YouTube's [copyright guidance](https://support.google.com/youtube/answer/2797466?hl=en)
distinguishes permission, licenses and applicable exceptions; this tool does not
determine which applies. Offline synthetic demonstrations avoid dependence on live
content or any claim about media rights.

**Software license status:** this repository currently has no `LICENSE` file and
no license field in `package.json`. No software license is selected by this README.
Third-party runtimes and executables have their own licenses.

## Code map and review route

| Module | Responsibility |
| --- | --- |
| [lib/cli.mjs](lib/cli.mjs), [lib/config.mjs](lib/config.mjs) | Commands, validated settings, XDG paths and diagnostics. |
| [lib/discovery.mjs](lib/discovery.mjs), [lib/cache.mjs](lib/cache.mjs), [lib/ytdlp.mjs](lib/ytdlp.mjs) | Query planning, cache/checkpoint identity and external metadata adapter. |
| [lib/classify.mjs](lib/classify.mjs), [lib/dedupe.mjs](lib/dedupe.mjs), [lib/catalog.mjs](lib/catalog.mjs) | Classification, evidence-based decisions and serialized reports. |
| [lib/pipeline.mjs](lib/pipeline.mjs), [lib/io.mjs](lib/io.mjs) | Stage coordination, writer lock and recoverable publication. |
| [lib/fingerprint.mjs](lib/fingerprint.mjs), [lib/player.mjs](lib/player.mjs) | Optional audio comparison and MPV integration. |
| [lib/process.mjs](lib/process.mjs), [lib/security.mjs](lib/security.mjs) | Process limits, signal handling, environment filtering and redaction. |

Start with [test/catalog.test.mjs](test/catalog.test.mjs) for decision behavior,
[test/pipeline.test.mjs](test/pipeline.test.mjs) for recovery, and
[test/io-player.test.mjs](test/io-player.test.mjs) for execution boundaries.
[GitLab CI](.gitlab-ci.yml) runs `./test-all.sh` in Node 22 on merge requests and
the default branch; it contains no deployment job.

Classification and chapter mapping are heuristics. Source metadata may be
incomplete; private, removed or inaccessible recordings are outside discovery.
Live extraction and playback depend on upstream services and installed tool
versions. The offline suite verifies local behavior, not current live access or
legal compliance. See [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md) for project policies.
