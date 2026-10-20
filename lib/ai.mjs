// AI 建议生成 —— 按工具契约实现：
// 输入契约：profile/messages/style 字段类型与长度上限；
// 输出契约：{ reply: 非空字符串, reason: 字符串, risk: low|medium|high }；
// 错误分类：AI_INPUT_INVALID / AI_TIMEOUT / AI_HTTP_ERROR / AI_OUTPUT_INVALID；
// 未配置 AI_API_URL 时走本地模板（source: 'template'，非降级，是设计内兜底）。
// 外部模型失败由调用方决定降级策略（见 actions.mjs），本模块不吞错误。

export const AI_ERROR_CODES = ['AI_INPUT_INVALID', 'AI_TIMEOUT', 'AI_HTTP_ERROR', 'AI_OUTPUT_INVALID'];
export const RISK_LEVELS = ['low', 'medium', 'high'];

const CONTEXT_MESSAGES = 12;      // 注入上下文的最近消息条数（上下文预算）
const MAX_FIELD_LENGTH = 500;     // 风格字段长度上限
const MAX_REPLY_LENGTH = 2000;    // 模型回复长度上限
const DEFAULT_TIMEOUT_MS = 15000;

export class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = AI_ERROR_CODES.includes(code) ? code : 'AI_INPUT_INVALID';
  }
}

function asString(value, field, { maxLength = MAX_FIELD_LENGTH, allowEmpty = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    throw new AiError('AI_INPUT_INVALID', `字段 ${field} 必须是字符串`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new AiError('AI_INPUT_INVALID', `字段 ${field} 不能为空`);
  }
  if (value.length > maxLength) {
    throw new AiError('AI_INPUT_INVALID', `字段 ${field} 超过长度上限 ${maxLength}`);
  }
  return value;
}

export function validateSuggestionInput({ profile, messages, style }) {
  if (!profile || typeof profile !== 'object') {
    throw new AiError('AI_INPUT_INVALID', 'profile 必须是对象');
  }
  asString(profile.platform, 'profile.platform');
  if (!Array.isArray(messages)) {
    throw new AiError('AI_INPUT_INVALID', 'messages 必须是数组');
  }
  for (const message of messages) {
    asString(message.role, 'message.role', { maxLength: 40 });
    asString(message.content, 'message.content', { maxLength: 5000 });
  }
  const styleInput = style && typeof style === 'object' ? style : {};
  return {
    platform: profile.platform === 'linkedin' ? 'linkedin' : 'xiaohongshu',
    style: {
      name: asString(styleInput.name, 'style.name'),
      tone: asString(styleInput.tone, 'style.tone'),
      identity: asString(styleInput.identity, 'style.identity'),
      goal: asString(styleInput.goal, 'style.goal'),
      length_rule: asString(styleInput.length_rule, 'style.length_rule'),
      avoid_rule: asString(styleInput.avoid_rule, 'style.avoid_rule'),
      extra_prompt: asString(styleInput.extra_prompt, 'style.extra_prompt')
    }
  };
}

function validateSuggestionOutput(data) {
  if (!data || typeof data !== 'object') {
    throw new AiError('AI_OUTPUT_INVALID', 'AI 返回的不是 JSON 对象');
  }
  const reply = data.reply ?? data.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new AiError('AI_OUTPUT_INVALID', 'AI 返回的 reply 为空或不是字符串');
  }
  if (reply.length > MAX_REPLY_LENGTH) {
    throw new AiError('AI_OUTPUT_INVALID', `AI 返回的 reply 超过长度上限 ${MAX_REPLY_LENGTH}`);
  }
  const risk = data.risk === undefined || data.risk === null ? 'low' : data.risk;
  if (!RISK_LEVELS.includes(risk)) {
    throw new AiError('AI_OUTPUT_INVALID', `AI 返回的 risk 必须是 ${RISK_LEVELS.join('|')}，实际为 ${JSON.stringify(risk)}`);
  }
  return {
    reply: reply.trim(),
    reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : '由外部 AI 接口生成',
    risk
  };
}

export async function generateSuggestion({ profile, messages = [], style = {} } = {}, { timeoutMs } = {}) {
  const input = validateSuggestionInput({ profile, messages, style });
  const platformText = input.platform === 'linkedin' ? 'LinkedIn' : '小红书';
  const context = messages
    .slice(-CONTEXT_MESSAGES)
    .map(message => `${message.role}: ${message.content}`)
    .join('\n');

  if (!process.env.AI_API_URL) {
    return templateSuggestion({ profile, messages, style });
  }

  const controller = new AbortController();
  const limit = Number(timeoutMs || process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(process.env.AI_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.AI_API_KEY ? { authorization: `Bearer ${process.env.AI_API_KEY}` } : {})
      },
      signal: controller.signal,
      body: JSON.stringify({
        platform: input.platform,
        profile,
        style: input.style,
        messages: messages.slice(-CONTEXT_MESSAGES),
        instruction: `生成一条可发送给${platformText}用户的建联回复，返回 JSON：{"reply":"","reason":"","risk":"low|medium|high"}`
      })
    });
    if (!response.ok) {
      throw new AiError('AI_HTTP_ERROR', `AI 接口返回 HTTP ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AiError('AI_OUTPUT_INVALID', 'AI 接口返回的不是合法 JSON');
    }
    const output = validateSuggestionOutput(data);
    return { ...output, source: 'ai', degraded: false };
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error.name === 'AbortError') {
      throw new AiError('AI_TIMEOUT', `AI 接口 ${limit}ms 内未响应`);
    }
    throw new AiError('AI_HTTP_ERROR', `AI 接口请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 本地模板兜底：无外部模型时也能生成可编辑的建议文案
export function templateSuggestion({ profile, messages = [], style = {} }) {
  const platform = profile.platform === 'linkedin' ? 'linkedin' : 'xiaohongshu';
  const platformText = platform === 'linkedin' ? 'LinkedIn' : '小红书';
  const identity = style.identity || 'DigClaw 团队成员';
  const hasHistory = messages.some(message => (message.content || '').trim());
  const name = profile.display_name || '';
  const greeting = name ? `${name}，您好。` : '您好。';
  const reply = hasHistory
    ? `${greeting}谢谢回复。我是${identity}，主要想基于您公开主页里的经历做一次简短交流。如果方便，我想了解下您近期关注的方向，看看是否有合适的合作或沟通机会。`
    : `${greeting}我是${identity}，看到您的${platformText}主页后对您的经历挺感兴趣，想简单认识一下，看看后续是否有合作或交流的可能。方便的话可以聊两句。`;
  return {
    reply,
    reason: '未配置 AI_API_URL，使用本地风格模板生成',
    risk: 'low',
    source: 'template',
    degraded: false
  };
}
