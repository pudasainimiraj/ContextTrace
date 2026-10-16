# UI and UX plan

Status: proposal, 2026-10-16. This plan covers the SPA in `web/src` and the small API additions the SPA needs. It does not change retrieval, budgets or the source policy (ADR-0006, ADR-0008, ADR-0010).

## 1. Goal

A first-time visitor must understand five things without reading the README:

1. What ContextTrace does, and what it does not index.
2. Which repositories are already indexed, and how complete each index is.
3. What the service is doing right now, and when a repository will be complete.
4. How to search, how to read a result, and how much to trust it.
5. Why the service says no, and what to do next.

Five rules apply to every screen:

- **Status before data.** The first thing on any panel is a state in plain words. The numbers come second.
- **One vocabulary.** The same state has the same label, colour and icon on the home list, the repository header, the progress panel and the search results.
- **Every number has a sentence.** "3,980 of 4,210" is not enough. "94% searchable, indexing continues" is.
- **No dead ends.** Every error, empty state and pause names the next action and, when known, the time.
- **Honest progress.** A bar is determinate only when the total is known. Otherwise it is indeterminate and labelled with what is known (the page number, the item count).

## 2. Where the SPA stands today

The SPA is one screen: a title, a conditional warning banner, a registration form, and, after a successful registration, a status card, a coverage panel and a search panel (`web/src/App.tsx`). This is correct and safe, but it explains nothing and it forgets everything.

| # | Observation | Evidence | Effect on the user |
| --- | --- | --- | --- |
| 1 | The only entry point is the registration form. To search, a returning user must register the repository again. | `App.tsx:84-116`; ClickHouse resubmitted 11 times (`NEXT.md`). | Every return visit costs a GitHub lookup and a registration rate-limit slot. The user reads "Already registered (submission #12)" and wonders if something went wrong. |
| 2 | All state lives in React. Reload or Back loses the repository, the coverage and the results. There is no permalink. | `App.tsx:55-58` | Results cannot be shared. The Back button leaves the site. |
| 3 | There is no list of indexed repositories. | `LATER.md` item 12; no list route in `worker/src/index.ts`. | With a cap of 25 repositories, "already registered" is the common case, and the user cannot see it. |
| 4 | The cap and the storage state are visible only when they already block the user. | `StatusBanner` returns null when all is well (`App.tsx:165`). | The first contact with the free tier is a 503. |
| 5 | Backend vocabulary is on screen: "high-water mark", "stream", "backfilling history", "jobs in flight", "submission #3", a numeric ID, raw ISO timestamps. | `App.tsx:119-293` | Only the project owner can read the coverage panel. |
| 6 | The five-column streams table overflows below about 480 px. | `App.css:79-97`; the table has no responsive variant. | Horizontal scrolling on phones. |
| 7 | Results show the raw cosine score ("semantic match 0.87") and name the fallback ("keyword search") without explaining either. "Left out without a verified link" is unexplained. | `App.tsx:372-376, 393-396` | The reader cannot tell a strong answer from a weak one at a glance. |
| 8 | Results are a flat list of passages. | CT-44: thread Hit@5 is 0.95 while Recall@3 is 0.29 (`docs/EVALUATION.md`). | The right thread is usually there, but as several near-identical cards, or one card below the fold. |
| 9 | There is no empty state, no example query, no skeleton. The only loading text is "Loading coverage…". | `App.tsx:212` | A new user does not know what a good query looks like. |
| 10 | Focus does not move after registration or search. The whole coverage section is `aria-live`, so every 5-second poll re-announces every number. | `App.tsx:121, 361`; `COVERAGE_POLL_MS` | Screen-reader users hear a wall of numbers every five seconds. |
| 11 | The accent colour `#aa3bff` on white measures about 4.4:1. | `index.css:7` | Below the 4.5:1 AA minimum for body-size links. Confirm with axe in CT-45. |
| 12 | Error text is the API message. | `index.ts:167` ("…send its token as turnstileToken"), `index.ts:281` ("Repository is not registered") | Developer messages reach end users. |
| 13 | The CSP allows styles, fonts and images from the site only. | `web/public/_headers` | No CSS-in-JS, no third-party fonts, no GitHub avatars unless the CSP changes. The plan respects this. |

What already works and must stay: the strict CSP, the server-side query embedding, the verified permalinks, the dark-mode tokens, the honest warnings from the search response (`index.warning`, `message`), and the SPA fallback in `wrangler.jsonc` (`not_found_handling: single-page-application`), which means deep links need no Worker change.

## 3. Information architecture

Today the application has one state machine on one screen. The target has four pages and one shared status strip.

| Route | Purpose | Data |
| --- | --- | --- |
| `/` | Home: what the service is, add a repository, the repositories already indexed, capacity. | `GET /api/repositories` (new), `GET /api/status` |
| `/r/:owner/:name` | One repository: header with state, search (default section), indexing progress, about this index. | `GET /api/repositories/by-name/:owner/:name` (new), `/coverage`, `POST /api/search` |
| `/r/:owner/:name?q=…` | A search permalink. The query runs on load. | as above |
| `/status` | Service status: every budget, what is paused, until when, what protections are on. | `GET /api/status` (exists) |
| `/about` | How it works, what is indexed and what is not, the limits, the source policy. | static |

Routing: a history-based router. `react-router` 7 in data-less mode is enough, and it works under the CSP. A 40-line hand-rolled router is also acceptable at this size. Unknown routes render a "not found" page with a link home.

### Home, target layout

```
┌──────────────────────────────────────────────────────────────────┐
│ ContextTrace                                  ● All systems normal│
├──────────────────────────────────────────────────────────────────┤
│ Find out why the code is the way it is.                          │
│ ContextTrace indexes the issues and pull-request discussions of  │
│ a public GitHub repository. Search them by meaning and open the  │
│ exact comment on GitHub.                                         │
│                                                                  │
│ ┌──────────────────────────────────────────┐ ┌──────────┐        │
│ │ github.com/owner/repository              │ │ Add      │        │
│ └──────────────────────────────────────────┘ └──────────┘        │
│ We index issues, pull requests and their comments. Not the code. │
│                                                                  │
│ Already indexed (19 of 25)                   Filter: [        ]  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ sindresorhus/p-queue        ● Fully indexed                  │ │
│ │ 1,204 passages · synced 14 min ago            [ Search → ]   │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ ClickHouse/ClickHouse       ◐ Searchable, still indexing     │ │
│ │ 38,110 passages · fetching issue comments, page 212          │ │
│ │ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮░░░░░░ 71% embedded              [ Search → ]  │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ torvalds/linux              ○ Unreachable on GitHub          │ │
│ │ kept until 14 Nov · Register again to rebuild                │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ Capacity ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮░░░░░░ 19 of 25 repositories         │
└──────────────────────────────────────────────────────────────────┘
```

### Repository, target layout

```
┌──────────────────────────────────────────────────────────────────┐
│ ← All repositories                            ● All systems normal│
├──────────────────────────────────────────────────────────────────┤
│ sindresorhus/p-queue  ↗                 ◐ Searchable, still indexing
│ Newest discussions are searchable now. Older history is being    │
│ added; about 71% of passages have a vector. Updated 3 s ago.     │
│                                                                  │
│ [ Search ]  [ Indexing ]  [ About this index ]                   │
│                                                                  │
│ ┌──────────────────────────────────────────────┐ ┌────────┐      │
│ │ Why do tasks keep running after an error?    │ │ Search │      │
│ └──────────────────────────────────────────────┘ └────────┘      │
│ Try: "wait until the queue is empty" · "rate limit per second"   │
│                                                                  │
│ Strong matches · 5 results from 71% of fetched passages          │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ ⬡ Issue #29  Does the queue stop when a task throws?         │ │
│ │ Comment 2 of 5 · sindresorhus · 12 Apr 2018 · ● Strong match │ │
│ │ No, the queue continues. Errors from one task do not …       │ │
│ │                                   Open on GitHub ↗ · Copy link│ │
│ │ ▸ 2 more passages in this thread                             │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## 4. One status vocabulary

The repository status is the spine of the interface. Every surface uses this table and nothing else.

| Backend status | Label | Tone | Icon | One-line meaning (shown under the label) | Next action offered |
| --- | --- | --- | --- | --- | --- |
| `registered` | Queued for indexing | neutral, pulsing | ◌ | "Nothing is searchable yet. The newest discussions arrive within about a minute." | none; the page updates by itself |
| `searchable_partial` | Searchable, still indexing | amber | ◐ | "Newest discussions are searchable. Older history is being added." | Search |
| `registered`, no active job | Indexing stopped | red | ○ | "{last error in plain words}. Indexing did not start, or it stopped." A failed first fetch is never retried by the cron. | Register again |
| `searchable` | Fully indexed | green | ● | "Every fetched discussion is indexed. Synced every hour." When a stream is capped or passages are pending: "Every fetched discussion is indexed; history older than {date} is not included" or "{n} passages are waiting for a vector". | Search |
| `inaccessible` | Unreachable on GitHub | red | ○ | "GitHub stopped serving this repository on {date}. The index is kept and searchable until {date + 30 days}; results may be stale." | Search; Register again |
| `removed` | Index removed | muted | ○ | "The data was removed on {date}." | Register again to rebuild |

Stream phases never appear by name. They become one sentence per stream:

| Phase | Sentence |
| --- | --- |
| `pending` | "Waiting to start" |
| `head` | "Fetching the newest {items}" |
| `backfill` | "Fetching older history, page {pages_fetched}" |
| `rescan` | "Checking for deleted {items}" |
| `complete` | "Complete, {items_fetched} fetched" |
| `capped` | "Stopped at the 5,000-item limit. Older items are not indexed." (badge, not a phase) |
| `complete`, sync running | "Checking for new {items}" (a `fetch_*` job after the head pass is a sync) |

Job states become one line in the "Happening now" area and nowhere else:

| State | Sentence |
| --- | --- |
| `queued` | "{kind} is queued" |
| `running` | "{kind} is running" |
| `retry_pending` | "{kind} will retry at {time} ({error in plain words})" |
| `failed` | "{kind} failed: {error}." For transform and embed the cron retries within 5 minutes; a failed fetch is not retried (see "Indexing stopped"). |
| `cancelled`, `lease_expired` | "{kind} stopped" |
| `running`, `lease_until` in the past | "{kind} stalled; recovering within 5 minutes" |
| `retry_pending`, `error_code` = `budget_exhausted` | "Paused until {resets_at}: {resource in plain words} used up for today". With no reset time (storage): "Paused: storage is at its limit". The resource and the time come from `/api/status`. |

Job kinds in plain words: `fetch_*` is "Fetching the newest {stream}" before the head pass is done and "Checking for new {stream}" after it, `backfill_*` is "Fetching older {stream}", `transform_passages` is "Splitting threads into passages", `embed_passages` is "Making passages searchable", `rescan_*` is "Checking for deletions".

Search confidence becomes a chip at the top of the results:

| `confidence` / `mode` | Chip | Sentence |
| --- | --- | --- |
| high / semantic | ● Strong matches | none |
| low / semantic | ◐ Weak matches | the API `message`, verbatim |
| low / keyword | ◐ Keyword matches | the API `message`, verbatim (it already says "index still building", "no close semantic match" or "unavailable") |
| none | ○ No supporting discussion | the API `message`, verbatim, plus the suggestions of section 5.5 |
| `semantic_error` set | ⚠ (added to the chip above) | the API `message` names the reason; only `budget_exhausted` carries a reset time |

Match strength per card: Strong (score ≥ 0.80), Fair (0.70 to 0.80), Weak (below 0.70; only the forced Meaning-only mode returns these), Keyword. The raw score moves to the `title` attribute for people who want it.

## 5. Screen by screen

### 5.1 Home

- **Hero**: one sentence of promise, one sentence of mechanism (see the wireframe). The sentence under the form says what is indexed and what is not. This replaces the README as the first explanation.
- **"How it works"** in three short steps under the form, always visible on first load, collapsed to one line once the user has one repository in the list: Add a repository → We index its issues, pull requests and comments → Search by meaning and open the comment on GitHub.
- **Already indexed** list (section 5.3).
- **Capacity bar**: "19 of 25 repositories". When full, the bar is amber and the form stays enabled, because an existing repository can still be entered; the error for a new one says the service is full and points at the list.

### 5.2 Add a repository

- **Input** accepts everything `parseRepositoryInput` accepts: a URL, a URL with a path, `owner/name`, an SSH remote. Move the parser to `shared/` so the client can show the parsed result under the field as the user types: "Looks like `sindresorhus/p-queue`". A parse error shows under the field in the same words the API uses, before any request is sent.
- **Pre-submit check**: on blur or after 400 ms idle, call `GET /api/repositories/by-name/:owner/:name`. If found, replace the button with "Already indexed. Open →". This removes the resubmission path for the common case and spends nothing.
- **Submit** disables the button with "Checking on GitHub…". On 201, navigate to the repository page and show a one-time banner: "Added. Indexing started. The newest discussions are searchable within about a minute." On 200 (resubmission), navigate without a banner.
- **Turnstile**: a line above the widget, "A quick check keeps bots out. Nothing is stored." The button stays disabled until the token exists, with the reason in the button's `title`.
- **Error map**. The SPA maps the API `error` code to copy. The API message stays available in a "Details" disclosure.

| API code | Copy | Action |
| --- | --- | --- |
| `invalid_input` | the parser's own message | none |
| `repository_not_found` | "GitHub has no public repository at this address. Check the spelling. Private repositories cannot be indexed." | none |
| `repository_not_public` | "Only public repositories can be indexed." | link to About, source policy |
| `admissions_paused` (cap) | "The service is full: 25 of 25 repositories. You can search any repository in the list." | scroll to list |
| `admissions_paused` (storage) | "Storage is at {pct}%. New repositories wait until space is freed." | link to Status |
| `budget_exhausted` | "Today's allowance for new repositories is used up. It resets at 00:00 UTC." | none |
| `rate_limited` / `service_paused` | "GitHub is rate-limiting the service. Try again in {Retry-After}." | countdown on the button |
| `verification_failed` | "The bot check did not pass. Reload the page and try again." | reload |
| `verification_unavailable` | "The bot check service did not answer. Try again in 30 seconds." | countdown |
| 429 from the limiter | "Five registrations a minute per address. Wait a moment." | countdown |
| `upstream_error`, 5xx | "GitHub or the service had a problem. It has been logged. Try again in a minute." | retry |

### 5.3 Already indexed

- **Row anatomy**: `owner/name` (link to the repository page), the status pill, a second line with the passage count and the last sync as a relative time ("synced 14 min ago"; absolute UTC in `title`), and, when the repository is active, a third line with the "Happening now" sentence and the embedding bar.
- **Order**: repositories with active jobs first, then by last sync, newest first. Removed and unreachable repositories go last, muted. An unreachable repository keeps its Search action for the 30 days its data is kept; results carry the stale warning.
- **Filter** box filters the list as the user types. With 25 rows this is client-side.
- **Empty list**: "No repository is indexed yet. Add the first one above." plus two suggested small public repositories so the first experience takes under a minute (the evaluation repositories are a good choice).
- **Live**: the list polls `GET /api/repositories` every 15 s while any row is active, otherwise every 60 s. The list endpoint returns summaries only (no bodies), so this is cheap against egress.

### 5.4 Repository header and the indexing section

The header shows the name with a GitHub link, the status pill, the one-line meaning, and "Updated {n} s ago". The three sections are tabs on wide screens and stacked headings on narrow ones. Search is the default tab as soon as the status is at least `searchable_partial`; before that the Indexing tab opens by default.

The **Indexing** section replaces the coverage `dl` and the streams table:

```
Pipeline
  Fetch ───────── Split ───────── Make searchable ───────── Complete
  ◐ running       ● done          ◐ running                ○
  3 streams       4,210 passages  3,980 of 4,210 (94%)

Happening now                                     Updated 3 s ago · Live
  • Fetching older issue comments, page 12
  • Making 230 passages searchable
  • Fetching review comments will retry at 14:32 (GitHub rate limit)

Last runs
  Fetching older issue comments: 3 pages, 287 items, 12 s ago
  Making passages searchable: 100 passages, 40 s ago

Streams
  Issues and pull requests   ● Complete · 612 fetched · synced 14 min ago
  Issue comments             ◐ Fetching older history, page 12 · 2,944 so far
  Review comments            ◌ Waiting to start

Freshness
  Last synced 14 min ago · next sync in about 46 min
  Deleted comments checked 3 days ago · next check within a week

What is stored
  312 issues · 300 pull requests · 2,944 comments · 654 review comments
  Stored and searchable: 3,980 of 4,210 passages
```

Rules for this panel:

- **Last runs** come from the newest succeeded job per kind (`jobs.result` holds pages, records, inserted and the duration; retention keeps that row). They are the cheapest honest signal that indexing is moving.
- **Determinate bars** only for embedding (`embedded / (embedded + pending)` is known). Fetching uses an indeterminate bar with the page number; GitHub does not give a total.
- **Capped streams** show the badge from section 4 and a sentence in Freshness: "History older than {capped_at} is not indexed."
- **Paused** (from `/api/status`) replaces "Happening now" with the pause sentence and the reset time.
- **Failed** jobs show the error in plain words and "The hourly sync retries it." There is no public retry button (job triggers require the admin token, ADR-0009).
- **Polling**: 5 s while a job is `queued` or `running` or the status is `registered`, 30 s while a job is `retry_pending` or the status is `searchable_partial` with no active job, stop at `searchable`, `inaccessible`, `removed`, and stop while `document.hidden`. Show "Live" while polling. "Updated {n} s ago" ticks every second from the last response.
- **Done moment**: when the status flips to `searchable`, show a one-time inline notice "Fully indexed. Every discussion is now searchable." and move focus to the Search tab's heading.
- **Operator details** disclosure at the bottom holds the raw fields (high-water marks, cursors, job counts, ids) for the project owner. Nothing else on the panel uses those words.

### 5.5 Search

- **Position**: the first thing in the default tab, with focus on load. The query also lives in the URL (`?q=`), so reload, Back and sharing work.
- **Before the index exists** (`registered`): the input is enabled but the button reads "Search opens in about a minute" and is disabled. It enables itself when the status flips.
- **Example queries**: three chips under the input, phrased as a developer asks them ("Why does X fail with Y?", "Is it safe to…?", "How do I…?"). First release: a static set per repository type. Later: the repository's most frequent queries (`LATER.md`, search analytics).
- **Results header**: the confidence chip, the API `message` when present, then "{n} results from {pct}% of fetched passages" with `pct = embedded / (embedded + pending)`. When partial: "the total grows while older history is fetched; search again in a few minutes". Never "of the discussions": unfetched history has no denominator. When capped: "history older than {date} is not included". When `unverified > 0`: "{n} results were left out because their GitHub link could not be verified" with a tooltip that explains verification (host, thread, anchor).
- **Skeleton**: three grey cards while searching. Show "{embed_ms} ms" in the header for transparency, small.
- **Grouped by thread**: client-side for the first release. Group the returned cards by `document_id`, show the best card expanded and "{n} more passages in this thread" collapsed. Request `limit` 10 so a thread can gather its siblings. Server-side grouping and sibling boosting stay in `LATER.md`.
- **Empty result** (`confidence: none`): "Nothing in {repo} supports this query." followed by three suggestions: use the words the maintainers would use; name the function or option; the topic may live in code or in docs rather than in discussions. When partial: add "Only {pct}% is indexed; search again later."
- **Advanced** disclosure: mode (Auto, Meaning only, Keywords only; one sentence each), limit (5, 10, 20). Defaults stay Auto and 5. Nothing else moves here.
- **Recent searches** for this repository from `localStorage`, five at most, with a clear button. Per-viewer only.
- **Errors**: 429 budget → "Today's search allowance for this service is used up. It resets at 00:00 UTC." 429 limiter → "Thirty searches a minute per address. Wait a moment." `not_found` → "This repository is not indexed. Add it from the home page." Network → "No connection. Try again."

### 5.6 Evidence card

```
⬡ Issue #29 · Does the queue stop when a task throws?            ● Strong
Comment 2 of 5 · sindresorhus · 12 Apr 2018
No, the queue continues. Errors from one task do not stop the others; …
Open on GitHub ↗ · Copy link
```

- **Type icon** and number first, title as the link. Issue and pull request have different icons and words, never colour alone.
- **Locator line** in reading order: where, who, when. Dates as "12 Apr 2018" with the ISO in `title`.
- **Match strength** as a chip at the right (Strong, Fair, Keyword). Score in `title`.
- **Excerpt**: plain text, as today. Highlight the query's words client-side by wrapping text nodes in `<mark>`. No HTML from the server is ever rendered (ADR-0010).
- **Open on GitHub** is an explicit action with the external icon, in addition to the title link. "Copy link" copies `source_url`.
- **Author** as text. No avatars: the CSP allows images from the site only, and avatars add nothing to trust.

### 5.7 Service status strip and page

- **Strip** in the header on every page: a dot and four words. Green "All systems normal". Amber "Paused until 00:00 UTC" (first exhausted budget, in plain words). Amber "Indexing deferred: queue budget low" (the schedulers queue nothing below 20% of the day's queue budget, and backfills wait at the storage warning, while nothing is "paused"). Amber "Not accepting new repositories" (cap or storage). The strip polls `/api/status` every 60 s, as today, and links to `/status`.
- **Page** `/status`: one bar per budget with a plain name, the used and limit values, and the reset time.

| Resource | Plain name |
| --- | --- |
| Workers AI neurons / day | Embeddings today |
| GitHub requests / hour | GitHub requests this hour |
| queue operations / day | Indexing steps today |
| searches / day | Searches today |
| registrations / day | New repositories today |
| egress / month | Data transfer this month |
| storage (gauge) | Storage |

Under the bars: what a pause means ("Indexing waits and resumes by itself; search falls back to keywords"), the protections in force (bot check, rate limits), and the service limits (25 repositories, 5,000 items per stream, hourly sync, weekly deletion check, 30-day retention of unreachable repositories).

### 5.8 About

One static page in plain language: what is indexed (public repositories; issues, pull requests, their comments and review comments; text only), what is never stored (code, private data, HTML), how search decides (meaning first, keywords as fallback, the 0.80 and 0.70 thresholds in one sentence), how fresh the index is, and the limits. Link to `docs/EVALUATION.md` for the measured quality.

## 6. Accessibility, mobile and performance

- **Landmarks and headings**: one `h1` per page, `nav`, `main`, sections with `aria-labelledby`. Tabs follow the WAI-ARIA tabs pattern with arrow keys.
- **Live regions**: one `aria-live="polite"` region per page that announces only state changes (status flips, a job that starts or fails, results ready). Counts never go through the live region.
- **Focus**: after Add, focus moves to the repository heading. After a search, to the results heading. After a route change, to the page heading.
- **Colour**: raise the light accent to at least 4.5:1 on white (for example `#8f2be0`), keep the dark accent. Status pills carry an icon and a word, never colour alone.
- **Motion**: pulsing and indeterminate bars respect `prefers-reduced-motion`.
- **Mobile**: tables become stacked cards below 640 px. The search bar is sticky at the top of the repository page. 16 px gutters, no horizontal scroll at 360 px. Input font size stays at or above 16 px to avoid zoom on iOS.
- **Keyboard**: `/` focuses the search input on the repository page. Escape clears it.
- **Performance**: no new UI framework. Plain CSS files, CSS custom properties, and a router. No CSS-in-JS and no third-party fonts (CSP). Bundle target under 100 KB gzipped.
- **Gates**: zero axe violations, Lighthouse accessibility 100, the Playwright checks of CT-45 against every route.

## 7. API additions the SPA needs

All read routes, all behind the read limiter, no secret in any response (pinned by `tests/integration/security.test.ts`).

| Route | Returns | Note |
| --- | --- | --- |
| `GET /api/repositories` | `{ repositories: RepositorySummary[], capacity: { used, max } }` | Summary per repository: `id`, `full_name`, `status`, `passages`, `embedded`, `last_successful_sync_at`, `active: boolean`, `now: string \| null` (the first "Happening now" sentence, built on the server from the same table as section 4). Sorted active first. Every non-removed row, the same set the admission count uses. |
| `GET /api/repositories/by-name/:owner/:name` | `RepositoryRecord` or 404 | Case-insensitive on `full_name`. For the pre-submit check and for routing by name. |
| `GET /api/repositories/:id/coverage` | add `active_jobs: { kind, state, error_code, next_attempt_at, started_at, attempt, lease_until }[]`, `last_runs: { kind, finished_at, pages, records, inserted, duration_ms }[]` and `paused_until: string \| null` | Today the report has counts only. "Happening now" needs the kinds and the retry time; "Last runs" needs the newest succeeded job per kind. Never `error_message`: database errors embed call names. |
| `GET /api/status` | add `deferred: string[]` | The schedulers defer below 20% of the queue budget and at the storage warning without any budget being "paused". |
| `POST /api/search` | unchanged | The SPA sends `limit: 10` and groups by thread. |

Two fixes from `NEXT.md` are user-facing and belong with v1.1: a resubmission must start extraction when no fetch job exists (otherwise "Register again" does nothing), and a repository with issues disabled must skip that stream instead of becoming "Unreachable on GitHub".

## 8. Roadmap

### Phase 0, before the CT-46 user tests

Ship these first, otherwise the three testers will only report what this table already knows.

1. Status vocabulary (section 4) on the status card, the coverage panel and the results header.
2. The error map (section 5.2) and the search errors (section 5.5).
3. Hide the raw score behind a strength chip; explain the keyword fallback and the unverified count.
4. Stacked cards instead of the streams table below 640 px.
5. Focus management and a single, state-change-only live region.
6. The accent contrast fix.
7. Example queries and the empty-result copy.
8. "Updated {n} s ago · Live" on the coverage panel.

Verify: axe and Playwright from CT-45 pass; the three CT-46 tasks can be completed without the README.

### v1.1, repositories and progress (first post-release)

1. Routes and permalinks (`/`, `/r/:owner/:name`, `?q=`, `/status`, `/about`).
2. `GET /api/repositories` and the "Already indexed" list with the capacity bar.
3. Pre-submit check with `by-name`, and the shared parser preview under the input.
4. The Indexing section: pipeline stepper, "Happening now", streams in sentences, freshness, operator details disclosure. Needs `active_jobs` in the coverage report.
5. The status strip and the `/status` page.
6. The two `NEXT.md` fixes (resubmission with no jobs; issues disabled).

Verify: a returning user reaches search in one click; a shared `?q=` link reproduces the result; a phone at 360 px shows no horizontal scroll on any route.

### v1.2, better results

1. Thread grouping in the SPA with `limit` 10; sibling boosting on the server when `LATER.md` item 3 lands.
2. Query-term highlighting in excerpts; "Copy link"; recent searches.
3. Advanced disclosure: mode and limit.
4. Filters that the data already supports: type (issues, pull requests, comments, review comments), author, date range. These need `source_type`, `author` and `created_at` filters on `search_passages`.
5. Per-repository popular queries as example chips (`LATER.md` item 13).

Verify: Recall@3 on the frozen set is unchanged (the SPA never changes ranking); the testers' time to the first opened permalink falls.

### v1.3, operate and extend

1. **Operator console** at `/admin`, unlocked by pasting the admin token (kept in `sessionStorage`, sent as a bearer header, never in the URL): trigger a job, remove a repository, see failed jobs and errors. Today these are curl-only.
2. **Live progress** by Server-Sent Events from the Worker instead of polling (`LATER.md` item 17). The polling path stays as the fallback.
3. **Review comments by file**: `sources.path` and `sources.line` exist for review comments. Carry `path` into passages, add a "comments on {file}" filter and a `?path=` permalink. This is the closest the data gets to "why was this line added".
4. **Export results** as Markdown with permalinks, for pasting into an issue or a pull request.
5. **Index again** button on unreachable and removed repositories (today it is the registration form).

### Later and ideas

- **Search across every indexed repository** with the repository as a facet. Retrieval is repository-scoped by design (CT-27); this needs a product decision and a new SQL function.
- **Answer mode**: a short synthesis over the top passages with inline citations to the cards. Costs model budget; keep evidence-first as the default.
- **Sign in with GitHub** to lift the shared token's limit and to allow private repositories for their owners (`LATER.md` item 15). Only then: "notify me when indexing completes" and saved searches.
- **GitHub Discussions** as a fourth stream (`LATER.md` item 1), shown as a fourth row in Streams.
- **"Open in ContextTrace"** bookmarklet or browser extension from a github.com repository page.
- **Embeddable search box** and a public API page with copyable `curl` examples.
- **Custom domain** and a bound Turnstile widget (`LATER.md` item 11).
- **A determinate fetch bar**: GitHub's page-numbered listings carry a `rel="last"` link that the head pass could store once as `pages_total`.
- Two v1.3 items need their own ADR before they are scheduled: the operator console puts the admin token in the browser, which ADR-0009 keeps out of it; Server-Sent Events hold a Worker invocation per viewer, against ADR-0002's one-job-per-invocation economy.

## 9. How success is measured

| Measure | Today | Target | Where |
| --- | --- | --- | --- |
| Time from landing to the first result for a new repository | unknown | under 90 s, including the head pass | CT-46 sessions |
| Time from landing to the first result for an indexed repository | one registration round trip | one click, under 5 s | CT-46 sessions |
| Resubmissions as a share of registrations | high (ClickHouse: 11) | near zero after v1.1 | `submission_count` |
| Tasks completed without the README | unknown | 3 of 3 testers, 3 of 3 tasks | CT-46 protocol |
| axe violations per route | unknown | 0 | CT-45 |
| Horizontal scroll at 360 px | yes (streams table) | none | CT-45 |
| Results opened on GitHub per search | unknown | measured, rising | server-side search analytics (later) |

## 10. Copy and style rules

- Plain words. Never "stream", "high-water mark", "cursor", "job", "backfill", "embed", "vector" outside the operator disclosure. Say "fetching", "older history", "making searchable", "passage".
- One noun per thing: repository, discussion, thread (an issue or a pull request), passage, result.
- Relative times in text ("14 min ago"), absolute UTC in `title`. Thousands separators on every count.
- Sentences, not labels with colons. Each state has one sentence that says what it means and one that says what happens next.
- Every message that says no also says when or what next.
- Tone: calm, factual, no exclamation marks. The service is honest about its limits because they are design decisions (ADR-0008), not failures.
