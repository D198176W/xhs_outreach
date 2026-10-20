// CDP 直连层：通过 /json/list、/json/new 发现目标，用原生 WebSocket 建立命令通道。
// 错误分类：CDP_HTTP_ERROR / CDP_NO_TARGET / CDP_WS_ERROR / CDP_TIMEOUT / CDP_EVAL_ERROR，
// 供上层（actions/server）按错误码决定状态迁移与 HTTP 状态映射。

import http from 'node:http';

export class CdpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

function parseBody(data, what) {
  try {
    return JSON.parse(data);
  } catch {
    throw new CdpError('CDP_HTTP_ERROR', `CDP ${what} 返回的不是 JSON：${String(data).slice(0, 160)}`);
  }
}

function requestJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
      });
      response.on('end', () => resolve(parseBody(data, `${method} ${url}`)));
    });
    request.on('error', error => reject(new CdpError('CDP_HTTP_ERROR', `无法连接 CDP 端口：${error.message}`)));
    request.end();
  });
}

export function getJson(url) {
  return requestJson(url, 'GET');
}

export async function connectByUrl({ port = process.env.CDP_PORT || 9222, urlPattern = /xiaohongshu\.com|xhslink\.com/i, timeout = 120000 } = {}) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  let target = list.find(tab => tab.type === 'page' && urlPattern.test(tab.url || ''));
  if (!target) {
    target = list.find(tab => tab.type === 'page');
  }
  if (!target) {
    throw new CdpError('CDP_NO_TARGET', `未找到可连接的 Chromium 页面，请确认浏览器已用 --remote-debugging-port=${port} 启动`);
  }
  return connectTarget(target, timeout);
}

export async function createTab({ port = process.env.CDP_PORT || 9222, url }) {
  const target = await requestJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT');
  return connectTarget(target, 120000);
}

async function connectTarget(target, timeout) {
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
  } catch (error) {
    throw new CdpError('CDP_WS_ERROR', `无法连接调试 WebSocket：${error.message}`);
  }
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new CdpError('CDP_TIMEOUT', `CDP 命令 ${method} 超过 ${timeout}ms 未响应`));
      }
    }, timeout);
    pending.set(mid, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error ? item.reject(new CdpError('CDP_EVAL_ERROR', JSON.stringify(message.error))) : item.resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = error => reject(new CdpError('CDP_WS_ERROR', `调试 WebSocket 连接失败：${error.message || 'unknown'}`));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const evalJs = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new CdpError('CDP_EVAL_ERROR', `eval error: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
    }
    return result.result && result.result.value;
  };
  const navigate = async url => {
    await send('Page.navigate', { url });
    await new Promise(resolve => setTimeout(resolve, 3500));
  };
  return {
    send,
    evalJs,
    navigate,
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
}
