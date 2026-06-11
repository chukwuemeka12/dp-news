import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync one DPA News case into dpa-retrieval.")
    parser.add_argument("--server-dir", required=True, help="Path to the DPA retrieval server directory.")
    args = parser.parse_args()

    payload = json.loads(sys.stdin.read())
    server_dir = Path(args.server_dir).expanduser().resolve()

    sys.path.insert(0, str(server_dir))
    import dpa_retrieval_server as retrieval  # noqa: PLC0415

    article = payload["article"]
    checksum = payload["checksum"]
    chunk_payload = payload["chunk"]
    metadata = payload["metadata"]

    existing = find_existing_document(retrieval.get_db(), article["id"])
    if existing:
        existing_metadata = parse_metadata(existing["metadata"])
        existing_checksum = existing_metadata.get("sync_checksum")
        result = {
            "success": True,
            "mode": "existing",
            "documentId": existing["document_id"],
            "checksumMatches": existing_checksum == checksum,
            "existingChecksum": existing_checksum,
        }
        print(json.dumps(result))
        return 0

    register_response = json.loads(
        retrieval.retrieval_document_register(
            title=article["title"],
            file_path=article["filePath"],
            document_type="regulatory_decision",
            source_format="json",
            owning_server="dp-news",
            metadata=metadata,
            actor_id="dp-news-sync",
        )
    )

    if not register_response.get("success"):
        print(
            json.dumps(
                {
                    "success": False,
                    "stage": "register_document",
                    "error": register_response.get("error"),
                }
            )
        )
        return 1

    document_id = register_response["data"]["document_id"]

    chunk_response = json.loads(
        retrieval.retrieval_chunk_batch_create(
            document_id=document_id,
            chunks=[chunk_payload],
            actor_id="dp-news-sync",
        )
    )

    if not chunk_response.get("success"):
        print(
            json.dumps(
                {
                    "success": False,
                    "stage": "create_chunks",
                    "documentId": document_id,
                    "error": chunk_response.get("error"),
                }
            )
        )
        return 1

    chunk_ids = [chunk["chunk_id"] for chunk in chunk_response["data"]["chunks"]]
    finalize_document(retrieval.get_db(), document_id, chunk_ids)

    print(
        json.dumps(
            {
                "success": True,
                "mode": "created",
                "documentId": document_id,
                "chunkIds": chunk_ids,
            }
        )
    )
    return 0


def find_existing_document(conn, article_id: str):
    row = conn.execute(
        """
        SELECT document_id, metadata
        FROM documents
        WHERE json_extract(metadata, '$.dp_news_article_id') = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (article_id,),
    ).fetchone()
    return row


def finalize_document(conn, document_id: str, chunk_ids):
    now = datetime.now(timezone.utc).isoformat()

    for chunk_id in chunk_ids:
        conn.execute(
            """
            UPDATE chunks
            SET tier_level = 2
            WHERE chunk_id = ?
            """,
            (chunk_id,),
        )

    conn.execute(
        """
        UPDATE documents
        SET status = ?, indexed_at = ?, updated_at = ?
        WHERE document_id = ?
        """,
        ("indexed", now, now, document_id),
    )
    conn.commit()


def parse_metadata(value):
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    return json.loads(value)


if __name__ == "__main__":
    raise SystemExit(main())
