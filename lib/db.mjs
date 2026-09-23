import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = path.dirname(root);
const dbPath = path.join(workspaceRoot, 'logs', 'xhs-outreach', 'runtime-store.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const empty = {
  profiles: [],
  sessions: [],
  messages: [],
  styles: [],
  events: [],
  counters: { profiles: 1, sessions: 1, messages: 1, styles: 1, events: 1 }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch {
    return clone(empty);
  }
}

export const store = load();

export function save() {
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
}

export function nowIso() {
  return new Date().toISOString();
}

export function insert(table, row) {
  const id = store.counters[table]++;
  const item = { id, ...row };
  store[table].push(item);
  save();
  return item;
}

export function update(table, id, patch) {
  const item = store[table].find(row => row.id === Number(id));
  if (!item) return null;
  Object.assign(item, patch);
  save();
  return item;
}

export function addEvent(sessionId, type, summary, detail = {}) {
  return insert('events', {
    session_id: Number(sessionId),
    type,
    summary,
    detail_json: JSON.stringify(detail),
    created_at: nowIso()
  });
}

export function getDefaultStyleId() {
  const row = store.styles.find(style => style.is_default) || store.styles[0];
  return row ? row.id : null;
}

if (!store.styles.length) {
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
