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
 * ## 三条来自真机/源码的硬约束(改代码前先读)
 *
 * 1. **失败不是抛出来的,是终止分片**。`LlmRuntime.adapterStream` 把适配器的一切异常
 *    归一成 `finish{ kind:'error'|'aborted', failure:{ code, message, status? } }`。
 *    所以判定失败必须看终止分片,不能只 try/catch。
 *
 * 2. **回退只能发生在"一个分片都还没交出去"时**。`@deepseek-ai/dsh-llm/lib/invariant.js`
 *    给每一次 `llm/stream`(含嵌套调用与本人)套了一层语法校验器,它会拒绝:
 *    `block-start` 重复 index、同一个流里 `usage` 出现两次。
 *    如果我把 A 的 `block-start` 交出去再改放 B 的 `block-start`,外层校验器立刻报错。
 *    ⇒ 因此 `block-start` 与 `usage` 会被**暂存**,直到第一条真正的"内容分片"到达才一起放行;
 *    一旦放行(`committed = true`)就再也不回退。
 *    真机还观测到上游会**先发一个全零 usage 再报错**(ww/gpt-6-astra 502),
 *    暂存 usage 正好让这种情形仍能回退。
 *
 * 3. **不许出现"半截回答 + 重新回答"**。`committed` 之后的上游失败原样上报,不换路由。
 *
 * @module dsh-llm-auto/adapter
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { AUTO_GROUP_NAME, AUTO_MODEL, DEFAULT_CONTEXT_WINDOW, describeChain, describeRoute } from './routes.js'
import { buildExhaustedError, failureFromThrown, isFallbackCode, summarizeFailure } from './errors.js'

/** 首选路由窗口的缓存时长(毫秒)。目录会被反复重建,不该每次都去问一遍上游适配器。 */
const CONTEXT_WINDOW_TTL_MS = 30_000

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

/** 把终止分片里的 failure 归一成 `{ code, message, status? }`。 */
function normalizeFailure(failure) {
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  const message = typeof failure?.message === 'string' && failure.message.length > 0 ? failure.message : '(上游未给出原因)'
  return Number.isInteger(failure?.status) ? { code, message, status: failure.status } : { code, message }
}

/**
 * 按「该路由可用的最高强度」定档:取 `reasoning.efforts` 的**最后一项**(强度序固定,
 * 见 #nestedOptions 的说明)。
 *
 * 解析不出模型信息、或该路由不声明任何档位(含 `reasoning` 整体缺失)时,原样透传 —
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
  /** @type {{ llm: object, routes: Array<{provider: string, model: string}>, modelName: string, resolveContextWindow: (signal?: AbortSignal) => Promise<number>, ring?: object, logger?: object }} */
  #deps
  #chainLabel

  /**
   * @param deps - 依赖集合(全部由 lib/index.js 注入,便于单测替换)。
   * @param deps.llm - `ctx.llm`(嵌套调用入口)。
   * @param deps.routes - 已规范化的有序路由链。
   * @param deps.modelName - 模型显示名(config.name)。
   * @param deps.resolveContextWindow - 窗口解析器。
   * @param deps.ring - 路由日志环形缓冲。
   * @param deps.logger - 插件 logger。
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
   * 路由主循环。分片**原样透传**,只有"换路由"这一件事被插在中间。
   * @param options - 完整请求;`options.provider` 恒为 `auto`。
   * @returns 分片流。
   */
  async *stream(options) {
    const { llm, routes, ring, logger } = this.#deps
    const attempts = []

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]
      const attemptNo = index + 1
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

      // ── 调用方取消:如实结束,绝不换路由(换一条也会立刻被同一个 signal 掐掉) ──
      if (options.signal?.aborted === true) {
        for (const item of held) yield item
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure: { code: 'ABORTED', message: '调用方取消' }, switched: false })
        yield finishChunk ?? { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: thrown === undefined ? '调用方取消' : failureFromThrown(thrown).message } } }
        return
      }
      // ── 嵌套调用被判为 aborted(不是我方取消):同样不回退 ──
      if (kind === 'aborted') {
        for (const item of held) yield item
        yield finishChunk
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure: normalizeFailure(finishChunk.reason?.failure), switched: false })
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
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: true, switched: false })
        yield finishChunk
        return
      }

      // ── 已产出内容:不回退,如实上报(硬要求) ──
      if (committed) {
        logger?.warn(`auto: ${describeRoute(route)} 已产出内容后失败(${summarizeFailure(failure)}),按约定不回退,如实上报`)
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure, switched: false })
        for (const item of held) yield item
        if (finishChunk !== undefined) {
          yield finishChunk
          return
        }
        throw thrown ?? new LlmError(failure.message, failure.code)
      }

      // ── 该错误码不可回退:原样上报(保住 ABORTED / CONTEXT_WINDOW_EXCEEDED 等语义) ──
      if (!isFallbackCode(failure.code)) {
        logger?.warn(`auto: ${describeRoute(route)} 失败(${summarizeFailure(failure)}),该错误码不允许回退,直接上报`)
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure, switched: false })
        for (const item of held) yield item
        if (finishChunk !== undefined) {
          yield finishChunk
          return
        }
        throw thrown ?? new LlmError(failure.message, failure.code)
      }

      // ── 还可以换下一条 ──
      if (index < routes.length - 1) {
        const nextRoute = routes[index + 1]
        logger?.warn(`auto: 第 ${attemptNo} 条路由 ${describeRoute(route)} 失败(${summarizeFailure(failure)}),静默切换 → ${describeRoute(nextRoute)}`)
        this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure, switched: true })
        continue
      }

      // ── 最后一条也失败:抛聚合错误,消息里带上逐条原因 ──
      this.#record(ring, attempts, { attemptNo, route, elapsedMs, ok: false, failure, switched: false })
      logger?.error(`auto: 全部 ${attempts.length} 条路由均失败`)
      throw buildExhaustedError(attempts, LlmError)
    }
  }

  /**
   * 记一条路由决策。环形缓冲满了由它自己淘汰最旧的。
   *
   * `attempts` 里存**原始** message(聚合错误自己负责拼 `code: message`);
   * 环形缓冲里存已经拼好的单行摘要(人读)。
   * @param ring - 环形缓冲(可为 undefined,例如单测里)。
   * @param attempts - 本次请求的累计尝试(抛聚合错误时要用)。
   * @param entry - 本次尝试的记录。
   */
  #record(ring, attempts, entry) {
    attempts.push({
      index: entry.attemptNo,
      provider: entry.route.provider,
      model: entry.route.model,
      code: entry.failure?.code ?? null,
      message: entry.failure?.message ?? '',
      status: entry.failure?.status,
      elapsedMs: entry.elapsedMs,
    })
    ring?.push({
      at: new Date().toISOString(),
      attempt: entry.attemptNo,
      provider: entry.route.provider,
      model: entry.route.model,
      ok: entry.ok,
      switched: entry.switched,
      elapsedMs: entry.elapsedMs,
      ...(entry.failure === undefined ? {} : { code: entry.failure.code ?? 'UNKNOWN', reason: summarizeFailure(entry.failure, 400) }),
    })
  }
}
