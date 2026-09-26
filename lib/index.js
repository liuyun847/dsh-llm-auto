/**
 * dsh-llm-auto v0.3.0
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
 * `file:` 依赖在 pnpm 下默认建硬链接,本包 12/12 共享文件实测同 inode ⇒ 原地改已有文件两侧同生效;
 * 真正被加载的是 `~\.dsh\profiles\<profile>\node_modules\dsh-llm-auto\`。改完仍**核对两侧**
 * fileId/SHA256(另存/原子替换、write/edit 工具会断开硬链接,两处分叉);新增文件才要重跑 link。
 * 改插件代码要重启 dsh —— loader 按 URL 缓存已 import 的模块。
 * 改 profile 的 `cordis.patch.yml`(patch 层)则保存即热加载,不需要重启。
 * 所以顺序是:先改代码(原地改即两侧生效) → 改配置(可选) → 重启。
 * 本插件不进 `dsh.profile.bundles`(包无 `dsh.bundle` 字段),装载走 profile 的
 * `cordis.patch.yml` 的 insert(见本插件自带的 cordis.patch.yml,复制过去即可)。
 *
 * ── 导出 `Config`(schemastery):0.2.x **有意不导出**,0.3.0 起改为导出 ────────
 * **为什么改**:插件配置只有成为"带 schemastery `Config` 的活动条目"才会进入宿主的设置服务 ——
 * `dsh-settings` 的 `SettingsForms.describe()` 只投影这类条目(schema 取自
 * `entry.fiber.runtime.Config`,见 dsh-settings `lib/index.js:413-452` 与 `:538-541`),
 * 并且只投影标了 `.volatile()` 的字段(`volatileForm()`,同文件 `:122-131`)。
 * 不导出 ⇒ 本插件的配置在设置服务里连一条描述符都没有,`compactWindow` 这类"值型"配置
 * 就只能改 `cordis.patch.yml`。
 *
 * ⚠ **导出的效果边界(别高估)**:这一步换来的是"配置条目 + schema + 可写路径"
 *   (`settings.describe()` 能看到它,`settings.mutate/replace` 能写它)。
 *   随包发布的 Web 客户端**还没有**"按 schema 自动生成表单"的页面 —— `dsh-settings` 的
 *   README 自己写着 `no shipped client does so yet`;插件页(Plugins)只渲染经 slot 注册的
 *   表单页(`dsh-client-ui-plugin-manager` 的 `plugins.item` / `plugins.bundle.config` /
 *   `plugins.row.config`)。所以**光导出 `Config` 不会长出任何表单**:可点的表单来自本包
 *   0.4.0 新增的浏览器 half(`lib/client.js`),它注册进 `plugins.bundle.config`(键 = 包名),
 *   把 `compactWindow` 渲染成插件页里该 bundle 卡片上的官方 SettingsForm
 *   (2026-09-25 从 `plugins.row.config` 的行二级页提到卡片上,见 README §2);
 *   宿主侧 schema 的作用是让 `settings.describe()` / `settings.mutate()` 这条远端通道
 *   能看到并写入这些字段。
 *
 * **代价(必须知道)**:schema 是**加载期**校验,校验失败 = **整行插件加载失败** ——
 * 不再是本插件那条"打一条 error 但不注册"的软失败。所以 schema 按"能松就松"写:
 *  · `routes` / `retry` 用 `z.any()`:形状校验继续留给 `normalizeRoutes()` / `normalizeRetry()`,
 *    坏值依旧是"单条 warn 跳过 / 整体 error 不注册",不会让整行加载失败;
 *  · 数值字段(含 `compactWindow`)用 `z.number()`,但**刻意不加 `.min()` / `.step()`**:
 *    设置页据此渲染数字输入框,而范围与整数性仍由插件自己判 —— 非法值 warn 后回落默认,
 *    而不是让宿主那一行起不来(唯一会硬失败的是"把字符串写进数字字段"这种类型错误);
 *  · 结构性键(`routes` / `retry`)不标 `.volatile()`:它们由 `apply()` 一次性消费,
 *    标了等于向设置页承诺"改了即时生效"(实际要等重新 apply)。
 *    ⇒ 代价:设置页表单里**只出现标了 `.volatile()` 的字段**(`volatileForm()`,
 *      dsh-settings `lib/index.js:122-131`;一个 volatile 字段都没有时整个条目被跳过),
 *      即 `name` / `contextWindow` / `compactWindow` / `logLimit`;
 *      `routes` 与 `retry` 仍按老办法改 `cordis.patch.yml`(那条路本来就支持热加载)。
 * ⚠ `.volatile()` 字段在插件里拿到的是 cosmokit 的 **Volatile 引用**而不是值本身
 *   (schemastery `src/index.ts:521-530` 的 `createVolatile()`),读之前必须
 *   `unwrapVolatile()`(见 lib/compact.js)—— 忘了解包会拿一个对象去做算术。
 *
 * 其余配置的校验口径不变:结构问题打 error 并**拒绝注册**(不抛,遵循本机既有约定 ——
 * 插件配置错误不该让宿主起不来);`retry` 块的校验复用官方 `resolveRetryPolicy`。
 *
 * ── 对外声明的上下文窗口:默认由"压缩点"反算 ────────────────────────────────
 * `config.compactWindow`(默认 500000)是**压缩点**;插件按 compaction-basic 的阈值算式
 * (`threshold = floor(min(cw × 0.8, cw − 65536))`)反算出该对外声明的窗口(默认 625000)。
 * 优先级 `compactWindow > contextWindow > 逐跳解析 > 65536`、假设与边界见 lib/compact.js 与
 * `planDeclaredWindow()`;老键 `contextWindow` 保留(显式声明窗口的逃生门),两者同时给出时
 * 以 `compactWindow` 为准,并打一条 warn 说明用了哪个、忽略了哪个。
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
import z from '@deepseek-ai/schemastery'
import { AutoAdapter, createContextWindowResolver } from './adapter.js'
import { AUTO_MODEL, AUTO_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_LOG_LIMIT, DEFAULT_MODEL_NAME, RouteConfigError, describeChain, normalizeRoutes } from './routes.js'
import { DEFAULT_COMPACT_WINDOW, describeWindowPlan, planDeclaredWindow, unwrapVolatile } from './compact.js'
import { describeRetryPolicy, normalizeRetry } from './retry.js'

/** Cordis 插件名,供加载器诊断与 cordis.patch.yml insert 使用。 */
export const name = 'llm-auto'
/** 只需要 llm 服务;webServer(HTTP 端点)走可选注入,headless 等 profile 下也能挂载。 */
export const inject = ['llm']

/**
 * 配置 schema(0.3.0 起导出,见文件头注释里的取舍说明)。
 *
 * 三条纪律:
 *  1. **能松就松** —— `routes` / `retry` 是 `z.any()`:形状校验留给 `normalizeRoutes()` /
 *     `normalizeRetry()`,坏值只 warn/error,绝不让整行插件加载失败;
 *  2. 数值字段是 `z.number()`(设置页要据此渲染数字输入框)但**不加 min/step**:
 *     范围与整数性仍由插件自己判并 warn 回落;
 *  3. 只有"插件会**重新读**的字段"才标 `.volatile()`(`name` / `contextWindow` /
 *     `compactWindow` / `logLimit`)—— 设置页的表单只显示这些字段,标错等于承诺了做不到的
 *     "即时生效"。结构性键(`routes` / `retry`)仍走 `cordis.patch.yml`。
 *
 * `description` 是设置页上唯一的中文说明来源,所以每个键都要写。
 */
export const Config = z.object({
  routes: z.any().description('有序回退链(数组,每项 { provider, model },第一项即首选)。这里刻意用宽松类型:坏条目由插件自己 warn 后跳过,不让整行加载失败'),
  name: z.string().description('模型显示名(模型选择器里的分组名恒为 Auto)。改完即时生效,不需要重启').volatile(),
  contextWindow: z.number().description('[旧键] 直接声明对外宣称的上下文窗口(正整数)。与 compactWindow 同时给出时以 compactWindow 为准并被忽略;≤ 65536 时压缩引擎的 pressure budget 会 ≤ 0').volatile(),
  compactWindow: z.number().default(DEFAULT_COMPACT_WINDOW).description(`让自动压缩发生在这个 token 数附近(正整数,默认 ${DEFAULT_COMPACT_WINDOW})。插件据此反算出对外宣称的上下文窗口(默认 500000 ⇒ 625000)`).volatile(),
  logLimit: z.number().description(`路由日志环形缓冲条数(仅内存,重启即清空;默认 ${DEFAULT_LOG_LIMIT})`).volatile(),
  retry: z.any().description('路由内重试策略(与官方 retryPolicy 同形状:maxRetries / retryableCodes / backoff)。刻意用宽松类型:坏值由插件自己 warn 后回落官方默认'),
})

/** `GET /api/llm-auto/routes` 的路径(与 `dsh-client-connection` 的 `/api` 前缀路由同级)。 */
export const ROUTES_PATH = '/api/llm-auto/routes'

/**
 * 内存环形缓冲:只留最近 N 条路由决策,不落盘(重启即清空,不适合当审计账本)。
 * @param capacity - 容量(条);也可以传 `() => number`(宿主里 `config.logLimit` 是 volatile
 *   引用,传取值函数才能让设置页改完即时生效)。
 * @returns `{ push, list, size, capacity }`;`capacity` 是读时求值的 getter。
 */
export function createRing(capacity) {
  const items = []
  const capacityOf = () => (typeof capacity === 'function' ? capacity() : capacity)
  return {
    get capacity() {
      return capacityOf()
    },
    push(entry) {
      items.push(entry)
      const cap = capacityOf()
      if (items.length > cap) items.splice(0, items.length - cap)
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

  // 下面四个取值器都**每次重读** config(而不是把值抄下来):宿主里这些键是 schemastery 的
  // `.volatile()` 字段,设置页/web 端写进来的新值会原地更新那个引用 ⇒ 取值器一读就是新值,
  // 不需要重新 apply。`unwrapVolatile()` 负责把引用解成真实值(见 lib/compact.js)。
  const readName = () => {
    const raw = unwrapVolatile(config.name)
    return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_MODEL_NAME
  }
  const readLogLimit = () => {
    const raw = unwrapVolatile(config.logLimit)
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LOG_LIMIT
  }

  const ring = createRing(readLogLimit)
  const resolveRouteWindow = createContextWindowResolver(ctx.llm, routes)

  // ── 对外声明的上下文窗口 ────────────────────────────────────────────────────
  // 口径决策全部在纯函数里(见 lib/compact.js 的 `planDeclaredWindow`):
  // compactWindow(默认 500000)反算 > contextWindow 直取 > 逐跳解析 > 65536。
  const initialPlan = planDeclaredWindow(config)
  for (const warning of initialPlan.warnings) logger.warn(warning)
  /** 逐跳解析出来的最近一次窗口,只给 HTTP 端点事后复核用。 */
  let lastResolvedWindow
  const resolveContextWindow = async (signal) => {
    const plan = planDeclaredWindow(config)
    const value = plan.declaredContextWindow ?? await resolveRouteWindow(signal)
    lastResolvedWindow = value
    return value
  }

  const adapter = new AutoAdapter({
    llm: ctx.llm,
    routes,
    modelName: readName,
    retryPolicy,
    ring,
    logger,
    resolveContextWindow,
  })

  // ⚠ 必须用自己的 effect 包一层:`ctx.llm.registerAdapter()` 内部的 effect 挂在 **llm 服务自己的
  // fiber** 上(见 cordis Service 的 this.ctx),不会随本插件的卸载自动释放。返回的 handle 才是
  // 本插件的释放口 —— 热重载/卸载时必须由本 fiber 调用它,否则会留下一条指向死实例的路由。
  ctx.effect(() => ctx.llm.registerAdapter([AUTO_PROVIDER], adapter), 'llm-auto: register provider route')
  logger.info(`auto: 已注册路由 ${AUTO_PROVIDER}/${AUTO_MODEL}（${readName()}）→ ${describeChain(routes)}；${describeRetryPolicy(retryPolicy)}`)
  // 窗口口径单独一行:映射那一支会把所依赖的假设一并打出来,便于事后倒推(见 lib/compact.js)。
  logger.info(describeWindowPlan(initialPlan, DEFAULT_CONTEXT_WINDOW))

  // HTTP 端点属于 web 外壳;headless 等 profile 没有 webServer,走可选注入。
  // 该路径是 exact 路由,优先于 dsh-client-connection 注册的 `/api` 前缀(前缀表只在 exact 未命中时
  // 才查)⇒ 它**不经过**浏览器鉴权 cookie 那一关。仅因 webServer 绑在回环地址才可接受,详见 README。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTES_PATH, 'http://127.0.0.1')
        const rawLimit = url.searchParams.get('limit')
        // 现场重算(而不是用挂载时那份):设置页里的 volatile 改动即时反映在响应里,便于事后复核。
        const plan = planDeclaredWindow(config)
        sendJson(res, 200, {
          provider: AUTO_PROVIDER,
          model: AUTO_MODEL,
          name: readName(),
          // 当前生效的重试策略(扁平结构,与官方 resolveRetryPolicy 的返回一致)
          retry: {
            mode: retryPolicy.mode,
            maxRetries: retryPolicy.maxRetries,
            retryableCodes: [...retryPolicy.retryableCodes],
            initialDelayMs: retryPolicy.initialDelayMs,
            maxDelayMs: retryPolicy.maxDelayMs,
            jitterRatio: retryPolicy.jitterRatio,
          },
          // 压缩点(未启用映射时为 null)与最终对外声明的窗口;后者在"逐跳解析"口径下要等
          // 第一次目录解析才有值,故回落到最近一次解析结果(null = 还没解析过)。
          compactWindow: plan.compactPoint,
          declaredContextWindow: plan.declaredContextWindow ?? lastResolvedWindow ?? null,
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
export { COMPACT_HEADROOM_TOKENS, COMPACT_RETAIN_RATIO, COMPACT_THRESHOLD_RATIO, DEFAULT_COMPACT_WINDOW, WINDOW_SOURCE, compactRetainFor, compactThresholdFor, declaredWindowForCompactPoint, describeWindowPlan, minimumUsableCompactWindow, planDeclaredWindow, unwrapVolatile } from './compact.js'
export { computeRetryDelay, describeRetryPolicy, normalizeRetry, DEFAULT_RETRY_POLICY, NO_RETRY_POLICY } from './retry.js'
export { buildExhaustedError, isFallbackCode, summarizeFailure, EXHAUSTED_CODE, NEVER_FALLBACK_CODES } from './errors.js'
export { restoreReplaySources } from './replay.js'
