/**
 * dsh-llm-auto —— 路由内重试策略。
 *
 * ## 为什么重试要在本插件里实现,而策略形状却照抄官方
 *
 * DSH 自带的 `@deepseek-ai/dsh-llm-retry` 挂在 agent loop 的
 * `agent/request-error` 瀑布上,只在**步骤级**失败后整步重跑,且其 README 明确
 * 不覆盖直接的 `ctx.llm.stream()` 调用 —— 而本插件对每条候选路由发起的正是
 * 嵌套 `ctx.llm.stream()`(失败以终止分片的形式消失在流内部,瀑布根本看不见)。
 * 所以"某条路由失败后原地重试"只能在本插件内实现,没有官方 API 可调。
 *
 * 但策略的**形状、默认值、校验口径**没有重复造轮子的理由:直接复用
 * `@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy`(dsh-llm-retry 本身用的就是它),
 * 于是"选 auto"与"选普通模型"拿到的是同一套重试语义。
 *
 * 未配置 `retry` 块时的默认值 = 官方默认:
 *  - normal 模式,`maxRetries: 5`(失败后最多再重试 5 次,每路由共 6 次尝试);
 *  - 可重试码 = `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`
 *    (瞬时类白名单;永久错误如 NO_ADAPTER / UNKNOWN_MODEL / MISSING_CREDENTIAL
 *    不在其中,一次败就直接切下一条,不白烧 N 次请求);
 *  - 退避 500ms 起步、10s 封顶的指数退避,±10% 对称 jitter。
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/** 未配置 `retry` 块时使用的策略(= 官方默认值,冻结对象,可安全共享)。 */
export const DEFAULT_RETRY_POLICY = resolveRetryPolicy(undefined, 'dsh-llm-auto: retry')

/** 关闭重试的策略(`maxRetries: 0` ⇒ 每路由只尝试一次,即本插件旧行为)。 */
export const NO_RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'dsh-llm-auto: retry')

/**
 * 解析并校验 `config.retry`。
 *
 * 语义(与 README「配置」一节逐条对应):
 *  - 缺省(`undefined` / `null`)/ `true` ⇒ 官方默认策略(重试开启);
 *  - `false` ⇒ `NO_RETRY_POLICY`(每路由只尝试一次);
 *  - 对象 ⇒ 形状与官方 `retryPolicy` 相同,但只支持 `mode: 'normal'`
 *    (`always` = 无上限重试,单请求可能无上限计费,本插件不予支持);
 *  - 任何坏值都不抛错:打一条 warn 后回落官方默认(遵循本插件既有约定 ——
 *    插件配置错误不该让宿主起不来)。
 *
 * @param raw - `config.retry` 原始值。
 * @param path - 诊断用路径前缀。
 * @returns `{ policy, warnings }`;`policy` 为解析后的冻结策略。
 */
export function normalizeRetry(raw, path = 'dsh-llm-auto: retry') {
  if (raw === undefined || raw === null) return { policy: DEFAULT_RETRY_POLICY, warnings: [] }
  if (typeof raw === 'boolean') return { policy: raw ? DEFAULT_RETRY_POLICY : NO_RETRY_POLICY, warnings: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      policy: DEFAULT_RETRY_POLICY,
      warnings: [`${path}: retry 应为对象(与官方 retryPolicy 同形状:maxRetries/retryableCodes/backoff),实际是 ${typeof raw} —— 按官方默认值启用`],
    }
  }
  if (raw.mode !== undefined && raw.mode !== 'normal') {
    return {
      policy: DEFAULT_RETRY_POLICY,
      warnings: [`${path}: mode 只支持 "normal"(always = 无限重试,单请求可能无上限计费,不予支持) —— 按官方默认值启用`],
    }
  }
  try {
    return { policy: resolveRetryPolicy({ mode: 'normal', ...raw }, path), warnings: [] }
  } catch (error) {
    return {
      policy: DEFAULT_RETRY_POLICY,
      warnings: [`${path}: 配置无效(${error.message}) —— 按官方默认值启用`],
    }
  }
}

/**
 * 官方同款退避:指数增长 + 对称 jitter,封顶 `maxDelayMs`。
 *
 * 与 `dsh-llm-retry` 的 `localDelay` 逐行同口径(复制而非导入:官方该函数未导出,
 * 且只有四行;策略本身已通过 {@link normalizeRetry} 复用)。
 *
 * @param policy - 已解析的 normal 策略。
 * @param retry - 第几次重试(1 起;第一次重试用 `initialDelayMs`)。
 * @param random - 随机源(测试可注入,默认 `Math.random`)。
 * @returns 等待毫秒数。
 */
export function computeRetryDelay(policy, retry, random = Math.random) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/**
 * 把策略渲染成一行可读描述(挂载日志与 `/api/llm-auto/routes` 共用)。
 * @param policy - 已解析的策略。
 * @returns 形如 `重试: 每路由最多 5 次(瞬时码 RATE_LIMIT/SERVER/…),退避 500→10000ms jitter 0.1`。
 */
export function describeRetryPolicy(policy) {
  if (policy.maxRetries <= 0) return '重试: 关闭(每路由只尝试一次,失败即切下一条)'
  const codes = [...policy.retryableCodes].join('/')
  return `重试: 每路由最多 ${policy.maxRetries} 次(瞬时码 ${codes}),退避 ${policy.initialDelayMs}→${policy.maxDelayMs}ms jitter ${policy.jitterRatio}`
}
