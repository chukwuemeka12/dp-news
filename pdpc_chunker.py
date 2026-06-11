#!/usr/bin/env python3
"""
DPA Open Brain — PDPC Decision Semantic Chunker
Pipeline Stage: Transform (Stage 2 of 5)

Segments each PDPC decision PDF into up to 9 semantic chunk types:

  1. Header          — Citation, case ref, respondent, date, commissioner
  2. Facts           — Incident narrative, how breach occurred, data involved
  3. FactPattern     — Single failure pattern extracted from facts
  4. RemedialActions  — Steps respondent took post-incident
  5. LegalAnalysis   — PDPC's application of law to specific obligation
  6. SanctionRationale — Penalty quantum reasoning, aggravating/mitigating
  7. Holding         — The operative determination (breach found or not)
  8. PrecedentCitation — Each cited prior decision with principle cited for
  9. Direction       — Each specific remediation direction with deadline

Ontology alignment:
  - OWL class: dpa-case:SupervisoryDecision
  - Chunk types: dpa-case:ChunkType-Header, etc.
  - Authority tier: 1 (authoritative regulatory decision)
  - Canonical ID: regdecision:pdpc:{case_reference}

Requirements:
  pip install PyMuPDF openpyxl

Usage:
  python pdpc_chunker.py                          # chunk all 266 decisions
  python pdpc_chunker.py --limit 10               # chunk first 10 (test)
  python pdpc_chunker.py --output chunks.json      # custom output path
"""

import json, os, re, sys, argparse
from collections import defaultdict
from datetime import datetime
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("ERROR: PyMuPDF required. Install with: pip install PyMuPDF")
    sys.exit(1)

# ── Configuration ────────────────────────────────────────────────────────

# Paths — adjust if running from a different location
SCRIPT_DIR = Path(__file__).parent
PDF_DIR = SCRIPT_DIR / "public" / "decision-documents" / "official-decisions" / "pdpc-commissions-decisions"
ARTICLE_DIR = SCRIPT_DIR / "src" / "content" / "articles"
EXTRACTED_PATH = None  # will try to find pdpc_extracted_v2.json

# Chunk type constants (aligned with ontology)
CHUNK_TYPES = {
    "Header":            "dpa-case:ChunkType-Header",
    "Facts":             "dpa-case:ChunkType-Facts",
    "FactPattern":       "dpa-case:ChunkType-FactPattern",
    "RemedialActions":   "dpa-case:ChunkType-RemedialActions",
    "LegalAnalysis":     "dpa-case:ChunkType-LegalAnalysis",
    "SanctionRationale": "dpa-case:ChunkType-SanctionRationale",
    "Holding":           "dpa-case:ChunkType-Holding",
    "PrecedentCitation": "dpa-case:ChunkType-PrecedentCitation",
    "Direction":         "dpa-case:ChunkType-Direction",
}

# Token count targets per chunk type (from research protocol)
TOKEN_TARGETS = {
    "Header": (50, 100),
    "Facts": (400, 800),
    "FactPattern": (150, 300),
    "RemedialActions": (200, 400),
    "LegalAnalysis": (300, 600),
    "SanctionRationale": (200, 400),
    "Holding": (100, 200),
    "PrecedentCitation": (50, 150),
    "Direction": (100, 200),
}

# ── Section Detection Patterns ───────────────────────────────────────────

# These patterns identify section boundaries in PDPC decision PDFs
SECTION_PATTERNS = {
    "header": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:parties?|introduction|background)\s*$',
        r'(?i)^(?:\s*\d+\.?\s+)?the\s+(?:parties?|respondent|complainant)',
        r'(?i)^\s*GROUNDS?\s+OF\s+DECISION',
    ],
    "facts": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:material\s+)?facts?\s*$',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:incident|background\s+facts?|factual\s+background)',
        r'(?i)^(?:\s*\d+\.?\s+)?what\s+happened',
        r'(?i)^(?:\s*\d+\.?\s+)?brief\s+facts',
    ],
    "remedial": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:remedial|corrective|mitigating)\s+(?:actions?|measures?|steps?)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:actions?\s+taken|steps?\s+taken|measures?\s+taken)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?respondent.{0,30}(?:taken|implemented|adopted)',
    ],
    "legal_analysis": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:commission.{0,20})?(?:findings?|analysis|assessment)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:whether|application\s+of)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:protection|consent|notification|openness|accuracy)\s+obligation',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:breach|contravention)\s+of',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:section\s+\d+\s+of\s+the\s+PDPA)',
    ],
    "sanction": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:commission.{0,20})?(?:decision|determination)\s+on\s+(?:sanction|penalty|financial\s+penalty)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:quantum|amount)\s+of\s+(?:the\s+)?(?:financial\s+)?penalty',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:aggravating|mitigating)\s+(?:factors?|circumstances?)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:penalty|sanction)\s+(?:considerations?|assessment)',
    ],
    "holding": [
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:commission.{0,20})?(?:decision|determination|conclusion|order)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:in\s+)?(?:summary|conclusion)',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:accordingly|for\s+the\s+(?:above|foregoing)\s+reasons)',
    ],
    "direction": [
        r'(?i)^(?:\s*\d+\.?\s+)?directions?\s*$',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:the\s+)?(?:commission|deputy\s+commissioner)\s+(?:hereby\s+)?directs?',
        r'(?i)^(?:\s*\d+\.?\s+)?(?:pursuant|under)\s+section\s+\d+',
    ],
}


# ── PDF Text Extraction ──────────────────────────────────────────────────

def extract_pdf_text(pdf_path):
    """Extract full text from PDF with page boundaries."""
    doc = fitz.open(str(pdf_path))
    pages = []
    for page_num, page in enumerate(doc):
        text = page.get_text("text")
        pages.append({"page": page_num + 1, "text": text})
    doc.close()
    return pages


def pages_to_paragraphs(pages):
    """Split page text into numbered paragraphs."""
    paragraphs = []
    for page_info in pages:
        text = page_info["text"]
        page_num = page_info["page"]
        # Split on double newlines or numbered paragraphs
        blocks = re.split(r'\n\s*\n|\n(?=\d+\.?\s+[A-Z])', text)
        for block in blocks:
            block = block.strip()
            if len(block) > 20:  # skip very short fragments
                paragraphs.append({
                    "text": block,
                    "page": page_num,
                    "tokens": len(block.split()),
                })
    return paragraphs


# ── Section Classification ───────────────────────────────────────────────

def classify_paragraph(text, prev_type, position_ratio):
    """
    Classify a paragraph into a chunk type based on content patterns.
    Uses both keyword matching and document position heuristics.
    """
    text_lower = text.lower().strip()
    first_line = text_lower.split('\n')[0]

    # Check explicit section headers first
    for section, patterns in SECTION_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, first_line) or re.search(pattern, text[:200]):
                type_map = {
                    "header": "Header",
                    "facts": "Facts",
                    "remedial": "RemedialActions",
                    "legal_analysis": "LegalAnalysis",
                    "sanction": "SanctionRationale",
                    "holding": "Holding",
                    "direction": "Direction",
                }
                return type_map.get(section, prev_type)

    # Content-based classification
    # Precedent citations
    if re.search(r'(?:Re|In)\s+\w+.*?\[\d{4}\]', text) and ("cited" in text_lower or "referred" in text_lower or "in the case of" in text_lower or "decision in" in text_lower):
        return "PrecedentCitation"

    # Remedial actions keywords
    if any(phrase in text_lower for phrase in [
        "implemented", "engaged", "deployed", "hired",
        "conducted a review", "enhanced its", "updated its",
        "put in place", "taken steps", "measures taken",
        "after the incident", "post-incident", "since the breach",
        "remedial measure", "corrective action",
    ]):
        if position_ratio > 0.3:  # remedial usually in middle/late sections
            return "RemedialActions"

    # Sanction reasoning
    if any(phrase in text_lower for phrase in [
        "aggravating", "mitigating", "quantum of",
        "amount of the penalty", "severity of",
        "taking into account", "in determining the",
        "financial penalty of", "shall pay",
        "penalty should be", "appropriate penalty",
    ]):
        if position_ratio > 0.6:
            return "SanctionRationale"

    # Direction keywords
    if any(phrase in text_lower for phrase in [
        "hereby directs", "is directed to", "shall comply",
        "within 30 days", "within 60 days", "within 90 days",
        "must implement", "must take steps",
        "direction to", "pursuant to section",
    ]):
        if position_ratio > 0.7:
            return "Direction"

    # Holding / conclusion
    if any(phrase in text_lower for phrase in [
        "accordingly", "for the reasons above", "in conclusion",
        "the commission finds", "the commission determines",
        "has breached", "did not breach", "in breach of",
        "is not in breach", "failed to comply",
    ]):
        if position_ratio > 0.7:
            return "Holding"

    # Legal analysis (PDPA section references + reasoning)
    section_refs = re.findall(r'section\s+\d+', text_lower)
    obligation_mentions = re.findall(r'(?:protection|consent|notification|openness|accuracy|retention|transfer|access)\s+obligation', text_lower)
    if (len(section_refs) >= 2 or len(obligation_mentions) >= 1) and position_ratio > 0.3:
        return "LegalAnalysis"

    # FactPattern — specific failure patterns within facts
    if prev_type == "Facts" and any(phrase in text_lower for phrase in [
        "vulnerability", "misconfiguration", "unpatched",
        "weak password", "credential", "sql injection",
        "phishing", "ransomware", "malware",
        "failed to encrypt", "plaintext", "unencrypted",
        "inadequate access control", "no multi-factor",
        "outdated software", "end-of-life",
    ]):
        return "FactPattern"

    # Position-based fallback
    if position_ratio < 0.15:
        return "Header"
    elif position_ratio < 0.45:
        return "Facts" if prev_type in ("Header", "Facts", None) else prev_type
    elif position_ratio < 0.8:
        return "LegalAnalysis" if prev_type not in ("SanctionRationale", "Direction") else prev_type
    else:
        return prev_type or "LegalAnalysis"


# ── Chunk Assembly ───────────────────────────────────────────────────────

def assemble_chunks(paragraphs):
    """
    Group paragraphs into semantic chunks, respecting type boundaries
    and token count targets.
    """
    if not paragraphs:
        return []

    chunks = []
    current_type = None
    current_texts = []
    current_tokens = 0
    current_pages = set()
    total_paras = len(paragraphs)

    for i, para in enumerate(paragraphs):
        position_ratio = i / max(total_paras, 1)
        para_type = classify_paragraph(para["text"], current_type, position_ratio)

        # Get target token range for this type
        min_tokens, max_tokens = TOKEN_TARGETS.get(para_type, (100, 400))

        # Decision: start new chunk or extend current?
        if para_type != current_type and current_texts:
            # Flush current chunk
            chunks.append({
                "chunk_type": current_type,
                "content": "\n\n".join(current_texts),
                "tokens": current_tokens,
                "pages": sorted(current_pages),
            })
            current_texts = []
            current_tokens = 0
            current_pages = set()

        # If current chunk is getting too long, split it
        if current_tokens + para["tokens"] > max_tokens * 1.5 and current_tokens > min_tokens:
            if current_texts:
                chunks.append({
                    "chunk_type": current_type or para_type,
                    "content": "\n\n".join(current_texts),
                    "tokens": current_tokens,
                    "pages": sorted(current_pages),
                })
                current_texts = []
                current_tokens = 0
                current_pages = set()

        current_type = para_type
        current_texts.append(para["text"])
        current_tokens += para["tokens"]
        current_pages.add(para["page"])

    # Flush final chunk
    if current_texts:
        chunks.append({
            "chunk_type": current_type,
            "content": "\n\n".join(current_texts),
            "tokens": current_tokens,
            "pages": sorted(current_pages),
        })

    return chunks


# ── Quality Score ────────────────────────────────────────────────────────

def compute_quality_score(chunk):
    """
    Score 0.0-1.0 indicating how well a chunk preserves a single semantic unit.
    Factors: token count within target range, content coherence, type confidence.
    """
    chunk_type = chunk["chunk_type"]
    tokens = chunk["tokens"]
    min_t, max_t = TOKEN_TARGETS.get(chunk_type, (100, 400))

    # Token range score (1.0 if within range, decreasing outside)
    if min_t <= tokens <= max_t:
        token_score = 1.0
    elif tokens < min_t:
        token_score = max(0.3, tokens / min_t)
    else:
        token_score = max(0.3, max_t / tokens)

    # Content type confidence based on keyword density
    text_lower = chunk["content"].lower()
    type_keywords = {
        "Header": ["respondent", "case reference", "date", "commissioner", "parties"],
        "Facts": ["incident", "breach", "personal data", "discovered", "occurred"],
        "FactPattern": ["vulnerability", "misconfiguration", "attack", "exploit", "failure"],
        "RemedialActions": ["implemented", "enhanced", "engaged", "deployed", "review"],
        "LegalAnalysis": ["section", "obligation", "pdpa", "reasonable", "requirement"],
        "SanctionRationale": ["penalty", "aggravating", "mitigating", "quantum", "severity"],
        "Holding": ["finds", "determines", "breach", "conclusion", "accordingly"],
        "PrecedentCitation": ["cited", "decision in", "re ", "principle"],
        "Direction": ["directs", "shall", "within", "days", "comply"],
    }
    keywords = type_keywords.get(chunk_type, [])
    matches = sum(1 for kw in keywords if kw in text_lower)
    keyword_score = min(1.0, matches / max(len(keywords) * 0.4, 1))

    return round(0.6 * token_score + 0.4 * keyword_score, 3)


# ── Main Chunking Pipeline ──────────────────────────────────────────────

def chunk_decision(decision_id, pdf_path, article_data=None, extracted_data=None):
    """
    Full chunking pipeline for a single PDPC decision.
    Returns a document record with all chunks.
    """
    # Extract text
    pages = extract_pdf_text(pdf_path)
    if not pages:
        return None

    full_text = "\n".join(p["text"] for p in pages)

    # Build paragraphs
    paragraphs = pages_to_paragraphs(pages)
    if not paragraphs:
        return None

    # Classify and assemble chunks
    raw_chunks = assemble_chunks(paragraphs)

    # Build metadata from article JSON and extraction
    title = ""
    case_ref = ""
    respondent = ""
    decision_date = ""
    outcome = ""
    penalty = 0

    if article_data:
        title = article_data.get("title", "")
        decision_date = article_data.get("decisionDate", "")

    if extracted_data:
        case_ref = extracted_data.get("case_reference", "")
        respondent = extracted_data.get("respondent", "")
        outcome = extracted_data.get("outcome", "")
        penalty = extracted_data.get("financial_penalty_sgd", 0) or 0

    canonical_id = f"regdecision:pdpc:{case_ref}" if case_ref else f"regdecision:pdpc:{decision_id}"

    # Build final chunk records
    chunks = []
    for idx, raw in enumerate(raw_chunks):
        quality = compute_quality_score(raw)
        chunk = {
            "chunk_index": idx,
            "chunk_type": raw["chunk_type"],
            "chunk_type_iri": CHUNK_TYPES.get(raw["chunk_type"], "dpa-case:ChunkType-Mixed"),
            "content": raw["content"],
            "tokens": raw["tokens"],
            "pages": raw["pages"],
            "quality_score": quality,
            "owl_class_iri": "dpa-case:SupervisoryDecision",
            "metadata": {
                "source": "pdpc",
                "tier": 1,
                "canonical_id": canonical_id,
                "jurisdiction": "Singapore",
                "authority": "PDPC",
                "decision_date": decision_date,
                "case_reference": case_ref,
                "respondent": respondent,
                "outcome": outcome,
                "financial_penalty_sgd": penalty,
            }
        }
        chunks.append(chunk)

    return {
        "decision_id": decision_id,
        "canonical_id": canonical_id,
        "title": title,
        "case_reference": case_ref,
        "respondent": respondent,
        "decision_date": decision_date,
        "outcome": outcome,
        "financial_penalty_sgd": penalty,
        "pdf_path": str(pdf_path),
        "total_pages": len(pages),
        "total_tokens": sum(c["tokens"] for c in chunks),
        "chunk_count": len(chunks),
        "chunks": chunks,
        "chunk_type_distribution": dict(
            sorted(
                defaultdict(int, {c["chunk_type"]: 0 for c in chunks}).items()
            )
        ),
    }


def build_chunk_type_dist(chunks):
    """Helper to compute type distribution."""
    dist = defaultdict(int)
    for c in chunks:
        dist[c["chunk_type"]] += 1
    return dict(sorted(dist.items()))


def main():
    parser = argparse.ArgumentParser(description="PDPC Decision Semantic Chunker")
    parser.add_argument("--limit", type=int, default=0, help="Limit to N decisions (0=all)")
    parser.add_argument("--output", type=str, default="pdpc_chunks.json", help="Output JSON path")
    parser.add_argument("--pdf-dir", type=str, default=None, help="Override PDF directory")
    parser.add_argument("--article-dir", type=str, default=None, help="Override article directory")
    args = parser.parse_args()

    pdf_dir = Path(args.pdf_dir) if args.pdf_dir else PDF_DIR
    article_dir = Path(args.article_dir) if args.article_dir else ARTICLE_DIR

    print(f"PDPC Decision Semantic Chunker")
    print(f"=" * 60)
    print(f"PDF directory:     {pdf_dir}")
    print(f"Article directory: {article_dir}")

    # Find all PDFs
    pdf_files = sorted(pdf_dir.glob("pdpc-commissions-decisions-*.pdf"))
    print(f"Found {len(pdf_files)} decision PDFs")

    if args.limit > 0:
        pdf_files = pdf_files[:args.limit]
        print(f"  (limiting to {args.limit})")

    # Load extracted data if available
    extracted_map = {}
    for ext_path in [
        SCRIPT_DIR.parent / "pdpc_extracted_v2.json",
        SCRIPT_DIR / "pdpc_extracted_v2.json",
        Path("pdpc_extracted_v2.json"),
    ]:
        if ext_path.exists():
            with open(ext_path) as f:
                for d in json.load(f):
                    extracted_map[d["id"]] = d
            print(f"Loaded {len(extracted_map)} extracted records from {ext_path}")
            break

    # Process each decision
    results = []
    total_chunks = 0
    type_totals = defaultdict(int)
    errors = []

    for i, pdf_path in enumerate(pdf_files):
        decision_id = pdf_path.stem  # e.g., pdpc-commissions-decisions-abc123

        # Load article JSON
        article_path = article_dir / f"{decision_id}.json"
        article_data = None
        if article_path.exists():
            with open(article_path) as f:
                article_data = json.load(f)

        # Get extracted data
        extracted = extracted_map.get(decision_id)

        try:
            result = chunk_decision(decision_id, pdf_path, article_data, extracted)
            if result:
                # Fix: compute actual distribution
                result["chunk_type_distribution"] = build_chunk_type_dist(result["chunks"])
                results.append(result)
                total_chunks += result["chunk_count"]
                for c in result["chunks"]:
                    type_totals[c["chunk_type"]] += 1
            else:
                errors.append({"id": decision_id, "error": "Empty PDF or no text"})
        except Exception as e:
            errors.append({"id": decision_id, "error": str(e)})

        if (i + 1) % 25 == 0 or (i + 1) == len(pdf_files):
            print(f"  Processed {i+1}/{len(pdf_files)} decisions ({total_chunks} chunks so far)")

    # Summary
    print(f"\n{'=' * 60}")
    print(f"CHUNKING COMPLETE")
    print(f"  Decisions processed: {len(results)}")
    print(f"  Total chunks: {total_chunks}")
    print(f"  Average chunks/decision: {total_chunks / max(len(results), 1):.1f}")
    print(f"  Errors: {len(errors)}")

    print(f"\n  Chunk Type Distribution:")
    for ct, count in sorted(type_totals.items(), key=lambda x: -x[1]):
        pct = count / max(total_chunks, 1) * 100
        print(f"    {ct:<20} {count:>6} ({pct:.1f}%)")

    # Average quality
    all_quality = [c["quality_score"] for r in results for c in r["chunks"]]
    if all_quality:
        print(f"\n  Quality Scores:")
        print(f"    Mean:   {sum(all_quality)/len(all_quality):.3f}")
        print(f"    Min:    {min(all_quality):.3f}")
        print(f"    Max:    {max(all_quality):.3f}")

    # Save output
    output_path = Path(args.output)
    output_data = {
        "pipeline": "DPA Open Brain — PDPC Semantic Chunker",
        "version": "1.0.0",
        "timestamp": datetime.now().isoformat(),
        "config": {
            "chunk_types": list(CHUNK_TYPES.keys()),
            "token_targets": TOKEN_TARGETS,
            "authority_tier": 1,
            "source": "PDPC Singapore",
        },
        "summary": {
            "decisions_processed": len(results),
            "total_chunks": total_chunks,
            "avg_chunks_per_decision": round(total_chunks / max(len(results), 1), 1),
            "chunk_type_distribution": dict(sorted(type_totals.items())),
            "avg_quality_score": round(sum(all_quality)/max(len(all_quality),1), 3),
            "errors": len(errors),
        },
        "decisions": results,
        "errors": errors,
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2, default=str)
    print(f"\nSaved to {output_path}")

    if errors:
        print(f"\nErrors:")
        for e in errors[:10]:
            print(f"  {e['id']}: {e['error']}")

    return output_data


if __name__ == "__main__":
    main()
