# Retrieval Sync V1

## Goal

Add a local-only hybrid sync that keeps DPA News as the static publishing system while pushing selected case-like records into the DPA retrieval corpus for downstream research and search.

## Scope

- Source scope: `cms-enforcement-tracker` only
- Run location: local laptop only
- Target system: `dpa-retrieval`
- Sync granularity: one DPA News article becomes one retrieval document
- Sync mode: append-only with manifest-based idempotency

## Out Of Scope

- GitHub Actions or any hosted sync into the retrieval database
- Replacing Astro JSON as the source of truth for the site
- Full GDPRhub synchronization or dedupe against the existing GDPRhub corpus
- Update, delete, or re-chunk workflows for already-synced documents
- Syncing regulator news and guidance feeds

## Why CMS First

- CMS Enforcement Tracker items are already normalized as `decisions` in DPA News.
- Each item represents a discrete enforcement event with a stable article ID and official source link where available.
- GDPRhub is deferred because the local retrieval corpus already contains GDPRhub-sourced material and the DPA News feed only carries lightweight recent-change summaries.

## Architecture

1. DPA News continues to fetch and publish JSON article files.
2. `scripts/sync-retrieval.js` reads local article JSON files and filters to the allowed sync scope.
3. The sync runner keeps a local manifest outside the repo by default.
4. For apply runs, the sync runner sends one case payload at a time to `scripts/sync-retrieval-adapter.py`.
5. The Python adapter imports the local DPA retrieval server code and creates retrieval documents/chunks against the configured retrieval data directory.

## Data Model

### Retrieval document

- `document_type`: `regulatory_decision`
- `source_format`: `json`
- `owning_server`: `dp-news`
- `file_path`: absolute path to the DPA News article JSON file

### Retrieval metadata

- `source_system`: `dp_news`
- `source_feed`: `cms-enforcement-tracker`
- `dp_news_article_id`: article ID
- `sync_checksum`: v1 checksum for idempotency/drift detection
- `authority_tier`: `2`
- `jurisdiction`
- `organisation`
- `enforcement_tracker_id`
- `original_link`
- `published_date`
- `decision_date`
- `tags`

### Chunk model

- One chunk per synced document in v1
- `chunk_type`: `paragraph`
- `owl_class_iri`: `ob:RegulatoryDecision`
- `tier_level`: `2`

## Tier Decision

CMS records are synced as tier 2, not tier 1.

Reason:

- The tracker is a structured secondary source, even when it links to official authority materials.
- Tier 1 should remain reserved for direct regulatory or curated canonical corpus material already living in the retrieval stack.

## Idempotency And Drift

The sync runner computes a checksum from the normalized DPA News record.

- If the manifest already contains the same article ID and checksum, the article is skipped.
- If the retrieval DB already contains the same `dp_news_article_id` and the same checksum, the manifest is backfilled and the article is skipped.
- If the article ID already exists but the checksum changed, the runner reports `update_required` and does not mutate the retrieval corpus in v1.

## Manifest

Default path:

- `~/.dp-news/retrieval-sync-manifest.json`

Manifest entry fields:

- `articleId`
- `sourceId`
- `retrievalDocumentId`
- `syncChecksum`
- `syncedAt`
- `title`
- `originalLink`

## Operational Constraints

- The sync is intentionally local-only because the retrieval runtime database lives on the laptop.
- The sync runner writes through the retrieval server module for document and chunk creation.
- A small direct database update is allowed inside the adapter to finalize `documents.status`, `documents.indexed_at`, and `chunks.tier_level`, because the current retrieval MCP surface does not expose public tools for those fields.

## CLI

### Dry run

```bash
npm run sync:retrieval
```

### Apply

```bash
npm run sync:retrieval:apply
```

### Useful overrides

- `--limit <n>`
- `--articles-dir <path>`
- `--state-file <path>`
- `--retrieval-server-dir <path>`
- `--retrieval-data-dir <path>`

## Success Criteria

- The runner identifies CMS enforcement articles and produces a dry-run summary.
- Apply mode creates one retrieval document and one chunk per article.
- New chunks are marked tier 2.
- New documents are marked `indexed`.
- Re-running the same sync skips already-synced records without creating duplicates.

## Deferred Phase 2

- GDPRhub reconciliation against the existing local GDPRhub corpus
- Update handling for changed checksums
- Delete/archive behavior
- Local automation or scheduled desktop execution
