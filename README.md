# DPA News

DPA News is a static Astro site that aggregates public data protection developments into a lightweight, community-facing intelligence hub.

## MVP scope

- Curated source configuration with six initial sources
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
- `npm run build` generates the static site into `dist/`
- `npm run dev` starts local development

## Source and status model

- Every source lives in `src/data/source-config.js`
- Every successful fetch updates `src/content/system/status.json`
- Health is determined by whether a source has a recent successful run within its configured freshness window
- Content is stored as JSON in `src/content/articles/` and committed to git for static deployment

## Operational notes

- The GitHub Actions workflow runs every 6 hours and prevents overlapping runs with workflow-level concurrency
- Empty content refreshes do not create commits
- Summaries are automated and should always be checked against the original source before being relied on
- First production deployment is triggered from the connected `main` branch on Vercel
