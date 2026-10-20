// 业务编排层：会话创建、打开、同步、AI 建议、发送、暂停/恢复/人工接管。
// 约束：
// - 所有状态变更必须通过 transitionSession（状态机校验，非法迁移拒绝并落事件）；
// - 所有动作贯穿一个 trace_id，spans 落 traces 表；
// - 发送支持幂等键：同键已发送直接返回，进行中拒绝，失败可重试；
// - 暂停状态拒绝 open/sync/suggest/send；
// - AI 失败（超时/HTTP/输出非法）降级为本地模板并落 AI_DEGRADED 事件。

import {
  insert, update, findRow, listRows, deleteRows, nowIso, addEvent, getDefaultStyleId, listTraces
} from './db.mjs';
import { createTrace } from './trace.mjs';
import { canTransition } from './state-machine.mjs';
import { generateSuggestion, templateSuggestion, AiError } from './ai.mjs';
import * as xhsAdapter from './xhs-adapter.mjs';
import * as linkedinAdapter from './linkedin-adapter.mjs';

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

export const ACTION_ERROR_CODES = [
  'NOT_FOUND', 'VALIDATION', 'STATE_VIOLATION', 'SESSION_PAUSED', 'SEND_IN_PROGRESS', 'ADAPTER_ERROR'
];

let adapters = { xiaohongshu: xhsAdapter, linkedin: linkedinAdapter };

// 评测脚本注入 mock 适配器用
export function setAdapters(next) {
  adapters = { ...adapters, ...next };
}

function platformName(platform) {
  return platform === 'linkedin' ? 'LinkedIn' : '小红书';
}

function adapterFor(platform) {
  const adapter = adapters[platform];
  if (!adapter) throw new ActionError('VALIDATION', `不支持的平台：${platform}`);
  return adapter;
}

export function detectPlatform(profileUrl) {
  try {
    const host = new URL(profileUrl).hostname.toLowerCase();
    if (host.includes('xiaohongshu.com')) return 'xiaohongshu';
    if (host.includes('linkedin.com')) return 'linkedin';
  } catch {
    return '';
  }
  return '';
}

function resolveXhsChatUrl(profileUrl) {
  try {
    const url = new URL(profileUrl);
    const match = url.pathname.match(/\/user\/profile\/([^/?#]+)/);
    if (!match || !match[1]) return '';
    return `https://www.xiaohongshu.com/chat?openUid=${match[1]}`;
  } catch {
    return '';
  }
}

export function resolveChatUrl(profileUrl, platform) {
  return platform === 'xiaohongshu' ? resolveXhsChatUrl(profileUrl) : '';
}

function requireSession(sessionId) {
  const session = findRow('sessions', { id: Number(sessionId) });
  if (!session) throw new ActionError('NOT_FOUND', '会话不存在');
  return session;
}

function assertNotPaused(session) {
  if (session.paused) {
    throw new ActionError('SESSION_PAUSED', '会话已暂停，请先恢复再操作');
  }
}

// 统一状态迁移入口：校验合法性；进入 paused/need_human 时记录 prev_status 供恢复
export function transitionSession(sessionId, toStatus, patch = {}, traceId = '') {
  const session = findRow('sessions', { id: Number(sessionId) });
  if (!session) throw new ActionError('NOT_FOUND', '会话不存在');
  if (session.status !== toStatus && !canTransition(session.status, toStatus)) {
    addEvent(sessionId, 'TRANSITION_REJECTED', `状态迁移被拒绝：${session.status} → ${toStatus}`, {
      from: session.status, to: toStatus
    }, traceId);
    throw new ActionError('STATE_VIOLATION', `当前状态「${session.status}」不允许迁移到「${toStatus}」`);
  }
  const extra = {};
  if ((toStatus === 'paused' || toStatus === 'need_human') && session.status !== toStatus) {
    extra.prev_status = session.status;
  }
  return update('sessions', sessionId, { status: toStatus, ...extra, ...patch, updated_at: nowIso() });
}

// ---------- 读模型 ----------

function profileOf(session) {
  return findRow('profiles', { id: session.profile_id }) || {};
}

function styleOf(session) {
  return findRow('styles', { id: session.style_id }) || {};
}

export function getSessionDetail(sessionId) {
  const session = findRow('sessions', { id: Number(sessionId) });
  if (!session) return null;
  const profile = profileOf(session);
  let chatUrl = session.chat_url;
  if (!chatUrl && profile.profile_url) {
    chatUrl = resolveChatUrl(profile.profile_url, session.platform);
    if (chatUrl) {
      update('sessions', session.id, { chat_url: chatUrl, updated_at: nowIso() });
      session.chat_url = chatUrl;
    }
  }
  const style = styleOf(session);
  return {
    ...session,
    profile_url: profile.profile_url || '',
    chat_url: chatUrl || '',
    display_name: profile.display_name || '',
    profile_status: profile.status || '',
    style_name: style.name || '',
    messages: listRows('messages', { session_id: session.id }),
    events: listRows('events', { session_id: session.id }, { orderBy: 'id DESC', limit: 30 })
  };
}

export function listSessions() {
  return listRows('sessions', {}, { orderBy: 'updated_at DESC' }).map(session => {
    const profile = profileOf(session);
    const last = listRows('messages', { session_id: session.id }, { orderBy: 'id DESC', limit: 1 })[0];
    return {
      ...session,
      profile_url: profile.profile_url || '',
      chat_url: session.chat_url || resolveChatUrl(profile.profile_url || '', session.platform),
      display_name: profile.display_name || '',
      profile_error: profile.last_error || '',
      style_name: styleOf(session).name || '',
      last_message: last?.content || ''
    };
  });
}

export function getSessionTraces(sessionId, limit = 20) {
  requireSession(sessionId);
  return listTraces(sessionId, limit).map(row => ({
    ...row,
    spans: JSON.parse(row.spans_json || '[]')
  }));
}

// ---------- 写动作 ----------

export function createSession(profileUrl) {
  const url = String(profileUrl || '').trim();
  const platform = detectPlatform(url);
  if (!platform) throw new ActionError('VALIDATION', '请输入小红书或 LinkedIn 主页 URL');
  const chatUrl = resolveChatUrl(url, platform);
  const now = nowIso();
  let profile = findRow('profiles', { profile_url: url });
  if (!profile) {
    profile = insert('profiles', {
      platform, profile_url: url, display_name: '', status: 'new', last_error: '', created_at: now, updated_at: now
    });
  }
  let session = listRows('sessions', { profile_id: profile.id }, { orderBy: 'id DESC', limit: 1 })[0];
  if (!session) {
    session = insert('sessions', {
      profile_id: profile.id,
      platform,
      status: 'created',
      prev_status: '',
      chat_url: chatUrl,
      style_id: getDefaultStyleId(),
      need_human: 0,
      paused: 0,
      last_error: '',
      created_at: now,
      updated_at: now
    });
    addEvent(session.id, 'SESSION_CREATED', `已创建${platformName(platform)}建联会话`, { profileUrl: url });
  } else if (!session.chat_url && chatUrl) {
    update('sessions', session.id, { chat_url: chatUrl, updated_at: nowIso() });
  }
  return getSessionDetail(session.id);
}

export function deleteSession(sessionId) {
  requireSession(sessionId);
  const deleted = {
    messages: deleteRows('messages', { session_id: Number(sessionId) }),
    events: deleteRows('events', { session_id: Number(sessionId) }),
    sessions: deleteRows('sessions', { id: Number(sessionId) })
  };
  // traces 保留作为审计记录
  return { ok: true, deleted };
}

export async function openSession(sessionId) {
  const session = requireSession(sessionId);
  assertNotPaused(session);
  const trace = createTrace({ sessionId: session.id, action: 'open' });
  try {
    transitionSession(sessionId, 'opening', {}, trace.traceId);
    const adapter = adapterFor(session.platform);
    const result = await trace.span('adapter.openAndReadProfile', () => adapter.openAndReadProfile(session.profile_url));
    const status = result.needHuman ? 'need_human' : 'opened';
    update('profiles', session.profile_id, {
      display_name: result.displayName || profileOf(session).display_name || '',
      status,
      updated_at: nowIso()
    });
    transitionSession(sessionId, status, {
      chat_url: result.chatUrl || session.chat_url || '',
      need_human: result.needHuman ? 1 : 0,
      last_error: ''
    }, trace.traceId);
    addEvent(sessionId, 'PROFILE_OPENED', result.needHuman ? '页面需要人工接管' : '已打开并读取主页',
      result.snapshot || {}, trace.traceId);
    trace.finish({ status: result.needHuman ? 'degraded' : 'ok' });
    return { item: getSessionDetail(sessionId), trace_id: trace.traceId };
  } catch (error) {
    error.traceId = error.traceId || trace.traceId;
    if (!(error instanceof ActionError) || error.code === 'STATE_VIOLATION') {
      // 适配器/CDP 异常：收敛为 need_human，记录 last_error
      if (error.code === 'STATE_VIOLATION') {
        trace.finish({ status: 'error', error: error.message });
        throw error;
      }
      try {
        transitionSession(sessionId, 'need_human', { need_human: 1, last_error: error.message }, trace.traceId);
      } catch {
        // 状态机不允许时仅更新错误信息
        update('sessions', sessionId, { last_error: error.message, updated_at: nowIso() });
      }
      addEvent(sessionId, 'OPEN_FAILED', '打开主页失败', { error: error.message, code: error.code || '' }, trace.traceId);
    }
    trace.finish({ status: 'error', error: error.message });
    throw error instanceof ActionError ? error : new ActionError('ADAPTER_ERROR', error.message);
  }
}

export async function syncSession(sessionId) {
  const session = requireSession(sessionId);
  assertNotPaused(session);
  const trace = createTrace({ sessionId: session.id, action: 'sync' });
  try {
    const adapter = adapterFor(session.platform);
    const result = await trace.span('adapter.readConversation', () => adapter.readConversation(session.chat_url || session.profile_url));
    if (result.needHuman) {
      transitionSession(sessionId, 'need_human', { need_human: 1, last_error: result.reason }, trace.traceId);
      addEvent(sessionId, 'SYNC_NEED_HUMAN', result.reason, {}, trace.traceId);
      trace.finish({ status: 'degraded', error: result.reason });
      return { item: getSessionDetail(sessionId), trace_id: trace.traceId };
    }
    const existing = new Set(listRows('messages', { session_id: sessionId }).map(row => `${row.role}:${row.content}`));
    let inserted = 0;
    for (const message of result.messages || []) {
      const key = `${message.role}:${message.content}`;
      if (!existing.has(key)) {
        insert('messages', {
          session_id: sessionId,
          role: message.role,
          content: message.content,
          send_status: 'saved',
          source: session.platform,
          idempotency_key: '',
          sent_at: '',
          error_msg: '',
          created_at: nowIso()
        });
        inserted += 1;
      }
    }
    trace.mark('db.write', { detail: { inserted, total: (result.messages || []).length } });
    transitionSession(sessionId, 'synced', {
      chat_url: result.chatUrl || session.chat_url || '',
      need_human: 0,
      last_error: ''
    }, trace.traceId);
    addEvent(sessionId, 'CONVERSATION_SYNCED', result.reason, { count: (result.messages || []).length, inserted }, trace.traceId);
    trace.finish({ status: 'ok' });
    return { item: getSessionDetail(sessionId), trace_id: trace.traceId };
  } catch (error) {
    error.traceId = error.traceId || trace.traceId;
    if (!(error instanceof ActionError) || error.code === 'STATE_VIOLATION') {
      if (error.code === 'STATE_VIOLATION') {
        trace.finish({ status: 'error', error: error.message });
        throw error;
      }
      try {
        transitionSession(sessionId, 'need_human', { need_human: 1, last_error: error.message }, trace.traceId);
      } catch {
        update('sessions', sessionId, { last_error: error.message, updated_at: nowIso() });
      }
      addEvent(sessionId, 'SYNC_FAILED', '读取聊天失败', { error: error.message, code: error.code || '' }, trace.traceId);
    }
    trace.finish({ status: 'error', error: error.message });
    throw error instanceof ActionError ? error : new ActionError('ADAPTER_ERROR', error.message);
  }
}

export async function suggestSession(sessionId) {
  const session = requireSession(sessionId);
  assertNotPaused(session);
  const trace = createTrace({ sessionId: session.id, action: 'suggest' });
  try {
    const fresh = getSessionDetail(sessionId);
    const style = findRow('styles', { id: fresh.style_id }) || listRows('styles', {}, { limit: 1 })[0] || {};
    let suggestion;
    try {
      suggestion = await trace.span('ai.generateSuggestion', () => generateSuggestion({
        profile: fresh, messages: fresh.messages, style
      }));
    } catch (error) {
      if (error instanceof AiError) {
        // 契约内失败：降级为本地模板，不中断流程
        suggestion = templateSuggestion({ profile: fresh, messages: fresh.messages, style });
        suggestion.degraded = true;
        trace.mark('ai.degraded', { detail: { code: error.code, error: error.message } });
        addEvent(sessionId, 'AI_DEGRADED', `AI 建议生成降级（${error.code}），已使用本地模板`, {
          code: error.code, error: error.message
        }, trace.traceId);
      } else {
        throw error;
      }
    }
    insert('messages', {
      session_id: sessionId,
      role: 'ai_suggestion',
      content: suggestion.reply,
      send_status: 'draft',
      source: suggestion.source,
      idempotency_key: '',
      sent_at: '',
      error_msg: '',
      created_at: nowIso()
    });
    transitionSession(sessionId, 'ai_ready', {}, trace.traceId);
    addEvent(sessionId, 'AI_SUGGESTED', `AI 已生成建议回复（${suggestion.source}）`, {
      source: suggestion.source, degraded: Boolean(suggestion.degraded), risk: suggestion.risk
    }, trace.traceId);
    trace.finish({ status: suggestion.degraded ? 'degraded' : 'ok' });
    return { item: getSessionDetail(sessionId), suggestion, trace_id: trace.traceId };
  } catch (error) {
    error.traceId = error.traceId || trace.traceId;
    trace.finish({ status: 'error', error: error.message });
    if (error instanceof ActionError) throw error;
    addEvent(sessionId, 'SUGGEST_FAILED', '生成建议失败', { error: error.message }, trace.traceId);
    throw new ActionError('ADAPTER_ERROR', error.message);
  }
}

export async function sendSessionMessage(sessionId, content, { idempotencyKey = '' } = {}) {
  const text = String(content || '').trim();
  if (!text) throw new ActionError('VALIDATION', '发送内容不能为空');
  const session = requireSession(sessionId);
  assertNotPaused(session);

  // 幂等检查：同键已发送直接返回；发送中拒绝；失败复用原行重试
  let row = null;
  if (idempotencyKey) {
    const existing = findRow('messages', { session_id: Number(sessionId), idempotency_key: idempotencyKey });
    if (existing) {
      if (existing.send_status === 'sent') {
        return {
          item: getSessionDetail(sessionId),
          result: { ok: true, duplicate: true, reason: '该幂等键对应消息已发送，跳过重复发送' },
          trace_id: ''
        };
      }
      if (existing.send_status === 'pending') {
        throw new ActionError('SEND_IN_PROGRESS', '同幂等键的消息正在发送中，请勿重复提交');
      }
      row = update('messages', existing.id, {
        content: text, send_status: 'pending', error_msg: '', source: 'local'
      });
    }
  }

  const trace = createTrace({ sessionId: session.id, action: 'send' });
  try {
    if (!row) {
      row = insert('messages', {
        session_id: sessionId,
        role: 'user',
        content: text,
        send_status: 'pending',
        source: 'local',
        idempotency_key: idempotencyKey || '',
        sent_at: '',
        error_msg: '',
        created_at: nowIso()
      });
    }
    const adapter = adapterFor(session.platform);
    const result = await trace.span('adapter.sendMessage', () => adapter.sendMessage(session.chat_url || session.profile_url, text));
    if (!result.ok) {
      update('messages', row.id, { send_status: 'failed', error_msg: result.reason });
      transitionSession(sessionId, result.needHuman ? 'need_human' : 'send_failed', {
        chat_url: result.chatUrl || session.chat_url || '',
        need_human: result.needHuman ? 1 : 0,
        last_error: result.reason
      }, trace.traceId);
      addEvent(sessionId, 'SEND_FAILED', result.reason, result, trace.traceId);
      trace.finish({ status: 'error', error: result.reason });
      return { item: getSessionDetail(sessionId), result, trace_id: trace.traceId };
    }
    update('messages', row.id, { send_status: 'sent', sent_at: nowIso() });
    transitionSession(sessionId, 'sent', {
      chat_url: result.chatUrl || session.chat_url || '', need_human: 0, last_error: ''
    }, trace.traceId);
    addEvent(sessionId, 'MESSAGE_SENT', `${platformName(session.platform)}消息已发送`, result, trace.traceId);
    trace.finish({ status: 'ok' });
    return { item: getSessionDetail(sessionId), result, trace_id: trace.traceId };
  } catch (error) {
    error.traceId = error.traceId || trace.traceId;
    update('messages', row.id, { send_status: 'failed', error_msg: error.message });
    try {
      transitionSession(sessionId, 'need_human', { need_human: 1, last_error: error.message }, trace.traceId);
    } catch {
      update('sessions', sessionId, { last_error: error.message, updated_at: nowIso() });
    }
    addEvent(sessionId, 'SEND_ERROR', '发送异常', { error: error.message, code: error.code || '' }, trace.traceId);
    trace.finish({ status: 'error', error: error.message });
    throw error instanceof ActionError ? error : new ActionError('ADAPTER_ERROR', error.message);
  }
}

export function pauseSession(sessionId) {
  const session = requireSession(sessionId);
  transitionSession(sessionId, 'paused', { paused: 1 });
  addEvent(sessionId, 'PAUSED', '会话已暂停', { from: session.status });
  return getSessionDetail(sessionId);
}

export function resumeSession(sessionId) {
  const session = requireSession(sessionId);
  // 恢复语义：回到暂停/接管前记录的状态，而不是固定状态
  const target = session.prev_status && canTransition(session.status, session.prev_status)
    ? session.prev_status
    : 'created';
  transitionSession(sessionId, target, { paused: 0, need_human: 0, prev_status: '', last_error: '' });
  addEvent(sessionId, 'RESUMED', `会话已恢复至「${target}」`, { from: session.status, to: target });
  return getSessionDetail(sessionId);
}

export function handoffSession(sessionId) {
  const session = requireSession(sessionId);
  transitionSession(sessionId, 'need_human', { need_human: 1 });
  addEvent(sessionId, 'HANDOFF', '人工接管会话', { from: session.status });
  return getSessionDetail(sessionId);
}

export function applyStyle(styleId, sessionId) {
  requireSession(sessionId);
  update('sessions', sessionId, { style_id: Number(styleId), updated_at: nowIso() });
  addEvent(sessionId, 'STYLE_CHANGED', '聊天风格已切换', { styleId: Number(styleId) });
  return getSessionDetail(sessionId);
}

export function createStyle(body = {}) {
  const now = nowIso();
  return insert('styles', {
    name: String(body.name || '自定义风格').slice(0, 100),
    tone: String(body.tone || ''),
    identity: String(body.identity || ''),
    goal: String(body.goal || ''),
    length_rule: String(body.length_rule || body.lengthRule || ''),
    avoid_rule: String(body.avoid_rule || body.avoidRule || ''),
    extra_prompt: String(body.extra_prompt || body.extraPrompt || ''),
    is_default: 0,
    created_at: now,
    updated_at: now
  });
}

export function listStyles() {
  return listRows('styles', {}, { orderBy: 'is_default DESC, id ASC' });
}
