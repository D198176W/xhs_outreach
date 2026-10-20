// 会话状态机：显式定义合法状态迁移，非法迁移一律拒绝并落事件。
// 目标：会话不会因为绕过流程的操作直接跳到不可解释的状态。

export const SESSION_STATES = [
  'created',    // 已创建，尚未打开页面
  'opening',    // 正在通过 CDP 打开主页
  'opened',     // 主页已打开并读取
  'synced',     // 聊天内容已同步
  'ai_ready',   // AI 已生成建议回复
  'sent',       // 最近一条消息已发送成功
  'send_failed',// 最近一次发送失败（可重试）
  'need_human', // 登录/验证码/风控/元素缺失，需人工接管
  'paused'      // 人工暂停
];

const TRANSITIONS = {
  created:      ['opening', 'paused', 'need_human'],
  opening:      ['opened', 'synced', 'need_human', 'paused'],
  opened:       ['synced', 'ai_ready', 'need_human', 'paused', 'opening'],
  synced:       ['ai_ready', 'sent', 'send_failed', 'need_human', 'paused', 'opening', 'opened'],
  ai_ready:     ['sent', 'send_failed', 'need_human', 'paused', 'synced', 'opening'],
  sent:         ['synced', 'ai_ready', 'send_failed', 'need_human', 'paused', 'opening'],
  send_failed:  ['ai_ready', 'synced', 'sent', 'need_human', 'paused', 'opening'],
  // need_human / paused 是"挂起"状态：恢复时回到记录的 prev_status
  need_human:   ['created', 'opening', 'opened', 'synced', 'ai_ready', 'sent', 'send_failed', 'paused'],
  paused:       ['created', 'opening', 'opened', 'synced', 'ai_ready', 'sent', 'send_failed', 'need_human']
};

export class StateMachineError extends Error {
  constructor(from, to) {
    super(`非法状态迁移：${from} → ${to}`);
    this.name = 'StateMachineError';
    this.code = 'STATE_VIOLATION';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from, to) {
  if (from === to) return true; // 幂等重入（如重复 sync）允许
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new StateMachineError(from, to);
}

export function describeStates() {
  return SESSION_STATES.map(state => ({
    state,
    allowed: [...new Set([state, ...(TRANSITIONS[state] || [])])]
  }));
}
