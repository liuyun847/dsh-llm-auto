/**
 * dsh-llm-auto v0.2.0
 *
 * 给 DSH 加一个"合并多个模型订阅"的 `auto` 模型:模型选择器里多出一个 `Auto` 分组,
 * 组内一条 `auto`。选它以后,请求按 config.routes 的**顺序**依次尝试多条
 * 「provider + model」,某条**先按官方同款策略原地重试**(瞬时错误),重试耗尽
 * 才静默切下一条 —— 对上层(agent loop / 会话日志 / 压缩链路)它就是一个普通模型。
 *
 * ── 它到底怎么工作(一段话) ────────────────────────────────────────────────
 * 本插件用官方扩展点 `ctx.llm.registerAdapter(['auto'], adapter)` 注册一条**新的 provider 路由**。
 * 之所以不能往已有 provider 里追加模型:模型目录由
 * `dsh-api-session-controller/lib/types/catalog.js` 的 `buildModelCatalog()` 遍历
 * `ctx.llm.listProviders()` × `listModels()` 生成,**provider 是唯一的挂载单位**。
 * 于是 adapter.stream() 里对候选路由发起**嵌套调用** `ctx.llm.stream({...options, provider, model})`,
 * 把分片原样转交出去。嵌套调用是官方支持的形态(`LlmRuntime.stream` 的注释里写明
 * middleware / nested-call 的异常语义与适配器异常不同)。
 * 路由内重试的策略形状/默认值/校验全部复用 `@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy`
 * (见 lib/retry.js):官方 `dsh-llm-retry` 挂在 agent loop 瀑布上,管不到嵌套调用,
 * 所以"某条路由原地重试"只能在本插件内做,但没必要自造一套策略。
 *
 * ── 生效条件(踩过) ────────────────────────────────────────────────────────
 * `file:` 依赖在 pnpm 下不保证是拷贝还是硬链接(本机实测两者混存),真正被加载的是
 * `~\.dsh\profiles\<profile>\node_modules\dsh-llm-auto\`;改完 `plugins\` 下的源码
 * **别假设**副本会自动更新 —— 用 SHA256 比对两处确认(另存/原子替换会断开硬链接,两处分叉)。
 * 改插件代码要重启 dsh —— loader 按 URL 缓存已 import 的模块。
 * 改 profile 的 `cordis.patch.yml`(patch 层)则保存即热加载,不需要重启。
 * 所以顺序是:先改代码 → 同步 → 改配置(可选)→ 重启。
 * 本插件不进 `dsh.profile.bundles`(包无 `dsh.bundle` 字段),装载走 profile 的
 * `cordis.patch.yml` 的 insert(见本插件自带的 cordis.patch.yml,复制过去即可)。
 *
 * ── 有意不导出 `Config`(schemastery) ──────────────────────────────────────
 * 配置一律在 `normalizeRoutes()` / `normalizeRetry()` 里校验:结构问题打一条 error 并
 * **拒绝注册**(不抛,遵循本机既有约定 —— 插件配置错误不该让宿主起不来),单条问题 warn 后跳过。
 * 交给 schemastery 会把"少写一个 model 字段"变成整行加载失败,反而更难排查。
 * 例外:`retry` 块的校验复用官方 `resolveRetryPolicy`(坏值 warn 后回落官方默认)。
 *
 * ── 边界(详见 README) ─────────────────────────────────────────────────────
 *  · 只"失败时切换":不记账、不按价格/能力挑路由,顺序完全由 config.routes 决定;
 *  · 瞬时错误先在**该路由内**重试(默认 5 次,官方同款退避),重试耗尽或错误码不在
 *    瞬时白名单才切下一条;
 *  · 已经向调用方交出内容之后的上游失败**不重试不回退**(避免半截回答 + 重新回答);
 *  · 历史回放:嵌套调用前把每条历史助手消息的 `source.provider/model` 改回它
 *    `replayState` 记录的真实路由(纯函数见 lib/replay.js)。不改写的话,`LlmRuntime.forAdapter`
 *    会因为"历史 provider 是 auto、本次适配器是 pi-ai"而剥掉 replay 状态,pi-ai 就把思考块
 *    摊平进正文、把 `reasoning_content` 填成空串(2026-09-24 字节级实测);
 *  · `routes` 里的 provider 不能写 `auto` 自己(自递归):挂载时 warn 并跳过该条;
 *  · 不改默认模型:用户不主动选 `auto` 时一切照旧(本插件不碰 settings 与默认模型行)。
 */
import { AutoAdapter, createContextWindowResolver } from './adapter.js'
import { AUTO_MODEL, AUTO_PROVIDER, DEFAULT_LOG_LIMIT, DEFAULT_MODEL_NAME, RouteConfigError, describeChain, normalizeRoutes } from './routes.js'
import { describeRetryPolicy, normalizeRetry } from './retry.js'

/** Cordis 插件名,供加载器诊断与 cordis.patch.yml insert 使用。 */
export const name = 'llm-auto'
/** 只需要 llm 服务;webServer(HTTP 端点)走可选注入,headless 等 profile 下也能挂载。 */
export const inject = ['llm']

/** `GET /api/llm-auto/routes` 的路径(与 `dsh-client-connection` 的 `/api` 前缀路由同级)。 */
export const ROUTES_PATH = '/api/llm-auto/routes'

/**
 * 内存环形缓冲:只留最近 N 条路由决策,不落盘(重启即清空,不适合当审计账本)。
 * @param capacity - 容量(条)。
 * @returns `{ push, list, size, capacity }`。
 */
export function createRing(capacity) {
  const items = []
  return {
    capacity,
    push(entry) {
      items.push(entry)
      if (items.length > capacity) items.splice(0, items.length - capacity)
    },
    /**
     * @param limit - 最多返回多少条(取最近的);非正整数表示不限(以容量为上限)。
     * @returns 最近的若干条,时间正序。
     */
    list(limit) {
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, items.length) : items.length
      return items.slice(items.length - n)
    },
    get size() {
      return items.length
    },
  }
}

/** 只读 JSON 响应(自己拥有整个响应生命周期)。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger('llm-auto')

  let routes
  let skipped
  try {
    ({ routes, skipped } = normalizeRoutes(config.routes))
  } catch (error) {
    if (error instanceof RouteConfigError) {
      logger.error(error.message)
      return
    }
    throw error
  }
  for (const item of skipped) logger.warn(`auto: 跳过第 ${item.index} 条路由 ${item.label} —— ${item.reason}`)

  // 重试策略:缺省 = 官方默认(每路由 5 次重试,瞬时码白名单)。坏值只 warn 不拒绝注册。
  const { policy: retryPolicy, warnings: retryWarnings } = normalizeRetry(config.retry)
  for (const warning of retryWarnings) logger.warn(warning)

  const modelName = typeof config.name === 'string' && config.name.length > 0 ? config.name : DEFAULT_MODEL_NAME
  const ring = createRing(Number.isInteger(config.logLimit) && config.logLimit > 0 ? config.logLimit : DEFAULT_LOG_LIMIT)
  const configuredWindow = Number.isInteger(config.contextWindow) && config.contextWindow > 0 ? config.contextWindow : undefined
  const resolveContextWindow = createContextWindowResolver(ctx.llm, routes)

  const adapter = new AutoAdapter({
    llm: ctx.llm,
    routes,
    modelName,
    retryPolicy,
    ring,
    logger,
    resolveContextWindow: async (signal) => configuredWindow ?? resolveContextWindow(signal),
  })

  // ⚠ 必须用自己的 effect 包一层:`ctx.llm.registerAdapter()` 内部的 effect 挂在 **llm 服务自己的
  // fiber** 上(见 cordis Service 的 this.ctx),不会随本插件的卸载自动释放。返回的 handle 才是
  // 本插件的释放口 —— 热重载/卸载时必须由本 fiber 调用它,否则会留下一条指向死实例的路由。
  ctx.effect(() => ctx.llm.registerAdapter([AUTO_PROVIDER], adapter), 'llm-auto: register provider route')
  logger.info(`auto: 已注册路由 ${AUTO_PROVIDER}/${AUTO_MODEL}（${modelName}）→ ${describeChain(routes)}；${describeRetryPolicy(retryPolicy)}`)

  // HTTP 端点属于 web 外壳;headless 等 profile 没有 webServer,走可选注入。
  // 该路径是 exact 路由,优先于 dsh-client-connection 注册的 `/api` 前缀(前缀表只在 exact 未命中时
  // 才查)⇒ 它**不经过**浏览器鉴权 cookie 那一关。仅因 webServer 绑在回环地址才可接受,详见 README。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTES_PATH, 'http://127.0.0.1')
        const rawLimit = url.searchParams.get('limit')
        sendJson(res, 200, {
          provider: AUTO_PROVIDER,
          model: AUTO_MODEL,
          name: modelName,
          // 当前生效的重试策略(扁平结构,与官方 resolveRetryPolicy 的返回一致)
          retry: {
            mode: retryPolicy.mode,
            maxRetries: retryPolicy.maxRetries,
            retryableCodes: [...retryPolicy.retryableCodes],
            initialDelayMs: retryPolicy.initialDelayMs,
            maxDelayMs: retryPolicy.maxDelayMs,
            jitterRatio: retryPolicy.jitterRatio,
          },
          chain: routes.map((route) => `${route.provider}/${route.model}`),
          capacity: ring.capacity,
          total: ring.size,
          routes: ring.list(rawLimit === null ? undefined : Number.parseInt(rawLimit, 10)),
        })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: ROUTES_PATH, handler }),
      `llm-auto: ${ROUTES_PATH}`,
    )
  })
}

// 导出内部件供测试直接调用(不需要跑起 harness)
export { AutoAdapter, createContextWindowResolver } from './adapter.js'
export { describeChain, normalizeRoutes, RouteConfigError, AUTO_MODEL, AUTO_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_LOG_LIMIT, DEFAULT_MODEL_NAME } from './routes.js'
export { computeRetryDelay, describeRetryPolicy, normalizeRetry, DEFAULT_RETRY_POLICY, NO_RETRY_POLICY } from './retry.js'
export { buildExhaustedError, isFallbackCode, summarizeFailure, EXHAUSTED_CODE, NEVER_FALLBACK_CODES } from './errors.js'
export { restoreReplaySources } from './replay.js'
