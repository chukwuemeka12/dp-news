# DPA News

DPA News is a static Astro site that aggregates public data protection developments into a lightweight, community-facing intelligence hub.

## Scope

- Curated source configuration with an expanding mix of RSS, API, and official decision pages
- Official decision-source waves now include Irish DPC decisions, EDPS investigations, Singapore PDPC decisions, and Kenya ODPC determinations
- RSS ingestion for regulator and community feeds
- GDPRhub MediaWiki API ingestion for recent decisions
- CMS Enforcement Tracker ingestion from its structured JSON payload
- Rolling retention window of 90 days with a hard cap of 2,000 articles
- Status snapshot output for source freshness and operational visibility
- Four initial routes: `Latest`, `Decisions`, `Guidance`, and `About`

## Project structure

```text
/
├── scripts/
│   ├── fetch-rss.js
│   ├── fetch-gdprhub.js
│   ├── fetch-enforcement.js
│   ├── fetch-official-decisions.js
│   ├── download-official-documents.js
│   ├── lib/document-storage.js
│   └── lib/content-pipeline.js
├── src/
│   ├── components/
│   ├── content/
│   │   ├── articles/
│   │   └── system/status.json
│   ├── data/source-config.js
│   ├── layouts/
│   ├── lib/content.ts
│   ├── pages/
│   └── styles/global.css
└── .github/workflows/fetch-and-build.yml
```

## Commands

- `npm install` installs dependencies
- `npm run fetch:all` refreshes all configured sources
- `npm run fetch:official-decisions` refreshes official decision pages handled by custom extractors
- `npm run download:official-documents` downloads official decision PDFs into `public/decision-documents` by default
- `npm run monitor:feeds` fails when a source is unhealthy or outside its freshness window
- `npm run sync:retrieval` previews the local retrieval sync for supported case sources
- `npm run sync:retrieval:apply` writes supported case sources into the local retrieval corpus
- `npm run build` generates the static site into `dist/`
- `npm run dev` starts local development

## Source and status model

- Every source lives in `src/data/source-config.js`
- Every successful fetch updates `src/content/system/status.json`
- Health is determined by whether a source has a recent successful run within its configured freshness window
- Content is stored as JSON in `src/content/articles/` and committed to git for static deployment
- Official decision document archiving now defaults to `public/decision-documents` with a manifest at `~/.dp-news/document-manifest.json`
- The default downloader location is web-served and committed by the scheduled GitHub Actions refresh
- You can still override the destination with `DP_NEWS_DOCUMENTS_DIR` if you need a different local archive path

## Operational notes

- The GitHub Actions workflow runs every 6 hours and prevents overlapping runs with workflow-level concurrency
- Empty content refreshes do not create commits
- Summaries are automated and should always be checked against the original source before being relied on
- First production deployment is triggered from the connected `main` branch on Vercel
- `Fetch and Build` now runs a post-fetch health check so individual source failures can alert even when the Astro build still succeeds
- A companion monitoring workflow opens or updates a GitHub issue when `Fetch and Build` fails that health check and closes it again when the pipeline recovers
- The homepage shows a monitoring banner whenever one or more sources are stale according to `status.json`
- Retrieval sync v1 is local-only and currently scoped to CMS Enforcement Tracker decisions
