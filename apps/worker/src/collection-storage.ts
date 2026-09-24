import type { ShopifyCollection } from "@mclab/shopify-online-store";
import { buildEvidencePack } from "@mclab/openrouter-adapter";

export async function storeCollection(
  collectionId: string,
  collection: ShopifyCollection,
  env: Env,
): Promise<{
  record_key: string;
  technical_check_key: string;
  evidence_pack_key: string;
  snapshot_keys: string[];
}> {
  const prefix = `collections/${collectionId}`;
  const snapshotRows: D1PreparedStatement[] = [];
  const snapshotKeys: string[] = [];

  for (const [index, snapshot] of collection.snapshots.entries()) {
    const extension = snapshot.kind === "html" ? "html" : snapshot.kind === "robots" ? "txt" : "json";
    const key = `${prefix}/sources/${index}-${snapshot.kind}.${extension}`;
    const sha256 = await sha256Hex(snapshot.body);
    await env.EVIDENCE.put(key, snapshot.body, {
      httpMetadata: { contentType: snapshot.content_type },
      customMetadata: {
        collection_id: collectionId,
        source_kind: snapshot.kind,
        sha256,
        captured_at: snapshot.captured_at,
      },
    });
    snapshotKeys.push(key);
    snapshotRows.push(
      env.DB.prepare(
        `INSERT INTO source_snapshots (
          id, collection_id, source_kind, requested_url, final_url, http_status,
          content_type, object_key, sha256, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        collectionId,
        snapshot.kind,
        snapshot.requested_url,
        snapshot.final_url,
        snapshot.status,
        snapshot.content_type,
        key,
        sha256,
        snapshot.captured_at,
      ),
    );
  }

  const recordJson = JSON.stringify(collection.record);
  const recordKey = `${prefix}/product-record.json`;
  await env.EVIDENCE.put(recordKey, recordJson, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      collection_id: collectionId,
      schema_version: collection.record.schema_version,
      sha256: await sha256Hex(recordJson),
      captured_at: collection.record.captured_at,
    },
  });

  const technicalCheckJson = JSON.stringify(collection.technicalCheck);
  const technicalCheckKey = `${prefix}/technical-check.json`;
  await env.EVIDENCE.put(technicalCheckKey, technicalCheckJson, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      collection_id: collectionId,
      schema_version: collection.technicalCheck.schema_version,
      sha256: await sha256Hex(technicalCheckJson),
      captured_at: collection.technicalCheck.captured_at,
    },
  });

  const evidencePack = await buildEvidencePack(collectionId, collection.record);
  const evidencePackJson = JSON.stringify(evidencePack);
  const evidencePackKey = `${prefix}/evidence-pack.json`;
  await env.EVIDENCE.put(evidencePackKey, evidencePackJson, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      collection_id: collectionId,
      schema_version: evidencePack.schema_version,
      sha256: await sha256Hex(evidencePackJson),
      captured_at: evidencePack.captured_at,
    },
  });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO collection_runs (
        id, requested_url, final_url, status, product_record_key, technical_check_key,
        evidence_pack_key, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      collectionId,
      collection.record.requested_url,
      collection.record.final_url,
      collection.record.collection_status,
      recordKey,
      technicalCheckKey,
      evidencePackKey,
      collection.record.captured_at,
      collection.record.captured_at,
    ),
    env.DB.prepare(
      `INSERT INTO technical_checks (
        id, collection_id, schema_version, object_key, status, robots_http_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      collectionId,
      collection.technicalCheck.schema_version,
      technicalCheckKey,
      collection.technicalCheck.status,
      collection.technicalCheck.robots_http_status,
      collection.technicalCheck.captured_at,
    ),
    ...snapshotRows,
    env.DB.prepare(
      `INSERT INTO product_records (
        id, collection_id, schema_version, object_key, title_state, price_state,
        currency_state, availability_state, variant_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      collectionId,
      collection.record.schema_version,
      recordKey,
      collection.record.fields.title.state,
      collection.record.fields.price.state,
      collection.record.fields.currency.state,
      collection.record.fields.availability.state,
      collection.record.variants.length,
      collection.record.captured_at,
    ),
    ...collection.record.technical_findings.map((finding) =>
      env.DB.prepare(
        `INSERT INTO technical_findings (
          id, collection_id, code, severity, message, evidence_paths_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        collectionId,
        finding.code,
        finding.severity,
        finding.message,
        JSON.stringify(finding.evidence_paths),
        collection.record.captured_at,
      ),
    ),
    ...collection.technicalCheck.findings.map((finding) =>
      env.DB.prepare(
        `INSERT INTO technical_findings (
          id, collection_id, code, severity, message, evidence_paths_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        collectionId,
        finding.code,
        finding.severity,
        finding.message,
        JSON.stringify(finding.evidence_paths),
        collection.technicalCheck.captured_at,
      ),
    ),
  ];
  await env.DB.batch(statements);
  return {
    record_key: recordKey,
    technical_check_key: technicalCheckKey,
    evidence_pack_key: evidencePackKey,
    snapshot_keys: snapshotKeys,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
