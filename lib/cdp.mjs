import http from 'node:http';

export function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`CDP 返回的不是 JSON：${data.slice(0, 160)}`));
        }
      });
    }).on('error', reject);
  });
}

function requestJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`CDP ${method} ${url} 返回的不是 JSON：${data.slice(0, 160)}`));
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function connectByUrl({ port = process.env.CDP_PORT || 9222, urlPattern = /xiaohongshu\.com|xhslink\.com/i, timeout = 120000 } = {}) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  let target = list.find(tab => tab.type === 'page' && urlPattern.test(tab.url || ''));
  if (!target) {
    target = list.find(tab => tab.type === 'page');
  }
  if (!target) {
    throw new Error(`未找到可连接的 Chromium 页面，请确认浏览器已用 --remote-debugging-port=${port} 启动`);
  }
  return connectTarget(target, timeout);
}

export async function createTab({ port = process.env.CDP_PORT || 9222, url }) {
  const target = await requestJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT');
  return connectTarget(target, 120000);
}

async function connectTarget(target, timeout) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`timeout ${method}`));
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
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
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
      throw new Error(`eval error: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
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
