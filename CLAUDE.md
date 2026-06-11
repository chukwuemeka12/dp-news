Here it is:

---

**# DPA Open Brain — Project Instructions**

These instructions apply to every session that touches this workspace. Read them before doing anything.

**## Settled Architecture**

The following architectural decisions are **settled**. Do not propose alternatives, reorder stages, or introduce new pipeline steps without explicit CEO instruction to revise the canonical document.

**### Decision-Source Ingestion Pipeline**

The pipeline is a 10-step ETVLV workflow defined in one canonical document:

`/ontology/docs/decision-source-pipeline-template.md` (v2.0)

This is the **single source of truth**. There are no other valid pipeline definitions. If you encounter a different stage sequence in any other document, it is stale — do not follow it, do not extend it, do not create a parallel version.

Key constraints:

- **10 steps, not more, not fewer.** Extract (1–2) → Transform (3) → Validate (4–5) → Load (6–7) → Verify (8–10).
- **Three quality gates** block progression: Step 4 (Pre-Load Validate), Step 8 (Corpus Verification), Step 9 (Cross-Backbone Verification). All other steps have completion checks only.
- **Critical path ends at Step 6** (Retrieval Load). Steps 7–10 are verification and enrichment.
- **Three companion processes** (Triple Store Sync, Incremental Reasoning Job, Semantic Stack → Runtime Bridge) are **not pipeline steps**. They are Platform Engineer deliverables that operate alongside the pipeline on separate cadences. The pipeline succeeds without them.

**### GraphDB Role**

GraphDB is a **read-only consumer** of the ontology schema. It stores 32 Turtle files and provides SPARQL-queryable structured analysis. The application loads ontology files but **never writes back to the .ttl files**. See `TECH-SELECTION.md` for the full decision.

**### Two Distinct Data Flows**

1. **Decision-source ingestion:** Layer 0 → Layer 2. Enforcement decisions enter dpa-retrieval through the pipeline. Per-batch, Data Engineer owned.
2. **Semantic stack → runtime bridge:** Layer 1 → Layer 2. Organisational inferred triples enter dpa-retrieval as Tier 1. Periodic refresh, Platform Engineer owned.

These flows are architecturally distinct. Do not conflate them.

**## Before Doing Pipeline Work**

If your task involves decision-source ingestion, retrieval loading, chunking, tagging, validation, verification, or remediation:

1. Read the `decision-source-ops` skill (`.claude/skills/decision-source-ops/SKILL.md`)
2. Read the canonical pipeline template (`/ontology/docs/decision-source-pipeline-template.md`)
3. Read the ops pack (`/ontology/docs/decision-source-ops-pack.md`)

Do not improvise a pipeline. The pipeline exists. Follow it.

**## Governance Rules**

**### No Parallel Pipeline Definitions**

The three-definition drift problem (SKILL.md had 7 stages, pipeline-template had 8, ingestion-spec had 6) caused the embedding step to be missed entirely during PDPC ingestion. This must not recur.

- If the pipeline needs to change, the change is made in `decision-source-pipeline-template.md` and propagated to SKILL.md and ops-pack.md.
- Do not define pipeline stages in any other document.
- Do not create "simplified" or "alternative" pipeline descriptions. Reference the canonical template instead.

**### Proposing Changes to Settled Architecture**

If a user's question implies changing the pipeline structure (adding steps, removing steps, reordering steps, changing gate criteria), surface this constraint:

> "The pipeline is settled in `decision-source-pipeline-template.md` (v2.0). This was a deliberate consolidation to prevent the three-definition drift that caused the embedding step to be missed. If this change is warranted, it should be made as a formal revision to the canonical template — not as an ad-hoc modification in this session."

Then discuss whether the change warrants a formal revision.

**### Companion Processes Are Not Pipeline Steps**

If asked to add Triple Store Sync, Incremental Reasoning, or the Semantic Stack → Runtime Bridge into the pipeline sequence, decline. These are companion processes with different owners (Platform Engineer), different cadences (scheduled/periodic), and different failure characteristics (non-blocking). They are documented in the companion processes section of the pipeline template.

**## Engineering Primitives**

Only P7 (System Event Logging) and P8 (Two-Level Verification) apply to the batch ETL pipeline. The remaining 10 of the 12 agentic system primitives apply to Layer 3 (Intelligence Layer, Phase 5). Do not over-engineer the pipeline with interactive agentic patterns.

**## Key Reference Documents**

| Document | Purpose |
|---|---|
| `/ontology/docs/decision-source-pipeline-template.md` | Canonical pipeline (v2.0) — single source of truth |
| `.claude/skills/decision-source-ops/SKILL.md` | Operational skill for LLM sessions doing pipeline work |
| `/ontology/docs/decision-source-ops-pack.md` | Operational entry point with linked reference set |
| `/ontology/docs/source-system-vs-open-brain-ingestion.md` | System boundary between source acquisition and ingestion |
| `/ontology/docs/pdpc-tagging-and-retrieval-note.md` | Where tagging happens and how it persists into retrieval |
| `TECH-SELECTION.md` | CEO technology decisions (GraphDB Free, FastAPI, React+Vite, SQLite) |

---

That's the complete file. It lives at `.claude/CLAUDE.md` in your dpnewsite-workspace and will be loaded at the start of every session.