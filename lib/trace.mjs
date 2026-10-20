// Trace 可观测性：一次会话动作（open/sync/suggest/send/...）贯通一个 trace_id，
// 记录各阶段 span（名称、耗时、状态、异常），结束后落 traces 表。
// span 状态：ok（成功）/ error（抛异常）/ info（标记点，如降级决策）。

import { randomUUID } from 'node:crypto';
import { saveTrace, nowIso } from './db.mjs';

export function createTrace({ sessionId = null, action }) {
  const traceId = `tr_${Date.now().toString(36)}_${randomUUID().toString('hex').slice(0, 8)}`;
  const startedAt = Date.now();
  const spans = [];

  const trace = {
    traceId,
    sessionId,
    action,

    // 标记点：不包裹函数，只记录决策或信息（如 AI 降级）
    mark(name, detail = {}) {
      spans.push({ name, status: 'info', at_ms: Date.now() - startedAt, ...detail });
      return trace;
    },

    // 包裹一段异步执行，自动记录耗时与结果
    async span(name, fn) {
      const start = Date.now();
      try {
        const value = await fn();
        spans.push({ name, status: 'ok', duration_ms: Date.now() - start });
        return value;
      } catch (error) {
        spans.push({
          name,
          status: 'error',
          duration_ms: Date.now() - start,
          error: String(error.message || error)
        });
        throw error;
      }
    },

    // status: ok（动作成功）/ degraded（完成但降级）/ error（动作失败）
    finish({ status = 'ok', error = '' } = {}) {
      const record = {
        trace_id: traceId,
        session_id: sessionId,
        action,
        status,
        duration_ms: Date.now() - startedAt,
        spans_json: JSON.stringify(spans),
        error: error || '',
        created_at: nowIso()
      };
      saveTrace(record);
      return record;
    }
  };

  return trace;
}
