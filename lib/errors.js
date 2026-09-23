/**
 * dsh-llm-auto —— 失败分类与聚合错误。
 *
 * ## 判定「可回退」的口径(实测 + 源码双向确认后定稿)
 *
 * 真机观测(dsh 0.1.6-alpha.2,嵌套 `ctx.llm.stream`):
 *  - 不存在的 provider ⇒ 终止分片 `finish{kind:'error', failure:{code:'NO_ADAPTER'}}`;
 *  - 存在 provider + 错误 model id ⇒ `UNKNOWN_MODEL`;
 *  - 缺凭据 ⇒ `MISSING_CREDENTIAL`;
 *  - 上游 5xx ⇒ `SERVER`(且**已先发过一个全零 usage 分片**再报错)。
 *
 * 由此得出两条硬约束:
 *  1. 失败**不是抛异常**来到调用方的,而是终止分片里的 `failure.code`;
 *  2. 上游错误码空间是开放的(各 SDK 会带来自定义码),所以**白名单式**判定会把
 *     `SERVER` 这类真实错误漏成"不回退"。
 *
 * 因此本插件采用「黑名单 + 默认回退」:只要**还没向调用方交出任何内容**,
 * 除少数明确不该换路由的错误码外一律回退。最坏后果只是多发一条上游请求,
 * 而"半截回答 + 重新回答"由适配器的 committed 判定从结构上排除。
 *
 * ## 可回退码 ≠ 可重试码
 *
 * "换下一条路由"是黑名单式(错误码空间开放,白名单会漏),但"原地重试"是**白名单式**
 * —— 重试比切换贵(同一路由重复计费),永久错误(NO_ADAPTER / UNKNOWN_MODEL /
 * MISSING_CREDENTIAL 等)不值得白撞 N 次。可重试码不在本模块,而是随重试策略
 * (见 `retry.js`,默认值复用官方 `resolveRetryPolicy`)走,默认集合为
 * `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`。
 */

/** 本插件在全部路由耗尽时抛出的错误码(稳定、可路由)。 */
export const EXHAUSTED_CODE = 'AUTO_ROUTES_EXHAUSTED'

/**
 * 绝不回退的错误码。
 *
 * - `ABORTED` —— 调用方主动取消,换路由违背意图;
 * - `CONTEXT_WINDOW_EXCEEDED` —— 请求本身超窗,换一条只会再撞一次(且应交给压缩链路处理);
 * - `IMAGE_OFFLOAD_REQUIRED` —— 官方约定:按 `offloadImages` 卸图后重试**同一条**路由。
 */
export const NEVER_FALLBACK_CODES = new Set([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
])

/**
 * 常见的「上游不可用」错误码,仅用于日志分级与 README 说明(判定逻辑不依赖它)。
 * 取值来源:`@deepseek-ai/dsh-llm` 的 error.js / types,以及 pi-ai、llm-deepseek、
 * 真机观测到的 SDK 码。
 */
export const KNOWN_UNAVAILABLE_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'NO_CREDENTIAL_STORE',
  'TIMEOUT',
  'SERVER',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'EMPTY_RESPONSE',
  'STREAM_CLOSED',
  'DISCOVERY_FAILED',
  'DISCOVERY_UNSUPPORTED',
  'NETWORK',
  'CONNECT_FAILED',
  'OVERLOADED',
  'UNAVAILABLE',
  'BAD_GATEWAY',
  'UNKNOWN',
])

/**
 * 这条失败是否允许「换下一条路由」。
 *
 * 注意:调用方还必须额外满足「尚未交出任何内容」—— 那条约束由适配器负责,
 * 这里只看错误码本身。
 * @param code - 终止分片 `reason.failure.code`(可能是 undefined)。
 * @returns 允许回退时为 true。
 */
export function isFallbackCode(code) {
  if (typeof code !== 'string' || code.length === 0) return true // 拿不到码:宁可多试一条
  return !NEVER_FALLBACK_CODES.has(code)
}

/**
 * 把一次失败压成一行摘要(写日志与聚合消息共用),并做长度截断。
 * @param failure - `{ code, message, status? }` 或 undefined。
 * @param maxChars - 单行上限。
 * @returns 形如 `SERVER(502): OpenAI API error (502): 502 status code`。
 */
export function summarizeFailure(failure, maxChars = 200) {
  if (failure === null || failure === undefined) return '未知失败'
  const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  const status = Number.isInteger(failure.status) ? `(${failure.status})` : ''
  const raw = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : '(无消息)'
  const message = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw
  return `${code}${status}: ${message}`
}

/** 从任意抛出物里取出可序列化的失败事实。 */
export function failureFromThrown(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UNKNOWN'
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return { code, message }
}

/**
 * 构造「全部路由都失败」的聚合错误。
 *
 * 返回 `LlmError`(而不是裸 AggregateError):`LlmRuntime` 的最终边界
 * (`adapterFailureChunk` → `normalizeLlmFailure`)只信任 `instanceof HarnessError`
 * 的错误码,裸 AggregateError 会把码降级成 `UNKNOWN`。用 `LlmError` 既能保留
 * 可路由的码,又能通过 `cause` 挂上逐条的原始失败。
 *
 * @param attempts - 逐条路由的最终失败记录 `[{ index, try, provider, model, code, message, status?, elapsedMs }]`;
 *   `try` 为该路由的总尝试次数(1 = 没重试过);每条路由只应有一条(重试记录不进聚合)。
 * @param LlmErrorClass - `@deepseek-ai/dsh-llm` 的 `LlmError`(由调用方注入,便于单测替换)。
 * @returns 可直接 throw 的 LlmError。
 */
export function buildExhaustedError(attempts, LlmErrorClass) {
  const lines = attempts.map((a) => {
    const status = Number.isInteger(a.status) ? `(HTTP ${a.status})` : ''
    const raw = typeof a.message === 'string' && a.message.length > 0 ? a.message : '(上游未给出原因)'
    const message = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
    const tries = Number.isInteger(a.try) && a.try > 1 ? `，共 ${a.try} 次尝试` : ''
    return `  ${a.index}) ${a.provider}/${a.model} → ${a.code}${status}: ${message}（${a.elapsedMs} ms${tries}）`
  })
  const message = [`auto: 全部 ${attempts.length} 条路由均失败`, ...lines].join('\n')
  const causes = attempts.map((a) => Object.assign(new Error(`${a.provider}/${a.model}: ${a.message}`), { code: a.code }))
  return new LlmErrorClass(message, EXHAUSTED_CODE, { cause: new AggregateError(causes, `auto: ${attempts.length} 条路由全部失败`) })
}
