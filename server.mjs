// HTTP 服务：路由与错误映射。业务逻辑全部在 lib/actions.mjs。
// 错误响应统一结构：{ error: 信息, code: 错误码, trace_id: 关联轨迹 }。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as actions from './lib/actions.mjs';
import { ActionError } from './lib/actions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 5188);
const startedAt = Date.now();

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

const ERROR_STATUS = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  STATE_VIOLATION: 409,
  SESSION_PAUSED: 409,
  SEND_IN_PROGRESS: 409,
  ADAPTER_ERROR: 502
};

function errorResponse(res, error) {
  const code = error.code || '';
  let status = ERROR_STATUS[code] || 500;
  if (String(code).startsWith('CDP_')) status = 502;
  if (String(code).startsWith('AI_')) status = 502;
  return json(res, status, {
    error: error.message,
    code: code || 'INTERNAL_ERROR',
    trace_id: error.traceId || ''
  });
}

async function handleApi(req, res, pathname) {
  // 会话集合
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return json(res, 200, { items: actions.listSessions() });
  }
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req);
    return json(res, 200, { item: actions.createSession(body.profileUrl) });
  }

  // 单会话与动作
  const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const sessionId = Number(sessionMatch[1]);
    const action = sessionMatch[2];

    if (req.method === 'GET' && !action) {
      const item = actions.getSessionDetail(sessionId);
      if (!item) throw new ActionError('NOT_FOUND', '会话不存在');
      return json(res, 200, { item });
    }
    if (req.method === 'GET' && action === 'traces') {
      return json(res, 200, { items: actions.getSessionTraces(sessionId) });
    }
    if (req.method === 'DELETE' && !action) {
      return json(res, 200, actions.deleteSession(sessionId));
    }
    if (req.method === 'POST' && action === 'open') {
      return json(res, 200, await actions.openSession(sessionId));
    }
    if (req.method === 'POST' && action === 'sync') {
      return json(res, 200, await actions.syncSession(sessionId));
    }
    if (req.method === 'POST' && action === 'suggest') {
      return json(res, 200, await actions.suggestSession(sessionId));
    }
    if (req.method === 'POST' && action === 'send') {
      const body = await readBody(req);
      return json(res, 200, await actions.sendSessionMessage(sessionId, body.content, {
        idempotencyKey: String(body.idempotencyKey || '').trim()
      }));
    }
    if (req.method === 'POST' && ['pause', 'resume', 'handoff'].includes(action)) {
      const item = action === 'pause'
        ? actions.pauseSession(sessionId)
        : action === 'resume'
          ? actions.resumeSession(sessionId)
          : actions.handoffSession(sessionId);
      return json(res, 200, { item });
    }
  }

  // 风格
  if (req.method === 'GET' && pathname === '/api/styles') {
    return json(res, 200, { items: actions.listStyles() });
  }
  if (req.method === 'POST' && pathname === '/api/styles') {
    const body = await readBody(req);
    return json(res, 200, { item: actions.createStyle(body) });
  }
  const styleUse = pathname.match(/^\/api\/styles\/(\d+)\/use$/);
  if (req.method === 'POST' && styleUse) {
    const body = await readBody(req);
    return json(res, 200, { item: actions.applyStyle(Number(styleUse[1]), body.sessionId) });
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
  }

  if (req.method === 'GET' && pathname === '/api/state-machine') {
    const { describeStates } = await import('./lib/state-machine.mjs');
    return json(res, 200, { states: describeStates() });
  }

  return json(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
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
    return errorResponse(res, error);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Outreach Workspace http://127.0.0.1:${port}`);
});
