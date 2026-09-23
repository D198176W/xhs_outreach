const state = {
  sessions: [],
  current: null,
  styles: []
};

const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function statusLabel(status) {
  return {
    created: '已创建',
    opening: '打开中',
    opened: '已打开',
    synced: '已同步',
    ai_ready: 'AI 待确认',
    sent: '已发送',
    send_failed: '发送失败',
    need_human: '需人工',
    paused: '已暂停'
  }[status] || status;
}

async function loadSessions() {
  const data = await api('/api/sessions');
  state.sessions = data.items;
  if (state.current && !state.sessions.some(item => item.id === state.current.id)) {
    state.current = null;
  }
  if (!state.current && state.sessions.length) {
    const requested = Number(new URLSearchParams(location.search).get('session'));
    const selected = state.sessions.find(item => item.id === requested) || state.sessions[0];
    await selectSession(selected.id);
  }
  renderSessions();
}

async function loadStyles() {
  const data = await api('/api/styles');
  state.styles = data.items;
  renderStyles();
}

async function selectSession(id) {
  const data = await api(`/api/sessions/${id}`);
  state.current = data.item;
  render();
}

async function createSession(event) {
  event.preventDefault();
  const profileUrl = $('#profileUrl').value.trim();
  if (!profileUrl) return;
  const data = await api('/api/sessions', { method: 'POST', body: { profileUrl } });
  state.current = data.item;
  $('#profileUrl').value = '';
  await loadSessions();
  render();
}

async function runAction(action) {
  if (!state.current) return;
  setBusy(true);
  try {
    const data = await api(`/api/sessions/${state.current.id}/${action}`, { method: 'POST', body: {} });
    state.current = data.item;
    await loadSessions();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
    render();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.current) return;
  const content = $('#composer').value.trim();
  if (!content) return;
  setBusy(true);
  try {
    const data = await api(`/api/sessions/${state.current.id}/send`, { method: 'POST', body: { content } });
    state.current = data.item;
    $('#composer').value = '';
    await loadSessions();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
    render();
  }
}

async function createStyle(event) {
  event.preventDefault();
  const body = {
    name: $('#styleName').value.trim(),
    tone: $('#styleTone').value.trim(),
    identity: $('#styleIdentity').value.trim(),
    goal: $('#styleGoal').value.trim(),
    lengthRule: $('#styleLength').value.trim(),
    avoidRule: $('#styleAvoid').value.trim(),
    extraPrompt: $('#styleExtra').value.trim()
  };
  await api('/api/styles', { method: 'POST', body });
  event.target.reset();
  await loadStyles();
}

async function useStyle() {
  if (!state.current) return;
  const styleId = Number($('#styleSelect').value);
  if (!styleId) return;
  const data = await api(`/api/styles/${styleId}/use`, { method: 'POST', body: { sessionId: state.current.id } });
  state.current = data.item;
  await loadSessions();
  render();
}

async function deleteSession(id) {
  const item = state.sessions.find(session => session.id === Number(id));
  const name = item?.display_name || '这个会话';
  if (!confirm(`确定删除「${name}」的会话和本地聊天记录吗？`)) return;
  setBusy(true);
  try {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
    if (state.current && state.current.id === Number(id)) {
      state.current = null;
    }
    await loadSessions();
    render();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
}

function renderSessions() {
  $('#sessionList').innerHTML = state.sessions.map(item => `
    <button class="session-item ${state.current && state.current.id === item.id ? 'active' : ''}" data-id="${item.id}">
      <span class="session-row">
        <span class="session-title">${escapeHtml(item.display_name || `未命名${platformLabel(item.platform)}账号`)}</span>
        <span class="session-delete" data-delete-id="${item.id}" title="删除会话" aria-label="删除会话">×</span>
      </span>
      <span class="session-platform">${platformLabel(item.platform)}</span>
      <span class="session-url">${escapeHtml(item.chat_url || item.profile_url)}</span>
      <span class="pill ${item.need_human ? 'warn' : ''}">${statusLabel(item.status)}</span>
    </button>
  `).join('');
  document.querySelectorAll('.session-item').forEach(button => {
    button.addEventListener('click', () => selectSession(button.dataset.id));
  });
  document.querySelectorAll('[data-delete-id]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      deleteSession(button.dataset.deleteId);
    });
  });
}

function renderStyles() {
  const select = $('#styleSelect');
  select.innerHTML = state.styles.map(style => `<option value="${style.id}">${escapeHtml(style.name)}</option>`).join('');
}

function render() {
  renderSessions();
  renderStyles();
  if (!state.current) {
    $('#detail').innerHTML = '<div class="empty">先输入一个小红书或 LinkedIn 主页地址，创建会话。</div>';
    return;
  }
  const current = state.current;
  $('#detail').innerHTML = `
    <section class="profile-head">
      <div>
        <h2>${escapeHtml(current.display_name || '小红书账号')}</h2>
        <a href="${escapeAttr(current.chat_url || current.profile_url)}" target="_blank" rel="noreferrer">${escapeHtml(current.chat_url || current.profile_url)}</a>
      </div>
      <span class="pill ${current.need_human ? 'warn' : ''}">${statusLabel(current.status)}</span>
    </section>
    ${current.last_error ? `<p class="notice">${escapeHtml(current.last_error)}</p>` : ''}
    <section class="toolbar">
      <button data-action="open">打开主页</button>
      <button data-action="sync">同步聊天</button>
      <button data-action="suggest">生成建议</button>
      <button data-action="pause">暂停</button>
      <button data-action="resume">恢复</button>
      <button data-action="handoff">人工接管</button>
    </section>
    <section class="style-bar">
      <label>当前风格</label>
      <select id="styleSelectInline">${state.styles.map(style => `<option value="${style.id}" ${style.id === current.style_id ? 'selected' : ''}>${escapeHtml(style.name)}</option>`).join('')}</select>
      <button id="useStyleInline">应用风格</button>
    </section>
    <section class="chat">
      ${current.messages.map(message => `
        <article class="message ${message.role}">
          <div class="message-meta">${roleLabel(message.role)} · ${escapeHtml(message.send_status)} · ${formatTime(message.created_at)}</div>
          <p>${escapeHtml(message.content)}</p>
          ${message.error_msg ? `<small>${escapeHtml(message.error_msg)}</small>` : ''}
        </article>
      `).join('') || '<div class="empty">暂无聊天内容，先同步聊天或生成建议。</div>'}
    </section>
    <form id="sendForm" class="composer">
      <textarea id="composer" placeholder="编辑要发送的小红书私信。可以粘贴 AI 建议，也可以自己改写。">${escapeHtml(latestSuggestion(current) || '')}</textarea>
      <button type="submit">发送</button>
    </form>
    <section class="events">
      <h3>事件</h3>
      ${current.events.map(event => `<p><strong>${escapeHtml(event.type)}</strong> ${escapeHtml(event.summary)} <span>${formatTime(event.created_at)}</span></p>`).join('')}
    </section>
  `;
  document.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => runAction(button.dataset.action));
  });
  $('#sendForm').addEventListener('submit', sendMessage);
  $('#useStyleInline').addEventListener('click', async () => {
    $('#styleSelect').value = $('#styleSelectInline').value;
    await useStyle();
  });
}

function latestSuggestion(session) {
  const suggestion = [...session.messages].reverse().find(message => message.role === 'ai_suggestion');
  return suggestion ? suggestion.content : '';
}

function roleLabel(role) {
  return {
    target: '对方',
    user: '我方',
    self: '我方',
    ai_suggestion: 'AI 建议',
    system: '系统'
  }[role] || role;
}

function platformLabel(platform) {
  return {
    xiaohongshu: '小红书',
    linkedin: 'LinkedIn'
  }[platform] || platform || '未知平台';
}

function formatTime(value) {
  return value ? value.replace('T', ' ').slice(0, 16) : '';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#createSession').addEventListener('submit', createSession);
  $('#styleForm').addEventListener('submit', createStyle);
  $('#applyStyle').addEventListener('click', useStyle);
  await loadStyles();
  await loadSessions();
  render();
});
