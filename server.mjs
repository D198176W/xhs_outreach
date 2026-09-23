import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, insert, update, save, nowIso, addEvent, getDefaultStyleId } from './lib/db.mjs';
import { generateSuggestion } from './lib/ai.mjs';
import * as xhsAdapter from './lib/xhs-adapter.mjs';
import * as linkedinAdapter from './lib/linkedin-adapter.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 5188);

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
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

function detectPlatform(profileUrl) {
  try {
    const host = new URL(profileUrl).hostname.toLowerCase();
    if (host.includes('xiaohongshu.com')) return 'xiaohongshu';
    if (host.includes('linkedin.com')) return 'linkedin';
  } catch {
    return '';
  }
  return '';
}

function adapterFor(platform) {
  if (platform === 'linkedin') return linkedinAdapter;
  return xhsAdapter;
}

function platformName(platform) {
  return platform === 'linkedin' ? 'LinkedIn' : '小红书';
}

function resolveChatUrl(profileUrl, platform) {
  return platform === 'xiaohongshu' ? resolveXhsChatUrl(profileUrl) : '';
}

function profileOf(session) {
  return store.profiles.find(item => item.id === session.profile_id) || {};
}

function styleOf(session) {
  return store.styles.find(item => item.id === session.style_id) || {};
}

function sessionDetail(sessionId) {
  const session = store.sessions.find(item => item.id === Number(sessionId));
  if (!session) return null;
  const profile = profileOf(session);
  if (!session.chat_url && profile.profile_url) {
    const chatUrl = resolveChatUrl(profile.profile_url, session.platform);
    if (chatUrl) {
      update('sessions', session.id, { chat_url: chatUrl, updated_at: nowIso() });
      session.chat_url = chatUrl;
    }
  }
  const style = styleOf(session);
  return {
    ...session,
    profile_url: profile.profile_url || '',
    chat_url: session.chat_url || resolveChatUrl(profile.profile_url || '', session.platform),
    display_name: profile.display_name || '',
    profile_status: profile.status || '',
    style_name: style.name || '',
    messages: store.messages.filter(item => item.session_id === session.id).sort((a, b) => a.id - b.id),
    events: store.events.filter(item => item.session_id === session.id).sort((a, b) => b.id - a.id).slice(0, 30)
  };
}

function sessionList() {
  return store.sessions.map(session => {
    const profile = profileOf(session);
    if (!session.chat_url && profile.profile_url) {
      const chatUrl = resolveChatUrl(profile.profile_url, session.platform);
      if (chatUrl) {
        update('sessions', session.id, { chat_url: chatUrl, updated_at: nowIso() });
        session.chat_url = chatUrl;
      }
    }
    const style = styleOf(session);
    const last = store.messages.filter(item => item.session_id === session.id).sort((a, b) => b.id - a.id)[0];
    return {
      ...session,
      profile_url: profile.profile_url || '',
      chat_url: session.chat_url || resolveChatUrl(profile.profile_url || '', session.platform),
      display_name: profile.display_name || '',
      profile_error: profile.last_error || '',
      style_name: style.name || '',
      last_message: last?.content || ''
    };
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return json(res, 200, { items: sessionList() });
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req);
    const profileUrl = String(body.profileUrl || '').trim();
    const platform = detectPlatform(profileUrl);
    if (!platform) {
      return json(res, 400, { error: '请输入小红书或 LinkedIn 主页 URL' });
    }
    const chatUrl = resolveChatUrl(profileUrl, platform);
    const now = nowIso();
    let profile = store.profiles.find(item => item.profile_url === profileUrl);
    if (!profile) {
      profile = insert('profiles', {
        platform,
        profile_url: profileUrl,
        display_name: '',
        status: 'new',
        last_error: '',
        created_at: now,
        updated_at: now
      });
    }
    let session = store.sessions.filter(item => item.profile_id === profile.id).sort((a, b) => b.id - a.id)[0];
    if (!session) {
      session = insert('sessions', {
        profile_id: profile.id,
        platform,
        status: 'created',
        chat_url: chatUrl,
        style_id: getDefaultStyleId(),
        need_human: 0,
        paused: 0,
        last_error: '',
        created_at: now,
        updated_at: now
      });
      addEvent(session.id, 'SESSION_CREATED', `已创建${platformName(platform)}建联会话`, { profileUrl });
    } else if (!session.chat_url && chatUrl) {
      update('sessions', session.id, { chat_url: chatUrl, updated_at: nowIso() });
    }
    return json(res, 200, { item: sessionDetail(session.id) });
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const sessionId = Number(sessionMatch[1]);
    const action = sessionMatch[2];
    const session = sessionDetail(sessionId);
    if (!session) return json(res, 404, { error: '会话不存在' });

    if (req.method === 'GET' && !action) {
      return json(res, 200, { item: session });
    }

    if (req.method === 'DELETE' && !action) {
      const before = {
        sessions: store.sessions.length,
        messages: store.messages.length,
        events: store.events.length
      };
      store.sessions = store.sessions.filter(item => item.id !== sessionId);
      store.messages = store.messages.filter(item => item.session_id !== sessionId);
      store.events = store.events.filter(item => item.session_id !== sessionId);
      save();
      return json(res, 200, {
        ok: true,
        deleted: {
          sessions: before.sessions - store.sessions.length,
          messages: before.messages - store.messages.length,
          events: before.events - store.events.length
        }
      });
    }

    if (req.method === 'POST' && action === 'open') {
      try {
        update('sessions', sessionId, { status: 'opening', updated_at: nowIso() });
        const adapter = adapterFor(session.platform);
        const result = await adapter.openAndReadProfile(session.profile_url);
        const status = result.needHuman ? 'need_human' : 'opened';
        update('profiles', session.profile_id, {
          display_name: result.displayName || session.display_name || '',
          status,
          updated_at: nowIso()
        });
        update('sessions', sessionId, { status, chat_url: result.chatUrl || session.chat_url || '', need_human: result.needHuman ? 1 : 0, last_error: '', updated_at: nowIso() });
        addEvent(sessionId, 'PROFILE_OPENED', result.needHuman ? '页面需要人工接管' : '已打开并读取主页', result.snapshot);
        return json(res, 200, { item: sessionDetail(sessionId) });
      } catch (error) {
        update('sessions', sessionId, { status: 'need_human', need_human: 1, last_error: error.message, updated_at: nowIso() });
        addEvent(sessionId, 'OPEN_FAILED', '打开主页失败', { error: error.message });
        return json(res, 500, { error: error.message, item: sessionDetail(sessionId) });
      }
    }

    if (req.method === 'POST' && action === 'sync') {
      try {
        const adapter = adapterFor(session.platform);
        const result = await adapter.readConversation(session.chat_url || session.profile_url);
        if (result.needHuman) {
          update('sessions', sessionId, { status: 'need_human', need_human: 1, last_error: result.reason, updated_at: nowIso() });
          addEvent(sessionId, 'SYNC_NEED_HUMAN', result.reason, result);
          return json(res, 200, { item: sessionDetail(sessionId) });
        }
        const existing = new Set(store.messages.filter(item => item.session_id === sessionId).map(row => `${row.role}:${row.content}`));
        for (const message of result.messages || []) {
          const key = `${message.role}:${message.content}`;
          if (!existing.has(key)) {
            insert('messages', {
              session_id: sessionId,
              role: message.role,
              content: message.content,
              send_status: 'saved',
              source: session.platform,
              created_at: nowIso(),
              sent_at: '',
              error_msg: ''
            });
          }
        }
        update('sessions', sessionId, { status: 'synced', chat_url: result.chatUrl || session.chat_url || '', need_human: 0, last_error: '', updated_at: nowIso() });
        addEvent(sessionId, 'CONVERSATION_SYNCED', result.reason, { count: (result.messages || []).length });
        return json(res, 200, { item: sessionDetail(sessionId) });
      } catch (error) {
        update('sessions', sessionId, { status: 'need_human', need_human: 1, last_error: error.message, updated_at: nowIso() });
        addEvent(sessionId, 'SYNC_FAILED', '读取聊天失败', { error: error.message });
        return json(res, 500, { error: error.message, item: sessionDetail(sessionId) });
      }
    }

    if (req.method === 'POST' && action === 'suggest') {
      const fresh = sessionDetail(sessionId);
      const style = store.styles.find(item => item.id === fresh.style_id) || store.styles[0];
      const suggestion = await generateSuggestion({ profile: fresh, messages: fresh.messages, style });
      insert('messages', {
        session_id: sessionId,
        role: 'ai_suggestion',
        content: suggestion.reply,
        send_status: 'draft',
        source: 'ai',
        created_at: nowIso(),
        sent_at: '',
        error_msg: ''
      });
      update('sessions', sessionId, { status: 'ai_ready', updated_at: nowIso() });
      addEvent(sessionId, 'AI_SUGGESTED', 'AI 已生成建议回复', suggestion);
      return json(res, 200, { item: sessionDetail(sessionId), suggestion });
    }

    if (req.method === 'POST' && action === 'send') {
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      if (!content) return json(res, 400, { error: '发送内容不能为空' });
      const row = insert('messages', {
        session_id: sessionId,
        role: 'user',
        content,
        send_status: 'pending',
        source: 'local',
        created_at: nowIso(),
        sent_at: '',
        error_msg: ''
      });
      try {
        const adapter = adapterFor(session.platform);
        const result = await adapter.sendMessage(session.chat_url || session.profile_url, content);
        if (!result.ok) {
          update('messages', row.id, { send_status: 'failed', error_msg: result.reason });
          update('sessions', sessionId, {
            status: result.needHuman ? 'need_human' : 'send_failed',
            chat_url: result.chatUrl || session.chat_url || '',
            need_human: result.needHuman ? 1 : 0,
            last_error: result.reason,
            updated_at: nowIso()
          });
          addEvent(sessionId, 'SEND_FAILED', result.reason, result);
          return json(res, 200, { item: sessionDetail(sessionId), result });
        }
        update('messages', row.id, { send_status: 'sent', sent_at: nowIso() });
        update('sessions', sessionId, { status: 'sent', chat_url: result.chatUrl || session.chat_url || '', need_human: 0, last_error: '', updated_at: nowIso() });
        addEvent(sessionId, 'MESSAGE_SENT', `${platformName(session.platform)}消息已发送`, result);
        return json(res, 200, { item: sessionDetail(sessionId), result });
      } catch (error) {
        update('messages', row.id, { send_status: 'failed', error_msg: error.message });
        update('sessions', sessionId, { status: 'need_human', need_human: 1, last_error: error.message, updated_at: nowIso() });
        addEvent(sessionId, 'SEND_ERROR', '发送异常', { error: error.message });
        return json(res, 500, { error: error.message, item: sessionDetail(sessionId) });
      }
    }

    if (req.method === 'POST' && ['pause', 'resume', 'handoff'].includes(action)) {
      const patch = action === 'pause'
        ? { status: 'paused', paused: 1 }
        : action === 'resume'
          ? { status: 'synced', paused: 0, need_human: 0 }
          : { status: 'need_human', need_human: 1 };
      update('sessions', sessionId, { ...patch, updated_at: nowIso() });
      addEvent(sessionId, action.toUpperCase(), action === 'handoff' ? '人工接管会话' : action === 'pause' ? '会话已暂停' : '会话已恢复');
      return json(res, 200, { item: sessionDetail(sessionId) });
    }
  }

  if (req.method === 'GET' && pathname === '/api/styles') {
    const items = [...store.styles].sort((a, b) => (b.is_default - a.is_default) || (a.id - b.id));
    return json(res, 200, { items });
  }

  if (req.method === 'POST' && pathname === '/api/styles') {
    const body = await readBody(req);
    const now = nowIso();
    const item = insert('styles', {
      name: body.name || '自定义风格',
      tone: body.tone || '',
      identity: body.identity || '',
      goal: body.goal || '',
      length_rule: body.length_rule || body.lengthRule || '',
      avoid_rule: body.avoid_rule || body.avoidRule || '',
      extra_prompt: body.extra_prompt || body.extraPrompt || '',
      is_default: 0,
      created_at: now,
      updated_at: now
    });
    return json(res, 200, { item });
  }

  const styleUse = pathname.match(/^\/api\/styles\/(\d+)\/use$/);
  if (req.method === 'POST' && styleUse) {
    const styleId = Number(styleUse[1]);
    const body = await readBody(req);
    const sessionId = Number(body.sessionId);
    update('sessions', sessionId, { style_id: styleId, updated_at: nowIso() });
    addEvent(sessionId, 'STYLE_CHANGED', '聊天风格已切换', { styleId });
    return json(res, 200, { item: sessionDetail(sessionId) });
  }

  return json(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(fs.readFileSync(file));
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Outreach Workspace http://127.0.0.1:${port}`);
});
