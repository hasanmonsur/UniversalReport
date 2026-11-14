import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReportFormat } from '../src/shared/reportTypes.ts';

export interface StoredTemplateRecord {
  id: string;
  json: string;
  contentHash: string;
  updatedAt: string;
}

export interface TemplateRevisionRecord {
  revisionId: number;
  reportId: string;
  contentHash: string;
  savedAt: string;
  json: string;
}

export interface StoredJobRecord {
  jobId: string;
  reportId: string;
  format: ReportFormat;
  status: 'Queued' | 'Completed' | 'Failed';
  createdAtUtc: string;
  expiresAtUtc: string;
  buffer?: Buffer;
  contentType?: string;
  fileName?: string;
  errorCode?: string;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'universalreport.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS template_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id TEXT NOT NULL,
    json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_template_revisions_report
    ON template_revisions (report_id, id DESC);
  CREATE TABLE IF NOT EXISTS report_jobs (
    job_id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    expires_at_utc TEXT NOT NULL,
    payload BLOB,
    content_type TEXT,
    file_name TEXT,
    error_code TEXT
  );
`);

export function getDatabasePath(): string {
  return DB_PATH;
}

export function seedTemplateIfMissing(record: StoredTemplateRecord): void {
  const existing = db.prepare('SELECT id FROM templates WHERE id = ?').get(record.id) as
    | { id: string }
    | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO templates (id, json, content_hash, updated_at) VALUES (?, ?, ?, ?)'
    ).run(record.id, record.json, record.contentHash, record.updatedAt);

    const revCount = db
      .prepare('SELECT COUNT(*) AS cnt FROM template_revisions WHERE report_id = ?')
      .get(record.id) as { cnt: number };
    if (!revCount || revCount.cnt === 0) {
      db.prepare(
        'INSERT INTO template_revisions (report_id, json, content_hash, saved_at) VALUES (?, ?, ?, ?)'
      ).run(record.id, record.json, record.contentHash, record.updatedAt);
    }
  }
}

export function listTemplates(): StoredTemplateRecord[] {
  const rows = db
    .prepare('SELECT id, json, content_hash, updated_at FROM templates ORDER BY id ASC')
    .all() as Array<{
    id: string;
    json: string;
    content_hash: string;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    json: r.json,
    contentHash: r.content_hash,
    updatedAt: r.updated_at,
  }));
}

export function saveTemplateRevision(record: StoredTemplateRecord): number {
  db.prepare(
    `INSERT INTO templates (id, json, content_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       json = excluded.json,
       content_hash = excluded.content_hash,
       updated_at = excluded.updated_at`
  ).run(record.id, record.json, record.contentHash, record.updatedAt);

  const info = db
    .prepare(
      'INSERT INTO template_revisions (report_id, json, content_hash, saved_at) VALUES (?, ?, ?, ?)'
    )
    .run(record.id, record.json, record.contentHash, record.updatedAt);

  return Number(info.lastInsertRowid);
}

export function listTemplateRevisions(reportId: string, limit = 25): TemplateRevisionRecord[] {
  const rows = db
    .prepare(
      'SELECT id, report_id, json, content_hash, saved_at FROM template_revisions WHERE report_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all(reportId, limit) as Array<{
    id: number;
    report_id: string;
    json: string;
    content_hash: string;
    saved_at: string;
  }>;

  return rows.map((r) => ({
    revisionId: r.id,
    reportId: r.report_id,
    json: r.json,
    contentHash: r.content_hash,
    savedAt: r.saved_at,
  }));
}

export function upsertJob(record: StoredJobRecord): void {
  const payload = record.buffer ? new Uint8Array(record.buffer) : null;
  db.prepare(
    `INSERT INTO report_jobs (
       job_id, report_id, format, status, created_at_utc, expires_at_utc,
       payload, content_type, file_name, error_code
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       status = excluded.status,
       payload = excluded.payload,
       content_type = excluded.content_type,
       file_name = excluded.file_name,
       error_code = excluded.error_code`
  ).run(
    record.jobId,
    record.reportId,
    record.format,
    record.status,
    record.createdAtUtc,
    record.expiresAtUtc,
    payload,
    record.contentType ?? null,
    record.fileName ?? null,
    record.errorCode ?? null
  );
}

export function getJob(jobId: string): StoredJobRecord | null {
  const row = db
    .prepare(
      `SELECT job_id, report_id, format, status, created_at_utc, expires_at_utc,
              payload, content_type, file_name, error_code
       FROM report_jobs WHERE job_id = ?`
    )
    .get(jobId) as
    | {
        job_id: string;
        report_id: string;
        format: ReportFormat;
        status: 'Queued' | 'Completed' | 'Failed';
        created_at_utc: string;
        expires_at_utc: string;
        payload: Uint8Array | null;
        content_type: string | null;
        file_name: string | null;
        error_code: string | null;
      }
    | undefined;

  if (!row) return null;
  return {
    jobId: row.job_id,
    reportId: row.report_id,
    format: row.format,
    status: row.status,
    createdAtUtc: row.created_at_utc,
    expiresAtUtc: row.expires_at_utc,
    buffer: row.payload ? Buffer.from(row.payload) : undefined,
    contentType: row.content_type ?? undefined,
    fileName: row.file_name ?? undefined,
    errorCode: row.error_code ?? undefined,
  };
}

export function purgeExpiredJobs(): number {
  const now = new Date().toISOString();
  const info = db.prepare('DELETE FROM report_jobs WHERE expires_at_utc < ?').run(now);
  return Number(info.changes ?? 0);
}
