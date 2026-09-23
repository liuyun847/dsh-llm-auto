/**
 * dsh-llm-auto —— `auto` 路由的 LlmAdapter 实现。
 *
 * ## 它在上层看起来是什么
 * provider `auto` 下唯一一条模型 `auto`:`resolveModel()` 回显 `provider/id` 并给一个
 * 上下文窗口(默认取**第一条可解析路由**的窗口,取不到用保守值),`listModels()` 给出
 * 目录里那一条。这样模型选择器里就多出一个 `Auto` 分组。
 *
 * ## 它是怎么把请求转给下一条的
 * 对每条候选路由发起一次**嵌套调用** `ctx.llm.stream({ ...options, provider, model })`,
 * 并把分片按下面的纪律转交出去。
 *
 * ## 四条来自真机/源码的硬约束(改代码前先读)
 *
 * 1. **失败不是抛出来的,是终止分片**。`LlmRuntime.adapterStream` 把适配器的一切异常
 *    归一成 `finish{ kind:'error'|'aborted', failure:{ code, message, status? } }`。
 *    所以判定失败必须看终止分片,不能只 try/catch。
 *
 * 2. **回退/重试只能发生在"一个分片都还没交出去"时**。`@deepseek-ai/dsh-llm/lib/invariant.js`
 *    给每一次 `llm/stream`(含嵌套调用与本人)套了一层语法校验器,它会拒绝:
 *    `block-start` 重复 index、同一个流里 `usage` 出现两次。
 *    如果我把 A 的 `block-start` 交出去再改放 B 的 `block-start`,外层校验器立刻报错。
 *    ⇒ 因此 `block-start` 与 `usage` 会被**暂存**,直到第一条真正的"内容分片"到达才一起放行;
 *    一旦放行(`committed = true`)就再也不回退、不重试。
 *    真机还观测到上游会**先发一个全零 usage 再报错**(ww/gpt-6-astra 502),
 *    暂存 usage 正好让这种情形仍能重试/回退。
 *
 * 3. **不许出现"半截回答 + 重新回答"**。`committed` 之后的上游失败原样上报,不换路由。
 *
 * 4. **瞬时失败先原地重试,重试耗尽才切下一条**。默认策略复用官方 `resolveRetryPolicy`
 *    (normal,5 次重试,白名单 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT,
 *    500ms→10s 指数退避 + 10% jitter);上游 `Retry-After` 在退避上限内优先,超过上限
 *    则不等了直接切(与官方 normal 模式一致)。白名单外的错误码(永久错误)不重试。
 *
 * @module dsh-llm-auto/adapter
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { AUTO_GROUP_NAME, AUTO_MODEL, DEFAULT_CONTEXT_WINDOW, describeChain, describeRoute } from './routes.js'
import { computeRetryDelay, DEFAULT_RETRY_POLICY } from './retry.js'
import { buildExhaustedError, failureFromThrown, isFallbackCode, summarizeFailure } from './errors.js'

/** 首选路由窗口的缓存时长(毫秒)。目录会被反复重建,不该每次都去问一遍上游适配器。 */
const CONTEXT_WINDOW_TTL_MS = 30_000

/**
 * 默认的可取消等待:setTimeout + AbortSignal,取消时提前解决 false。
 *
 * 测试通过 deps.sleep 注入替身(见 {@link AutoAdapter}),避免真等 15.5s。
 * @param delayMs - 等待时长(毫秒)。
 * @param signal - 调用方 AbortSignal(可为 undefined)。
 * @returns 正常到时 `true`;等待前已取消或等待中被取消 `false`。
 */
function sleepUntil(delayMs, signal) {
  if (signal?.aborted === true) return Promise.resolve(false)
  if (delayMs <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 这个分片算不算"已经把内容交给调用方了"。
 *
 * - `block-start` / `usage` 是**协议性**分片,不带内容 ⇒ 暂存,不提交;
 * - `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` 带内容 ⇒ 提交;
 * - 未知类型按"已提交"处理(保守:宁可少回退一次,也不冒拼接风险)。
 * @param chunk - 一个 StreamChunk。
 * @returns 提交(committed)时 true。
 */
export function isCommitChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return true
  return chunk.type !== 'block-start' && chunk.type !== 'usage'
}

/** 把终止分片里的 failure 归一成 `{ code, message, status?, providerRetryAfterMs? }`。 */
function normalizeFailure(failure) {
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  const message = typeof failure?.message === 'string' && failure.message.length > 0 ? failure.message : '(上游未给出原因)'
  const status = Number.isInteger(failure?.status) ? { status: failure.status } : {}
  // 上游" Retry-After(毫秒)":可重试时优先于本地退避(见 stream() 的 canRetry 判定)。
  const retryAfter = Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
    ? { providerRetryAfterMs: failure.providerRetryAfterMs }
    : {}
  return { code, message, ...status, ...retryAfter }
}

/**
 * 按「该路由可用的最高强度」定档:取 `reasoning.efforts` 的**最后一项**(强度序固定,
 * 见 #nestedOptions 的说明)。
 *
 * 解析不出模型信息、或该路由不声明任何档位(含 `reasoning` 整体缺失)时,原样透传 ——
 * 让真正的分发去给出准确错误(`UNSUPPORTED_REASONING_EFFORT` / 不接受档位的适配器会忽略)。
 * 解析过程中抛错同样原样透传,不因为探测失败改变请求语义。
 * @param options - 已换成候选 provider/model 的请求。
 * @param route - 本次候选路由(仅用于日志)。
 * @param llm - `ctx.llm`。
 * @returns 定档后的请求。
 */
async function pickRouteEffort(options, route, llm) {
  let efforts
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, options.signal)
    efforts = info?.reasoning?.efforts ?? []
  } catch {
    return options
  }
  const strongest = efforts[efforts.length - 1]?.id
  if (typeof strongest !== 'string' || strongest.length === 0) return options
  return { ...options, reasoningEffort: strongest }
}

/**
 * 首选路由的上下文窗口解析器(带 TTL 缓存)。
 *
 * 逐个试路由直到有一条能给出正整数窗口;全都给不出就用保守值,且**不缓存**这个失败结果
 * (路由可能是异步注册的,下次还有机会)。
 * @param llm - `ctx.llm`。
 * @param routes - 有序路由链。
 * @returns `async (signal) => number`。
 */
export function createContextWindowResolver(llm, routes) {
  let cache
  return async (signal) => {
    const now = Date.now()
    if (cache !== undefined && now - cache.at < CONTEXT_WINDOW_TTL_MS) return cache.value
    for (const route of routes) {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model, signal)
        const window = info?.context?.contextWindow
        if (Number.isInteger(window) && window > 0) {
          cache = { value: window, at: now }
          return window
        }
      } catch {
        // 该路由当前不可解析(未注册/未配置):换下一条继续找
      }
    }
    return DEFAULT_CONTEXT_WINDOW
  }
}

/** `auto` 路由的适配器。 */
export class AutoAdapter extends LlmAdapter {
  /** @type {{ llm: object, routes: Array<{provider: string, model: string}>, modelName: string, retryPolicy?: object, resolveContextWindow: (signal?: AbortSignal) => Promise<number>, ring?: object, logger?: object, sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>, random?: () => number }} */
  #deps
  #chainLabel

  /**
   * @param deps - 依赖集合(全部由 lib/index.js 注入,便于单测替换)。
   * @param deps.llm - `ctx.llm`(嵌套调用入口)。
   * @param deps.routes - 已规范化的有序路由链。
   * @param deps.modelName - 模型显示名(config.name)。
   * @param deps.retryPolicy - 路由内重试策略(缺省 = 官方默认,见 lib/retry.js)。
   * @param deps.resolveContextWindow - 窗口解析器。
   * @param deps.ring - 路由日志环形缓冲。
   * @param deps.logger - 插件 logger。
   * @param deps.sleep - 退避等待替身(缺省 = 可取消的 setTimeout;测试注入以跳过真实等待)。
   * @param deps.random - jitter 随机源(缺省 `Math.random`;测试注入以固定延迟)。
   */
  constructor(deps) {
    super()
    this.#deps = deps
    this.#chainLabel = describeChain(deps.routes)
  }

  /** 分组显示名固定为 `Auto`;模型显示名是 config.name。 */
  providerInfo(provider) {
    return { id: provider, name: AUTO_GROUP_NAME }
  }

  /**
   * 目录里就一条模型。
   * 有意**不声明 `inputModalities`**:声明了就会让运行时按声明去投影请求(例如把图片替换成
   * 占位文本),而"能不能收图"应该由真正被选中的那条路由决定。留空 = 未知 = 原样透传。
   */
  async listModels(provider) {
    return [{
      provider,
      id: AUTO_MODEL,
      name: this.#deps.modelName,
      description: `自动路由：${this.#chainLabel}`,
    }]
  }

  /** 回显 provider/id,并给出上下文窗口。 */
  async resolveModel(provider, model, signal) {
    const contextWindow = await this.#deps.resolveContextWindow(signal)
    return {
      provider,
      id: model,
      name: this.#deps.modelName,
      description: `自动路由：${this.#chainLabel}`,
      context: { contextWindow },
    }
  }

  /**
   * 嵌套调用前把 provider/model 换成候选路由,并按路由改成它**可用的最高推理强度**。
   *
   * 档位规则(2026-09-23 用户指定):一律用该路由声明里**最后一个**档位 —— DSH 的档位表是
   * 固定强度序 `off→minimal→low→medium→high→xhigh→max`,适配器只保留该模型声明支持的档位,
   * 所以"最后一个"就是这家能给的最高强度。没声明任何档位时原样透传(让分发给出准确错误)。
   * 为什么不能原样透传调用方的档位:`resolveCallWithInfo` 对不支持的档位是**直接抛**
   * `UNSUPPORTED_REASONING_EFFORT`,一条本来可用的路由会因为"档位不匹配"白失败一次。
   * @param options - 调用方的完整请求。
   * @param route - 本次候选路由。
   * @returns 交给 `ctx.llm.stream` 的请求。
   */
  async #nestedOptions(options, route) {
    return pickRouteEffort({ ...options, provider: route.provider, model: route.model }, route, this.#deps.llm)
  }

  /**
   * 路由主循环。分片**原样透传**,只有"换路由"与"路由内重试"被插在中间。
   *
   * 结构:外层遍历路由链,内层是该路由的尝试预算(`retryPolicy.maxRetries + 1` 次)。
   * 四种"到此为止"的退出(调用方取消 / nested aborted / 已 committed / 码不可回退)
   * 一律不重试也不换路由,与旧版语义一致。
   * @param options - 完整请求;`options.provider` 恒为 `auto`。
   * @returns 分片流。
   */
  async *stream(options) {
    const { llm, routes, ring, logger } = this.#deps
    const policy = this.#deps.retryPolicy ?? DEFAULT_RETRY_POLICY
    const sleep = this.#deps.sleep ?? sleepUntil
    const random = this.#deps.random ?? Math.random
    const attempts = []

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]
      const attemptNo = index + 1

      for (let retries = 0; ; retries += 1) {
        const tryNo = retries + 1
        const startedAt = Date.now()
        /** 暂存的协议性分片(block-start / usage):一旦提交就随第一条内容分片放行。 */
        const held = []
        let committed = false
        /** @type {object|undefined} 上游的终止分片。 */
        let finishChunk
        /** @type {unknown} 嵌套调用自身抛出的异常。 */
        let thrown

        try {
          for await (const chunk of llm.stream(await this.#nestedOptions(options, route))) {
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
              finishChunk = chunk
              break
            }
            if (isCommitChunk(chunk)) {
              for (const item of held) yield item
              held.length = 0
              committed = true
              yield chunk
            } else {
              held.push(chunk)
            }
          }
        } catch (error) {
          thrown = error
        }
        const elapsedMs = Date.now() - startedAt
        const kind = finishChunk?.reason?.kind

        // ── 调用方取消:如实结束,绝不重试/换路由(换一条也会立刻被同一个 signal 掐掉) ──
        if (options.signal?.aborted === true) {
          for (const item of held) yield item
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure: { code: 'ABORTED', message: '调用方取消' }, switched: false })
          yield finishChunk ?? { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: thrown === undefined ? '调用方取消' : failureFromThrown(thrown).message } } }
          return
        }
        // ── 嵌套调用被判为 aborted(不是我方取消):同样不重试不回退 ──
        if (kind === 'aborted') {
          for (const item of held) yield item
          yield finishChunk
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure: normalizeFailure(finishChunk.reason?.failure), switched: false })
          return
        }

        // ── 判定这次尝试的结果 ──
        let failure
        if (thrown !== undefined) failure = failureFromThrown(thrown)
        else if (kind === 'error') failure = normalizeFailure(finishChunk?.reason?.failure)
        else if (finishChunk === undefined) failure = { code: 'STREAM_CLOSED', message: '嵌套流结束却没有终止分片' }
        else if (!committed) failure = { code: 'EMPTY_RESPONSE', message: '上游正常结束但没有产出任何内容' }

        if (failure === undefined) {
          // 成功:放行暂存分片(通常是 usage),终止分片原样透传
          for (const item of held) yield item
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: true, switched: false })
          yield finishChunk
          return
        }

        // ── 已产出内容:不重试也不回退,如实上报(硬要求) ──
        if (committed) {
          logger?.warn(`auto: ${describeRoute(route)} 已产出内容后失败(${summarizeFailure(failure)}),按约定不回退,如实上报`)
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure, switched: false })
          for (const item of held) yield item
          if (finishChunk !== undefined) {
            yield finishChunk
            return
          }
          throw thrown ?? new LlmError(failure.message, failure.code)
        }

        // ── 该错误码不可回退:不重试不回退,原样上报(保住 ABORTED / CONTEXT_WINDOW_EXCEEDED 等语义) ──
        if (!isFallbackCode(failure.code)) {
          logger?.warn(`auto: ${describeRoute(route)} 失败(${summarizeFailure(failure)}),该错误码不允许回退,直接上报`)
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure, switched: false })
          for (const item of held) yield item
          if (finishChunk !== undefined) {
            yield finishChunk
            return
          }
          throw thrown ?? new LlmError(failure.message, failure.code)
        }

        // ── 路由内重试:错误码在瞬时白名单、还有预算、且上游 Retry-After 没超过退避上限 ──
        // Retry-After 超过 maxDelayMs 时与官方 normal 模式一样不重试:一条"等 120s"的指令
        // 等满了大概率还是限流,不如直接换一条健康的路。
        const retryAfter = failure.providerRetryAfterMs
        const canRetry = retries < policy.maxRetries
          && policy.retryableCodes.includes(failure.code)
          && (retryAfter === undefined || retryAfter <= policy.maxDelayMs)
        if (canRetry) {
          const delayMs = retryAfter ?? computeRetryDelay(policy, tryNo, random)
          // 先记录再等待(官方 "durable before wait" 的本地口径):ring 里能看到每次重试决策。
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure, willRetry: true })
          logger?.warn(`auto: 第 ${attemptNo} 条路由 ${describeRoute(route)} 第 ${tryNo} 次尝试失败(${summarizeFailure(failure)}),${delayMs} ms 后重试(剩余重试 ${policy.maxRetries - retries - 1} 次)`)
          const waited = await sleep(delayMs, options.signal)
          if (!waited) {
            // 退避期间被取消:如实收尾,不再打上游。
            // 报 aborted 而不是那条上游错误 —— 这次失败本来就要被重试,是取消把它变成了终态。
            const aborted = { code: 'ABORTED', message: '退避期间调用方取消' }
            this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs: Date.now() - startedAt, ok: false, failure: aborted, switched: false })
            yield { type: 'finish', reason: { kind: 'aborted', failure: aborted } }
            return
          }
          continue
        }

        // ── 该路由告吹(重试耗尽 / 码不可重试 / Retry-After 超界) ──
        if (index < routes.length - 1) {
          const nextRoute = routes[index + 1]
          const why = retries > 0 ? `,共尝试 ${tryNo} 次` : ''
          logger?.warn(`auto: 第 ${attemptNo} 条路由 ${describeRoute(route)} 失败(${summarizeFailure(failure)}${why}),静默切换 → ${describeRoute(nextRoute)}`)
          this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure, switched: true })
          break
        }

        // ── 最后一条也失败:抛聚合错误,消息里带上逐条原因 ──
        this.#record(ring, attempts, { attemptNo, try: tryNo, route, elapsedMs, ok: false, failure, switched: false })
        logger?.error(`auto: 全部 ${attempts.length} 条路由均失败`)
        throw buildExhaustedError(attempts, LlmError)
      }
    }
  }

  /**
   * 记一条路由决策。环形缓冲满了由它自己淘汰最旧的。
   *
   * 两本账:
   *  - `attempts`(聚合错误用)只记**每条路由的最终失败**一条(`willRetry` 的中间记录不进),
   *    `try` 携带该路由的总尝试次数;
   *  - 环形缓冲(观测用)逐次都记,`try` 是第几次尝试,`willRetry` 标记"这条之后还会重试"。
   *
   * @param ring - 环形缓冲(可为 undefined,例如单测里)。
   * @param attempts - 本次请求的逐路由最终失败(抛聚合错误时要用)。
   * @param entry - 本次尝试的记录。
   */
  #record(ring, attempts, entry) {
    if (entry.willRetry !== true) {
      attempts.push({
        index: entry.attemptNo,
        try: entry.try,
        provider: entry.route.provider,
        model: entry.route.model,
        code: entry.failure?.code ?? null,
        message: entry.failure?.message ?? '',
        status: entry.failure?.status,
        elapsedMs: entry.elapsedMs,
      })
    }
    ring?.push({
      at: new Date().toISOString(),
      attempt: entry.attemptNo,
      try: entry.try,
      provider: entry.route.provider,
      model: entry.route.model,
      ok: entry.ok,
      switched: entry.switched,
      ...(entry.willRetry === true ? { willRetry: true } : {}),
      elapsedMs: entry.elapsedMs,
      ...(entry.failure === undefined ? {} : { code: entry.failure.code ?? 'UNKNOWN', reason: summarizeFailure(entry.failure, 400) }),
    })
  }
}
