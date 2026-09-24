import {
  BaseCheckpointSaver, WRITES_IDX_MAP,
  type Checkpoint, type CheckpointTuple, type CheckpointMetadata,
  type CheckpointListOptions, type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

type Row = {
  thread_id: string; checkpoint_ns: string; checkpoint_id: string; parent_id: string | null;
  checkpoint_type: string; checkpoint: ArrayBuffer | number[];
  metadata_type: string; metadata: ArrayBuffer | number[];
};

/** D1 holds execution checkpoints; private R2 holds the original evidence. */
export class DiagnosticCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly db: D1Database) { super(); }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread, namespace, checkpoint } = location(config);
    const row = checkpoint
      ? await this.db.prepare("SELECT * FROM diagnostic_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?").bind(thread, namespace, checkpoint).first<Row>()
      : await this.db.prepare("SELECT * FROM diagnostic_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1").bind(thread, namespace).first<Row>();
    return row ? this.tuple(row) : undefined;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { thread, namespace } = location(config);
    const before = options?.before?.configurable?.checkpoint_id;
    const rows = await this.db.prepare(
      "SELECT * FROM diagnostic_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND (? IS NULL OR checkpoint_id < ?) ORDER BY checkpoint_id DESC",
    ).bind(thread, namespace, before ?? null, before ?? null).all<Row>();
    let count = 0;
    for (const row of rows.results) {
      if (options?.limit !== undefined && count >= options.limit) return;
      const value = await this.tuple(row);
      if (options?.filter && Object.entries(options.filter).some(([key, expected]) => JSON.stringify((value.metadata as Record<string, unknown> | undefined)?.[key]) !== JSON.stringify(expected))) continue;
      count += 1;
      yield value;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const { thread, namespace, checkpoint: parent } = location(config);
    const [body, meta] = await Promise.all([this.serde.dumpsTyped(checkpoint), this.serde.dumpsTyped(metadata)]);
    await this.db.prepare(
      `INSERT INTO diagnostic_checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_id, checkpoint_type, checkpoint, metadata_type, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET checkpoint_type = excluded.checkpoint_type,
         checkpoint = excluded.checkpoint, metadata_type = excluded.metadata_type, metadata = excluded.metadata`,
    ).bind(thread, namespace, checkpoint.id, parent ?? null, body[0], Array.from(body[1]), meta[0], Array.from(meta[1])).run();
    return { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread, namespace, checkpoint } = location(config);
    if (!checkpoint) throw new Error("Checkpoint writes require a checkpoint ID.");
    const statements: D1PreparedStatement[] = [];
    for (const [index, [channel, value]] of writes.entries()) {
      const [type, data] = await this.serde.dumpsTyped(value);
      const special = WRITES_IDX_MAP[channel];
      statements.push(this.db.prepare(
        `INSERT INTO diagnostic_checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx) ${special !== undefined ? "DO UPDATE SET channel = excluded.channel, value_type = excluded.value_type, value = excluded.value" : "DO NOTHING"}`,
      ).bind(thread, namespace, checkpoint, taskId, special ?? index, channel, type, Array.from(data)));
    }
    if (statements.length) await this.db.batch(statements);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM diagnostic_checkpoint_writes WHERE thread_id = ?").bind(threadId),
      this.db.prepare("DELETE FROM diagnostic_checkpoints WHERE thread_id = ?").bind(threadId),
    ]);
  }

  private async tuple(row: Row): Promise<CheckpointTuple> {
    const writes = await this.db.prepare(
      "SELECT task_id, channel, value_type, value FROM diagnostic_checkpoint_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx",
    ).bind(row.thread_id, row.checkpoint_ns, row.checkpoint_id).all<{ task_id: string; channel: string; value_type: string; value: ArrayBuffer | number[] }>();
    const checkpoint = await this.serde.loadsTyped(row.checkpoint_type, new Uint8Array(row.checkpoint)) as Checkpoint;
    const metadata = await this.serde.loadsTyped(row.metadata_type, new Uint8Array(row.metadata)) as CheckpointMetadata;
    const pendingWrites = await Promise.all(writes.results.map(async w => [w.task_id, w.channel, await this.serde.loadsTyped(w.value_type, new Uint8Array(w.value))] as [string, string, unknown]));
    return {
      config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } },
      checkpoint, metadata, pendingWrites,
      ...(row.parent_id ? { parentConfig: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_id } } } : {}),
    };
  }
}

function location(config: RunnableConfig) {
  const thread = config.configurable?.thread_id;
  const namespace = config.configurable?.checkpoint_ns ?? "";
  const checkpoint = config.configurable?.checkpoint_id;
  if (typeof thread !== "string" || !thread || typeof namespace !== "string") throw new Error("Diagnostic checkpoint requires a server-owned thread ID.");
  return { thread, namespace, checkpoint: typeof checkpoint === "string" ? checkpoint : undefined };
}
