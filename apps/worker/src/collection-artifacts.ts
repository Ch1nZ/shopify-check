const ARTIFACT_KINDS = [
  "product-record",
  "technical-check",
  "evidence-pack",
  "html",
  "shopify-ajax",
  "robots",
] as const;

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export async function serveCollectionArtifact(
  collectionId: string,
  kind: string,
  download: boolean,
  env: Env,
): Promise<Response | null> {
  if (!isUuid(collectionId) || !isArtifactKind(kind)) return null;
  const objectKey = await resolveObjectKey(collectionId, kind, env);
  if (!objectKey) return null;
  const object = await env.EVIDENCE.get(objectKey);
  if (!object) return null;

  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ETag: object.httpEtag,
  });
  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  if (download) {
    headers.set("Content-Disposition", `attachment; filename="${collectionId}-${kind}.${extension(kind)}"`);
  }
  return new Response(object.body, { headers });
}

async function resolveObjectKey(
  collectionId: string,
  kind: ArtifactKind,
  env: Env,
): Promise<string | null> {
  if (kind === "product-record" || kind === "technical-check" || kind === "evidence-pack") {
    const column = kind === "product-record"
      ? "product_record_key"
      : kind === "technical-check"
        ? "technical_check_key"
        : "evidence_pack_key";
    const row = await env.DB.prepare(
      `SELECT ${column} AS object_key FROM collection_runs WHERE id = ?`,
    )
      .bind(collectionId)
      .first<{ object_key: string | null }>();
    return row?.object_key ?? null;
  }
  const sourceKind = kind === "shopify-ajax" ? "shopify_ajax" : kind;
  const row = await env.DB.prepare(
    "SELECT object_key FROM source_snapshots WHERE collection_id = ? AND source_kind = ? ORDER BY captured_at LIMIT 1",
  )
    .bind(collectionId, sourceKind)
    .first<{ object_key: string }>();
  return row?.object_key ?? null;
}

function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function extension(kind: ArtifactKind): string {
  if (kind === "html") return "html";
  if (kind === "robots") return "txt";
  return "json";
}
