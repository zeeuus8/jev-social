# Reel imports: version 1

The import-only contract from #124 accepts already processed JSON, without
browser operations, provider calls or media downloads. Future producers (#125)
should target this contract instead of persisting their raw provider responses.

The local `/reels` library uses this contract to import files, reopen collections,
filter classifications, and read transcripts and timestamped segments. Failed
imports preserve the currently loaded collection. A failed or uncertain save
offers a reload so the user can check persisted data before trying again. Opening
the library or choosing a collection never starts automated processing.

## Input

Send a JSON object to `POST /api/reels` with `Content-Type: application/json` and
an `Origin` matching the loopback server. Maximum input and normalized size:
10,000,000 UTF-8 bytes, with 1–1,000 items. `GET /api/reels` lists collections;
`GET /api/reels/<library-id>` reopens one. Invalid imports leave prior data intact.

The required envelope is `{ schemaVersion: 1, id, creator, posts }`. `id` is a
stable source collection ID; each post requires its own stable `id` and an
Instagram `url`. IDs are case-sensitive, 1–128 ASCII letters, digits, dots,
underscores, colons or hyphens, starting with a letter or digit. Creator handles
are normalized to lowercase. Collection `createdAt` and source `status` are
optional. Unsupported or missing schema versions fail closed.

A Creator Lab adapter can add `schemaVersion: 1` to its export after checking
these fields and mapping producer-specific states. Do not use filenames as IDs
or fill missing plays from views. Unversioned exports require this explicit
adapter step; the importer does not guess future producer formats.

Each post accepts:

- `creator`, `caption`, ISO `publishedAt`, `capturedAt` (or `scrapedAt`),
  `duration`, `plays`, `views`, `likes`, and `comments`.
- `transcript: { text, segments: [{ text, start, end }] }`. Times are seconds;
  missing times stay `null`. Negative, nonnumeric or reversed times are rejected.
- `analysis: { labels, anatomy }`. Labels use the eight dimensions and enums
  in `src/reels-contract.js`; every label has a confidence in `[0, 1]`. Anatomy
  segments add `value` (script role) and nullable `confidence` to a timed segment.
  Classification requires a nonempty transcript. Each segment array is limited
  to 200 entries; transcript and segment text to 48,000 characters, captions to
  12,000. Oversized or malformed text is rejected.
- `status`: absent, `pending`, `ready`, `unclassified`, `classified`,
  `no_audio`, `no_speech`, `excluded`, `failed`, or `error`.
  `excludedReason` also marks exclusion. Error and excluded rows cannot carry a
  classification. Raw errors and exclusion text are replaced with fixed notes.

All fixtures in `test/fixtures/reels-import-v1.json` are synthetic; their URLs
are validation examples, not fetched or asserted to be real posts.

## Normalized contract

`schemas/reels-v1.schema.json` describes the normalized, versioned collection.
The importer constructs an allowlist of fields: unknown properties, provider
payloads, media URLs, thumbnails, cookies and local paths are not retained.
Known credential patterns in selected text are redacted. Lines containing
recognized filesystem paths are omitted conservatively, including trailing text.
Pattern matching cannot identify every secret in arbitrary prose: producers
must export public content, never credentials embedded in captions/transcripts.

Only HTTPS `instagram.com` and `www.instagram.com` post/reel URLs are accepted;
credentials, custom ports, profile links and lookalike hosts are rejected. URLs
become `https://www.instagram.com/p/<shortcode>/` without query or fragment.
The source is validated locally; no URL or media is fetched during import.

Unknown, nonnumeric, negative or nonfinite metrics become `null`; zero remains
zero. Plays and views are independent. Invalid or absent dates become `null`.
States normalize to `classified`, `unclassified`, `excluded`, or `error`.
`needsReview` is derived from labels/anatomy: confidence below 0.65, an `unclear`
value, or missing anatomy confidence requires review. It is not evidence of
human approval and cannot be overridden by a raw `needsReview: false` field.

Library IDs hash the lowercase creator plus source collection ID. Item IDs
are preserved, independent of URL aliases and filenames. Identical duplicate
item IDs collapse; conflicting duplicates reject the whole import. Posts are
sorted by ID. Reimporting replaces that collection atomically, not appends to
it; items omitted from a replacement snapshot disappear. The last successful
atomic write wins. No import timestamp is injected, so identical inputs produce
identical normalized content. `sourceId` retains the original collection ID.

Storage is `reels/v1/<library-id>.json` below the isolated Jev Social state
directory (`~/.jev-social` by default, or `JEV_SOCIAL_HOME`). Storage inside this
checkout and symlinked state/library directories is rejected. Files are written
privately via a temporary file and atomic rename. Reads revalidate the schema
and identity, enforce the size limit, and skip malformed/unsafe entries.
Nothing is stored in or served from `public/`.

`filterReels` filters normalized posts by topic, hook (`mechanism`), structure,
confidence and review/status. Confidence thresholds apply to the selected
dimension and every active label filter. The function preserves null metrics
and does not infer engagement effects, causality, or popularity rankings.

## Creator Lab integration

`JEV_SOCIAL_CREATOR_LAB_URL` must be an explicit numeric loopback HTTP origin,
such as `http://127.0.0.1:5190`. Hostnames, credentials, paths, query strings,
fragments, HTTPS and redirects are rejected. Restart Jev Social after changing
the endpoint; it is fixed for each server instance. Provider credentials remain
inside Creator Lab. Jev Social only uses the session token obtained from that
same local service for its mutation requests and never exposes it in the UI.

The adapter requires the `script-anatomy-v1` bootstrap and job version. It
preserves collection and item IDs, maps queued/transcribing/transcribed/classifying
items to unclassified v1 rows, maps complete items to classified rows, and retains
excluded/error rows. Excluded or failed rows discard any stale classification.
Only the normalized library allowlist is persisted; media URLs, raw provider
responses and diagnostics do not become library content. Unsupported versions,
unsafe sources and unknown item states fail visibly before replacing a snapshot.

The form accepts any valid Instagram handle, a limit of 1–100 Reels, an Apify
collection cap of $0.05–$30, and auto/en/pt/es transcription. Concurrency is fixed
at two. The adapter checks that the created job matches the requested limits
before starting it. Existing jobs outside those bounds can be read and saved but
cannot be resumed here. Partial and paused snapshots reuse the same library ID.

`GET /api/reels/pipeline` and `GET /api/reels/jobs/<id>` only inspect saved state.
Same-origin JSON is required for `POST /api/reels/jobs` (explicit start) and the
`pause`, `resume`, and `sync` actions under `/api/reels/jobs/<id>/`. Actions reject
extra settings. `sync` only imports existing results; it does not run providers.
Starting or resuming is an explicit user action; those actions can incur provider
charges and Creator Lab may temporarily download source media for audio extraction.
The Apify cap excludes transcription and classification costs. Pause does not
abort a remotely running collector or requests already in flight.

Requests have a 15-second timeout and 10 MB response bound. No mutation is
retried automatically. A lost job-creation response may leave an unstarted saved
job; recover it from history. A lost run response returns an uncertain state for
that existing job, with resume disabled until the state is recovered. An uncertain
Apify launch must be resolved in Creator Lab. The service also enforces its own
active-job guard; the Jev adapter serializes mutations within its server instance.

## Verification

Run `npm run check` and `npm test`. Focused tests cover normalization, malformed
input, unsafe URLs, privacy, duplicate IDs, filtering, atomic replacement and
reopening a collection after stopping and recreating the HTTP server. Tests use
temporary state directories and no social accounts or model calls.
