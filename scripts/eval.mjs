// 离线评测套件：node scripts/eval.mjs
// 不依赖浏览器与真实账号：临时 SQLite 库 + mock 适配器 + mock AI 服务。
// 覆盖：状态机迁移、幂等发送、暂停守卫、AI 工具契约（超时/HTTP/输出非法）、
//       降级链路、风控检测、消息去重、trace 落库。
// 评测报告写入 logs/xhs-outreach/eval-report-latest.json，失败时退出码为 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpDb = path.join(os.tmpdir(), `outreach-eval-${Date.now()}.db`);
process.env.OUTREACH_DB = tmpDb; // 必须在导入 lib 模块前设置

const db = await import('../lib/db.mjs');
const actions = await import('../lib/actions.mjs');
const sm = await import('../lib/state-machine.mjs');
const ai = await import('../lib/ai.mjs');
const { AiError } = await import('../lib/ai.mjs');
const xhsAdapter = await import('../lib/xhs-adapter.mjs');
const linkedinAdapter = await import('../lib/linkedin-adapter.mjs');
const { ActionError } = await import('../lib/actions.mjs');

// ---------- 断言工具 ----------
const results = [];

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', duration_ms: Date.now() - start });
  } catch (error) {
    results.push({ name, status: 'FAIL', duration_ms: Date.now() - start, error: error.message });
  }
}

function assertTrue(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`断言失败（${label}）：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function expectError(fn, code, label) {
  try {
    await fn();
  } catch (error) {
    if (code) assertEq(error.code, code, `${label} 错误码`);
    return error;
  }
  throw new Error(`断言失败（${label}）：期望抛出错误但未抛出`);
}

// ---------- mock 适配器 ----------
const adapterCalls = { open: 0, read: 0, send: 0 };
const mockAdapter = {
  detectNeedHuman: xhsAdapter.detectNeedHuman,
  openAndReadProfile: async () => {
    adapterCalls.open += 1;
    return {
      ok: true, needHuman: false, displayName: '测试账号',
      chatUrl: 'https://www.xiaohongshu.com/chat?openUid=eval1', snapshot: { title: '测试账号', text: '个人主页' }
    };
  },
  readConversation: async () => {
    adapterCalls.read += 1;
    return {
      ok: true, needHuman: false, reason: 'mock read',
      chatUrl: 'https://www.xiaohongshu.com/chat?openUid=eval1',
      messages: [
        { role: 'target', content: '你好，请问有什么事？' },
        { role: 'self', content: '您好，想和您认识一下。' }
      ]
    };
  },
  sendMessage: async (url, message) => {
    adapterCalls.send += 1;
    if (message === 'TRIGGER_FAIL') {
      return { ok: false, needHuman: false, reason: 'mock send rejected', chatUrl: url };
    }
    return { ok: true, needHuman: false, reason: 'mock sent', chatUrl: url };
  }
};
actions.setAdapters({ xiaohongshu: mockAdapter, linkedin: mockAdapter });

// ---------- mock AI 服务 ----------
const aiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: '这是一条来自 mock AI 的建议回复。', reason: 'mock', risk: 'low' }));
    } else if (req.url === '/bad-output') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: '', reason: 'x', risk: 'extreme' }));
    } else if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('{}'); }, 5000);
    } else if (req.url === '/500') {
      res.writeHead(500);
      res.end('server error');
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
});
await new Promise(resolve => aiServer.listen(0, '127.0.0.1', resolve));
const aiPort = aiServer.address().port;
const aiUrl = path_ => `http://127.0.0.1:${aiPort}${path_}`;

// ---------- 评测用例 ----------

// 套件1：状态机
await test('state_machine.legal_transition', () => {
  assertTrue(sm.canTransition('created', 'opening'), 'created→opening 应合法');
  assertTrue(sm.canTransition('synced', 'ai_ready'), 'synced→ai_ready 应合法');
  assertTrue(sm.canTransition('sent', 'synced'), 'sent→synced 应合法');
  assertTrue(sm.canTransition('need_human', 'synced'), 'need_human→synced 应合法（恢复）');
  assertTrue(sm.canTransition('synced', 'synced'), '自迁移应合法（幂等重入）');
});
await test('state_machine.illegal_transition', () => {
  assertTrue(!sm.canTransition('created', 'sent'), 'created→sent 应非法（未打开未同步不能发送）');
  assertTrue(!sm.canTransition('created', 'synced'), 'created→synced 应非法');
  assertTrue(!sm.canTransition('opening', 'sent'), 'opening→sent 应非法');
});

// 套件2：主流程（mock 适配器）
let sessionId;
await test('flow.create_session', async () => {
  const item = actions.createSession('https://www.xiaohongshu.com/user/profile/eval123');
  sessionId = item.id;
  assertEq(item.status, 'created', '新会话状态');
  assertTrue(item.chat_url.includes('openUid=eval123'), 'chat_url 应已解析');
});
await test('flow.create_session_rejects_invalid_url', () => {
  return expectError(() => actions.createSession('not-a-url'), 'VALIDATION', '非法 URL');
});
await test('flow.sync_before_open_rejected', () => {
  // 未打开直接同步：状态机应拒绝 created→synced
  return expectError(() => actions.syncSession(sessionId), 'STATE_VIOLATION', '未打开先同步');
});
await test('flow.open', async () => {
  const { item, trace_id: traceId } = await actions.openSession(sessionId);
  assertEq(item.status, 'opened', '打开后状态');
  assertEq(item.display_name, '测试账号', '昵称读取');
  assertTrue(traceId.startsWith('tr_'), '应返回 trace_id');
});
await test('flow.sync', async () => {
  const { item } = await actions.syncSession(sessionId);
  assertEq(item.status, 'synced', '同步后状态');
  assertEq(item.messages.length, 2, '同步消息数');
});
await test('flow.sync_dedup', async () => {
  await actions.syncSession(sessionId);
  const item = actions.getSessionDetail(sessionId);
  assertEq(item.messages.length, 2, '重复同步不产生重复消息');
});
await test('flow.suggest_template_mode', async () => {
  delete process.env.AI_API_URL; // 模板模式
  const { item, suggestion } = await actions.suggestSession(sessionId);
  assertEq(item.status, 'ai_ready', '建议生成后状态');
  assertEq(suggestion.source, 'template', '无 AI_API_URL 时应使用模板');
  assertEq(suggestion.degraded, false, '模板模式不属于降级');
});
await test('flow.send_success', async () => {
  const { item, result } = await actions.sendSessionMessage(sessionId, '你好，很高兴认识你');
  assertEq(item.status, 'sent', '发送后状态');
  assertEq(result.ok, true, '发送结果');
  assertEq(adapterCalls.send, 1, '适配器发送调用次数');
});
await test('flow.send_failed_then_retryable', async () => {
  const { item, result } = await actions.sendSessionMessage(sessionId, 'TRIGGER_FAIL');
  assertEq(result.ok, false, 'mock 拒绝发送');
  assertEq(item.status, 'send_failed', '失败状态');
  const retry = await actions.sendSessionMessage(sessionId, '再试一次');
  assertEq(retry.item.status, 'sent', '失败后可重试');
});

// 套件3：幂等发送
let idemSessionId;
await test('idempotency.setup', async () => {
  const item = actions.createSession('https://www.xiaohongshu.com/user/profile/idem1');
  idemSessionId = item.id;
  await actions.openSession(idemSessionId);
  await actions.syncSession(idemSessionId);
});
await test('idempotency.first_send_executes', async () => {
  const { result } = await actions.sendSessionMessage(idemSessionId, '幂等测试消息', { idempotencyKey: 'k1' });
  assertEq(result.ok, true, '首次发送应执行');
});
await test('idempotency.duplicate_send_skipped', async () => {
  const before = adapterCalls.send;
  const { result } = await actions.sendSessionMessage(idemSessionId, '幂等测试消息', { idempotencyKey: 'k1' });
  assertEq(result.duplicate, true, '重复键应返回 duplicate');
  assertEq(adapterCalls.send, before, '适配器不应被再次调用');
});
await test('idempotency.pending_conflict', async () => {
  db.insert('messages', {
    session_id: idemSessionId, role: 'user', content: '进行中的消息', send_status: 'pending',
    source: 'local', idempotency_key: 'k2', sent_at: '', error_msg: '', created_at: new Date().toISOString()
  });
  return expectError(
    () => actions.sendSessionMessage(idemSessionId, '并发提交', { idempotencyKey: 'k2' }),
    'SEND_IN_PROGRESS', '同键 pending 冲突'
  );
});

// 套件4：暂停/恢复语义
await test('guard.pause_blocks_actions', async () => {
  actions.pauseSession(idemSessionId);
  assertEq(actions.getSessionDetail(idemSessionId).status, 'paused', '暂停状态');
  await expectError(() => actions.sendSessionMessage(idemSessionId, '暂停中发送'), 'SESSION_PAUSED', '暂停时发送');
  await expectError(() => actions.suggestSession(idemSessionId), 'SESSION_PAUSED', '暂停时生成建议');
});
await test('guard.resume_restores_prev_status', () => {
  actions.resumeSession(idemSessionId);
  const item = actions.getSessionDetail(idemSessionId);
  assertEq(item.status, 'sent', '恢复应回到暂停前的状态（sent）而非固定状态');
  assertEq(item.paused, 0, 'paused 标记应清除');
});

// 套件5：AI 工具契约
await test('ai_contract.valid_output', async () => {
  process.env.AI_API_URL = aiUrl('/ok');
  const suggestion = await ai.generateSuggestion({
    profile: { platform: 'xiaohongshu', display_name: '测试' },
    messages: [{ role: 'target', content: '你好' }],
    style: { name: '专业友好', identity: 'DigClaw 团队成员' }
  });
  assertEq(suggestion.source, 'ai', '来源应为 ai');
  assertEq(suggestion.risk, 'low', 'risk 校验');
});
await test('ai_contract.invalid_output_rejected', () => {
  process.env.AI_API_URL = aiUrl('/bad-output');
  return expectError(
    () => ai.generateSuggestion({ profile: { platform: 'xiaohongshu' }, messages: [], style: {} }),
    'AI_OUTPUT_INVALID', '输出契约（空 reply / 非法 risk）'
  );
});
await test('ai_contract.http_error_classified', () => {
  process.env.AI_API_URL = aiUrl('/500');
  return expectError(
    () => ai.generateSuggestion({ profile: { platform: 'xiaohongshu' }, messages: [], style: {} }),
    'AI_HTTP_ERROR', 'HTTP 500 分类'
  );
});
await test('ai_contract.timeout_classified', () => {
  process.env.AI_API_URL = aiUrl('/slow');
  return expectError(
    () => ai.generateSuggestion({ profile: { platform: 'xiaohongshu' }, messages: [], style: {} }, { timeoutMs: 300 }),
    'AI_TIMEOUT', '超时分类'
  );
});
await test('ai_contract.input_validated', () => {
  return expectError(
    () => ai.generateSuggestion({ profile: { platform: 'xiaohongshu' }, messages: 'not-array', style: {} }),
    'AI_INPUT_INVALID', '输入契约（messages 非数组）'
  );
});
await test('ai_degraded.still_produces_suggestion', async () => {
  process.env.AI_API_URL = aiUrl('/500');
  const { item, suggestion } = await actions.suggestSession(idemSessionId);
  assertEq(item.status, 'ai_ready', 'AI 失败不应中断流程');
  assertEq(suggestion.degraded, true, '应标记降级');
  assertEq(suggestion.source, 'template', '降级来源应为模板');
  const events = db.listRows('events', { session_id: idemSessionId }, { orderBy: 'id DESC', limit: 5 });
  assertTrue(events.some(row => row.type === 'AI_DEGRADED'), '应记录 AI_DEGRADED 事件');
});

// 套件6：风控检测
await test('risk_control.xhs_captcha_detected', () => {
  assertTrue(xhsAdapter.detectNeedHuman({ text: '请输入验证码完成安全验证' }), '验证码文本应触发');
  assertTrue(xhsAdapter.detectNeedHuman({ text: '检测到异常访问，请先登录' }), '风控文本应触发');
  assertTrue(!xhsAdapter.detectNeedHuman({ title: '小红薯的主页', text: '笔记 32 粉丝 1200' }), '正常主页不应误报');
});
await test('risk_control.linkedin_captcha_detected', () => {
  assertTrue(linkedinAdapter.detectNeedHuman({ text: 'Please complete the security check' }), 'LinkedIn 验证应触发');
  assertTrue(!linkedinAdapter.detectNeedHuman({ text: 'Senior Engineer at Example Corp' }), '正常主页不应误报');
});

// 套件7：trace 可观测性
await test('trace.recorded_with_spans', () => {
  const traces = db.listTraces(idemSessionId, 50);
  assertTrue(traces.length >= 3, '会话动作应有 trace 记录');
  const openTrace = traces.find(row => row.action === 'open');
  assertTrue(Boolean(openTrace), 'open 动作应有 trace');
  const spans = JSON.parse(openTrace.spans_json);
  assertTrue(spans.some(span => span.name === 'adapter.openAndReadProfile'), 'trace 应包含适配器 span');
  assertTrue(openTrace.duration_ms >= 0, 'trace 应有总耗时');
});
await test('trace.degraded_status_marked', () => {
  const traces = db.listTraces(idemSessionId, 50);
  const suggestTrace = traces.find(row => row.action === 'suggest' && row.status === 'degraded');
  assertTrue(Boolean(suggestTrace), 'AI 降级的 suggest 动作 trace 状态应为 degraded');
});

// 套件8：数据层
await test('db.roundtrip', () => {
  const style = actions.createStyle({ name: '评测风格', tone: '简洁' });
  const found = db.findRow('styles', { id: style.id });
  assertEq(found.name, '评测风格', '写入读取一致');
  db.update('styles', style.id, { tone: '专业' });
  assertEq(db.findRow('styles', { id: style.id }).tone, '专业', '更新一致');
  assertEq(db.deleteRows('styles', { id: style.id }), 1, '删除返回行数');
});
await test('db.event_has_trace_id', () => {
  const events = db.listRows('events', { session_id: idemSessionId });
  assertTrue(events.some(row => row.trace_id.startsWith('tr_')), '事件应携带 trace_id');
});

// ---------- 报告输出 ----------
delete process.env.AI_API_URL;
aiServer.close();

const passed = results.filter(row => row.status === 'PASS').length;
const failed = results.length - passed;
const report = {
  generated_at: new Date().toISOString(),
  total: results.length,
  passed,
  failed,
  suites: [...new Set(results.map(row => row.name.split('.')[0]))],
  cases: results
};

const reportDir = path.join(path.dirname(root), 'logs', 'xhs-outreach');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'eval-report-latest.json'), JSON.stringify(report, null, 2));

console.log('\n===== 离线评测报告 =====');
for (const row of results) {
  const flag = row.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`[${flag}] ${row.name} (${row.duration_ms}ms)${row.error ? ` -> ${row.error}` : ''}`);
}
console.log(`\n总计：${passed}/${results.length} 通过，${failed} 失败`);
console.log(`报告已写入 ${path.join(reportDir, 'eval-report-latest.json')}`);

// 清理临时库
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
}

process.exit(failed ? 1 : 0);
