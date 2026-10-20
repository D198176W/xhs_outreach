// SQLite 数据层（node:sqlite，Node >= 22.5）。
// 表：profiles / sessions / messages / styles / events / traces。
// 路径可用环境变量 OUTREACH_DB 覆盖（评测脚本使用临时库）。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = path.dirname(root);
const defaultDbPath = path.join(workspaceRoot, 'logs', 'xhs-outreach', 'outreach.db');
const dbPath = process.env.OUTREACH_DB || defaultDbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const TABLES = new Set(['profiles', 'sessions', 'messages', 'styles', 'events', 'traces']);

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    profile_url TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    prev_status TEXT NOT NULL DEFAULT '',
    chat_url TEXT NOT NULL DEFAULT '',
    style_id INTEGER,
    need_human INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    send_status TEXT NOT NULL DEFAULT 'saved',
    source TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL DEFAULT '',
    error_msg TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_idem
    ON messages(session_id, idempotency_key) WHERE idempotency_key <> '';
  CREATE TABLE IF NOT EXISTS styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT '',
    identity TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    length_rule TEXT NOT NULL DEFAULT '',
    avoid_rule TEXT NOT NULL DEFAULT '',
    extra_prompt TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    trace_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL UNIQUE,
    session_id INTEGER,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    spans_json TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
`);

function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function whereSql(where = {}) {
  const cols = Object.keys(where);
  if (!cols.length) return { clause: '', params: [] };
  return {
    clause: ` WHERE ${cols.map(col => `${col} = ?`).join(' AND ')}`,
    params: cols.map(col => normalize(where[col]))
  };
}

function checkTable(table) {
  if (!TABLES.has(table)) throw new Error(`未知数据表：${table}`);
}

export function nowIso() {
  return new Date().toISOString();
}

export function insert(table, row) {
  checkTable(table);
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const result = db.prepare(sql).run(...cols.map(col => normalize(row[col])));
  return { id: Number(result.lastInsertRowid), ...row };
}

export function update(table, id, patch) {
  checkTable(table);
  const cols = Object.keys(patch);
  if (!cols.length) return findRow(table, { id });
  const sql = `UPDATE ${table} SET ${cols.map(col => `${col} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...cols.map(col => normalize(patch[col])), Number(id));
  return findRow(table, { id: Number(id) });
}

export function findRow(table, where) {
  checkTable(table);
  const { clause, params } = whereSql(where);
  return db.prepare(`SELECT * FROM ${table}${clause}`).get(...params) || null;
}

export function listRows(table, where = {}, { orderBy = 'id ASC', limit = 0 } = {}) {
  checkTable(table);
  const { clause, params } = whereSql(where);
  const limitSql = limit > 0 ? ` LIMIT ${Number(limit)}` : '';
  return db.prepare(`SELECT * FROM ${table}${clause} ORDER BY ${orderBy}${limitSql}`).all(...params);
}

export function deleteRows(table, where = {}) {
  checkTable(table);
  const { clause, params } = whereSql(where);
  const result = db.prepare(`DELETE FROM ${table}${clause}`).run(...params);
  return Number(result.changes);
}

export function countRows(table, where = {}) {
  checkTable(table);
  const { clause, params } = whereSql(where);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${clause}`).get(...params);
  return Number(row.n);
}

export function addEvent(sessionId, type, summary, detail = {}, traceId = '') {
  return insert('events', {
    session_id: sessionId === null || sessionId === undefined ? null : Number(sessionId),
    type,
    summary,
    detail_json: JSON.stringify(detail),
    trace_id: traceId || '',
    created_at: nowIso()
  });
}

export function saveTrace(record) {
  db.prepare(`
    INSERT OR REPLACE INTO traces (trace_id, session_id, action, status, duration_ms, spans_json, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.trace_id,
    record.session_id ?? null,
    record.action,
    record.status || 'ok',
    Number(record.duration_ms || 0),
    record.spans_json || '[]',
    record.error || '',
    record.created_at || nowIso()
  );
  return record;
}

export function listTraces(sessionId, limit = 20) {
  return listRows('traces', { session_id: Number(sessionId) }, { orderBy: 'id DESC', limit });
}

export function getDefaultStyleId() {
  const row = findRow('styles', { is_default: 1 }) || listRows('styles', {}, { orderBy: 'id ASC', limit: 1 })[0];
  return row ? row.id : null;
}

// 旧版 JSON 存储（runtime-store.json）一次性迁移；库非空时跳过。
function migrateFromJson() {
  const jsonPath = path.join(workspaceRoot, 'logs', 'xhs-outreach', 'runtime-store.json');
  if (!fs.existsSync(jsonPath) || countRows('sessions') > 0) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let total = 0;
    const defaults = {
      profiles: {},
      sessions: { prev_status: '' },
      messages: { idempotency_key: '' },
      styles: {},
      events: { trace_id: '' }
    };
    for (const table of ['profiles', 'sessions', 'styles', 'messages', 'events']) {
      for (const row of legacy[table] || []) {
        insert(table, { ...defaults[table], ...row });
        total += 1;
      }
    }
    console.log(`[db] 已从 runtime-store.json 迁移 ${total} 条历史数据`);
  } catch (error) {
    console.warn(`[db] 旧数据迁移失败（已忽略）：${error.message}`);
  }
}

migrateFromJson();

if (!countRows('styles')) {
  const now = nowIso();
  insert('styles', {
    name: '专业友好',
    tone: '礼貌、自然、真诚，不要过度热情',
    identity: 'DigClaw 团队成员',
    goal: '表达对对方背景的兴趣，邀请进一步交流',
    length_rule: '80 到 120 字',
    avoid_rule: '不要夸张承诺，不要冒充熟人，不要提敏感隐私，不要连续催促',
    extra_prompt: '',
    is_default: 1,
    created_at: now,
    updated_at: now
  });
}
