import { DurableObject } from "cloudflare:workers";
import { isExpired, PENDING_RESERVATION_TTL_MS } from "./snapshot-policy.ts";

export interface SnapshotHandle {
  id: string;
  size: number;
  name: string;
}

const DELETED_ROW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type DeleteReason =
  | "job_failed"
  | "restore_failed"
  | "expired"
  | "superseded"
  | "stale_pending";

export class SnapshotRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        image_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        snapshot_id TEXT,
        size INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        deleted_at INTEGER,
        reason TEXT
      )
    `);
  }

  private markDeleted(rowId: number, reason: DeleteReason, now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET state = 'deleted', deleted_at = ?, reason = ? WHERE row_id = ?",
      now,
      reason,
      rowId,
    );
  }

  private purgeOldDeletedRows(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM snapshots WHERE state = 'deleted' AND deleted_at < ?",
      now - DELETED_ROW_RETENTION_MS,
    );
  }

  reserve(name: string, imageRef: string, jobId: number): void {
    const now = Date.now();
    this.purgeOldDeletedRows(now);

    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET state = 'deleted', deleted_at = ?, reason = 'stale_pending' WHERE state = 'pending' AND created_at < ?",
      now,
      now - PENDING_RESERVATION_TTL_MS,
    );

    this.ctx.storage.sql.exec(
      "INSERT INTO snapshots (name, image_ref, state, job_id, created_at, last_used_at) VALUES (?, ?, 'pending', ?, ?, ?)",
      name,
      imageRef,
      jobId,
      now,
      now,
    );
  }

  attach(
    name: string,
    imageRef: string,
    jobId: number,
    handle: SnapshotHandle,
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET snapshot_id = ?, size = ? WHERE row_id = (SELECT MAX(row_id) FROM snapshots WHERE name = ? AND image_ref = ? AND job_id = ? AND state = 'pending')",
      handle.id,
      handle.size,
      name,
      imageRef,
      jobId,
    );
  }

  abandon(name: string, imageRef: string, jobId: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET state = 'deleted', deleted_at = ?, reason = 'job_failed' WHERE row_id = (SELECT MAX(row_id) FROM snapshots WHERE name = ? AND image_ref = ? AND job_id = ? AND state = 'pending' AND snapshot_id IS NULL)",
      Date.now(),
      name,
      imageRef,
      jobId,
    );
  }

  promote(jobId: number, succeeded: boolean): void {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<{
        row_id: number;
        name: string;
        image_ref: string;
        snapshot_id: string | null;
      }>(
        "SELECT row_id, name, image_ref, snapshot_id FROM snapshots WHERE job_id = ? AND state = 'pending' ORDER BY row_id",
        jobId,
      )
      .toArray();

    for (const row of rows) {
      if (!succeeded || row.snapshot_id === null) {
        this.markDeleted(row.row_id, "job_failed", now);
        continue;
      }
      const newer = this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM snapshots WHERE name = ? AND image_ref = ? AND state = 'ready' AND row_id > ? LIMIT 1",
          row.name,
          row.image_ref,
          row.row_id,
        )
        .toArray();
      if (newer.length > 0) {
        this.markDeleted(row.row_id, "superseded", now);
        continue;
      }
      this.ctx.storage.sql.exec(
        "UPDATE snapshots SET state = 'deleted', deleted_at = ?, reason = 'superseded' WHERE name = ? AND image_ref = ? AND state = 'ready' AND row_id < ?",
        now,
        row.name,
        row.image_ref,
        row.row_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE snapshots SET state = 'ready', last_used_at = ? WHERE row_id = ?",
        now,
        row.row_id,
      );
    }
  }

  resolve(name: string, imageRef: string): SnapshotHandle | null {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<{
        row_id: number;
        snapshot_id: string;
        size: number;
        last_used_at: number;
      }>(
        "SELECT row_id, snapshot_id, size, last_used_at FROM snapshots WHERE name = ? AND image_ref = ? AND state = 'ready' ORDER BY row_id DESC LIMIT 1",
        name,
        imageRef,
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (isExpired(row.last_used_at, now)) {
      this.markDeleted(row.row_id, "expired", now);
      return null;
    }
    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET last_used_at = ? WHERE row_id = ?",
      now,
      row.row_id,
    );
    return { id: row.snapshot_id, size: row.size, name };
  }

  restoreFailed(snapshotId: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE snapshots SET state = 'deleted', deleted_at = ?, reason = 'restore_failed' WHERE snapshot_id = ? AND state = 'ready'",
      now,
      snapshotId,
    );
  }
}
