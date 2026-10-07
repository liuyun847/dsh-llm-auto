/**
 * dsh-llm-auto v0.8.0 —— 订阅额度查询(面板侧只读观测 + 路由侧按需强制刷新)。
 *
 * 干什么:按当前回退链上出现的 provider,去两家的"用量/余额"接口取一份快照,供
 * `GET /api/llm-auto/routes` 的 `quota` 字段与插件页「回退链」面板使用。
 * **不参与任何路由决策** —— 它不改顺序、不跳过、不记账(那是可选旁路,见 README §6)。
 *
 * 三条硬规矩:
 *  1. **查不到就说查不到**:`status: 'unavailable'` 的来源**不带**任何数字字段 ——
 *     不是 0、不是 `{}`、不是 null。0 在两家都是**合法真值**(Command Code 的余额可以
 *     真的是 0,OpenCode Go 的百分比可以真的是 0),拿 0 顶替会把结论说反:
 *     Go 的月度档现在就是 `status:'rate-limited' / percent:100`(= 该窗口已耗尽),
 *     显示成 "0%" 正好是相反的意思;
 *  2. **永不抛**:凭据缺失、超时、403、坏 JSON……一律收成一条 unavailable 记录;
 *     端点侧还会再包一层 try/catch —— 观测能力不该有能力影响状态码;
 *  3. **不外传凭据值**:响应与日志里只出现**引用名**(`CMD_API_KEY`)与**来源层**
 *     (`env`/`file`/…),值只在 fetch 的请求头里活一次,不缓存、不落盘、不进日志。
 *
 * 纯模块:不 import 任何 Harness 运行时;`fetch` / 凭据服务 / 时钟全部由调用方注入
 * (缺省取全局),所以 `node --test` 能直接覆盖(见 test/quota.test.mjs)。
 */

/** 本模块认识的两家 provider id —— 与 `config.routes[].provider` 里的写法逐字一致。 */
export const QUOTA_PROVIDERS = Object.freeze({
  COMMANDCODE: 'commandcode',
  OPENCODE_GO: 'opencode-go',
})

/**
 * 不可查的原因码(机器可读、稳定)。前端只做一层文案映射,不解析 `message`。
 *
 * `blocked` 与 `auth` **必须分开**:Command Code 的 403 有两种完全不同的事 ——
 * Cloudflare 按浏览器签名拦(`error_code: 1010`)与真正的凭据被拒;合成一个会让
 * "换 UA 就能好"的故障看起来像"key 失效"。
 */
export const QUOTA_REASON = Object.freeze({
  /** 凭据引用解析不到值。 */
  NO_CREDENTIAL: 'no-credential',
  /** 配置里的引用名不合规(POSIX shell 标识符)。 */
  BAD_REF: 'bad-ref',
  /** 上游按浏览器签名拦截(Cloudflare 1010)。 */
  BLOCKED: 'blocked',
  /** 401/403:凭据被拒。 */
  AUTH: 'auth',
  /** 其它非 2xx。 */
  HTTP: 'http',
  /** AbortController 触发。 */
  TIMEOUT: 'timeout',
  /** fetch 本身失败(DNS/TLS/连接)。 */
  NETWORK: 'network',
  /** 响应不是预期形状。 */
  PARSE: 'parse',
  /** 运行时没有全局 fetch。 */
  NO_FETCH: 'no-fetch',
  /** 配置里关掉了这一家。 */
  DISABLED: 'disabled',
  /** 兜底。 */
  ERROR: 'error',
})

/**
 * 凭据引用的合法形状(与 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN` 同一口径)。
 * 自己挡一道的理由:非法名字去 `resolve()` 只会白问一次,不如当场归类成 `bad-ref`。
 */
export const QUOTA_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Command Code 的 base(与推理用的 `/provider/v1` 同一 key、不同路径树)。 */
const COMMANDCODE_BASE = 'https://api.commandcode.ai'
/** 主力接口:余额 + 5 小时/周两档窗口(单位是美元等值)。 */
const COMMANDCODE_CREDITS_PATH = '/alpha/billing/credits'
/** 次要接口:套餐身份(`planId` 是判套餐的权威字段,能解释 cap 从哪里来)。 */
const COMMANDCODE_SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions'
/** OpenCode Go 的未文档化用量接口(三档窗口百分比;没有金额口径,也没有余额接口)。 */
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * 默认 UA。
 *
 * ⚠ 实测口径(2026-10-05):Command Code 那边**不是**"没有浏览器 UA 就必 403" ——
 * node 的默认 `user-agent: node` 也是 200,只有 `Python-urllib/3.12` 命中了
 * Cloudflare 的签名黑名单(`403 + error_code 1010`)。所以这里只是"防黑名单",
 * 而不是"伪装成浏览器";真被拦了会把 403/1010 单独归类成 `blocked`。
 * 上游改规则时可以经配置覆盖它。
 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** 缺省配置(全部可省;坏值只 warn 并回落这里)。 */
export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  enabled: true,
  /** 缓存窗口(毫秒):从"上次**尝试**"起算,成败都算 —— 网络坏时也不会每次请求都打上游。 */
  ttlMs: 60000,
  /**
   * 单个 HTTP 请求的上限(毫秒),到点由 AbortController 中止。
   *
   * 默认给 8000 而不是 4000:2026-10-05 本机实测 —— Command Code 的
   * `/alpha/billing/subscriptions` 冷连接 1.7~2.3s、`credits` 0.3~1.4s、Go 0.6~1.0s;
   * 用真实上游跑本模块时,4s 的旧默认**真的超时过一次**(界面会显示"不可查:查询超时",
   * 而机器与上游都好好的)。查询是后台的、不阻塞端点响应 ⇒ 宁可多等一会儿,也不要误报超时。
   */
  timeoutMs: 8000,
  userAgent: DEFAULT_USER_AGENT,
  sources: Object.freeze({
    [QUOTA_PROVIDERS.COMMANDCODE]: Object.freeze({ enabled: true, apiKeyEnv: 'CMD_API_KEY' }),
    [QUOTA_PROVIDERS.OPENCODE_GO]: Object.freeze({ enabled: true, apiKeyEnv: 'OPENCODE_API_KEY' }),
  }),
})

/** 造一条带原因码的错误(内部用;被 `classifyFailure` 读走)。 */
function quotaError(reason, message) {
  const error = new Error(message)
  error.quotaReason = reason
  return error
}

/**
 * 解析并校验 `config.quota`。
 *
 * 口径与包内其它配置一致(见 lib/routes.js / lib/retry.js):坏值**只 warn 并回落默认**,
 * 绝不让整行插件加载失败;唯一会硬失败的只有 schema 那一层的类型错(所以 `Config` 里
 * 这个键写成 `z.any()`)。
 * @param raw - `config.quota` 原始值(可省)。
 * @returns `{ config, warnings }`;`config` 已填满默认值且形状固定。
 */
export function normalizeQuota(raw) {
  const warnings = []
  if (raw === undefined || raw === null) return { config: cloneDefaults(), warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('auto: 额度配置(quota)应为对象,已回落默认')
    return { config: cloneDefaults(), warnings }
  }

  const config = cloneDefaults()
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
    else warnings.push('auto: quota.enabled 应为布尔值,已回落默认 true')
  }
  for (const [key, name] of [['ttlMs', 'ttlMs'], ['timeoutMs', 'timeoutMs']]) {
    const value = raw[key]
    if (value === undefined) continue
    if (Number.isInteger(value) && value > 0) config[key] = value
    else warnings.push(`auto: quota.${name} 应为正整数(毫秒),已回落默认 ${config[key]}`)
  }
  if (raw.userAgent !== undefined) {
    if (typeof raw.userAgent === 'string' && raw.userAgent.trim().length > 0) config.userAgent = raw.userAgent
    else warnings.push('auto: quota.userAgent 应为非空字符串,已回落默认浏览器 UA')
  }

  // 两家各自一段;`opencode-go` 与 `opencodeGo` 两种写法都认(前者与 provider id 逐字一致,
  // 后者在 YAML/JS 里更顺手)。
  const plans = [
    [QUOTA_PROVIDERS.COMMANDCODE, firstDefined(raw[QUOTA_PROVIDERS.COMMANDCODE], raw.commandcode), 'commandcode'],
    [QUOTA_PROVIDERS.OPENCODE_GO, firstDefined(raw[QUOTA_PROVIDERS.OPENCODE_GO], raw.opencodeGo), 'opencodeGo'],
  ]
  for (const [provider, entry, label] of plans) {
    if (entry === undefined || entry === null) continue
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`auto: quota.${label} 应为对象,已回落默认`)
      continue
    }
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled === 'boolean') config.sources[provider].enabled = entry.enabled
      else warnings.push(`auto: quota.${label}.enabled 应为布尔值,已回落默认 true`)
    }
    if (entry.apiKeyEnv !== undefined) {
      if (typeof entry.apiKeyEnv === 'string' && QUOTA_REF_PATTERN.test(entry.apiKeyEnv)) config.sources[provider].apiKeyEnv = entry.apiKeyEnv
      else warnings.push(`auto: quota.${label}.apiKeyEnv 不是合法的环境变量名(POSIX 标识符),已回落默认 ${config.sources[provider].apiKeyEnv}`)
    }
  }
  return { config, warnings }
}

/** 第一个不是 undefined 的值(两种键名都认时用)。 */
function firstDefined(...values) {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

/** 默认配置的深拷贝(可变的那一份)。 */
function cloneDefaults() {
  return {
    enabled: DEFAULT_QUOTA_CONFIG.enabled,
    ttlMs: DEFAULT_QUOTA_CONFIG.ttlMs,
    timeoutMs: DEFAULT_QUOTA_CONFIG.timeoutMs,
    userAgent: DEFAULT_QUOTA_CONFIG.userAgent,
    sources: {
      [QUOTA_PROVIDERS.COMMANDCODE]: { ...DEFAULT_QUOTA_CONFIG.sources[QUOTA_PROVIDERS.COMMANDCODE] },
      [QUOTA_PROVIDERS.OPENCODE_GO]: { ...DEFAULT_QUOTA_CONFIG.sources[QUOTA_PROVIDERS.OPENCODE_GO] },
    },
  }
}

/**
 * 余额口径:`monthly + purchased + free`。
 *
 * 三者都是**美元额度**(充值额度可结转、不过期,所以 `purchased` 不会自己清零),
 * 但面板与接口都保留三个原始字段 —— 加总只是方便看,口径本身要能复核。
 * @param credits - `{ monthly, purchased, free }`。
 * @returns 合计;**任一档取不到就给 null**(绝不用 0 顶替未知 —— 上游改形状时"余额 $0.00"
 *   正是本模块第一条硬规矩禁止的那种谎报)。
 */
export function sumCredits(credits) {
  const parts = [credits?.monthly, credits?.purchased, credits?.free]
  if (!parts.every((value) => Number.isFinite(value))) return null
  return parts[0] + parts[1] + parts[2]
}

/**
 * 把一次非 2xx 响应分类成原因码。
 *
 * `403 + error_code 1010 / error_name browser_signature_banned` 是 Cloudflare 的
 * 浏览器签名拦截(**换 UA 就好**,与 key 无关);其它 401/403 才是凭据被拒。
 * @param status - HTTP 状态码。
 * @param body - 已解析的响应体(可能为 undefined)。
 * @returns 带 `quotaReason` 的 Error。
 */
export function classifyHttpError(status, body) {
  const code = body !== null && typeof body === 'object' ? body.error_code : undefined
  const name = body !== null && typeof body === 'object' ? body.error_name : undefined
  if (status === 403 && (code === 1010 || name === 'browser_signature_banned')) {
    return quotaError(QUOTA_REASON.BLOCKED, '请求被 Cloudflare 按浏览器签名拦截(UA 不被接受,不是 key 无效)')
  }
  if (status === 401 || status === 403) return quotaError(QUOTA_REASON.AUTH, `凭据被上游拒绝(HTTP ${status})`)
  return quotaError(QUOTA_REASON.HTTP, `上游返回 HTTP ${status}`)
}

/**
 * 造一条不可查记录。
 *
 * ⚠ 这里**刻意**只给元数据:没有 `credits` / `windows` / `plan` 键,只要不可查就一个数字都不给。
 * @param provider - provider id。
 * @param ref - 凭据引用名。
 * @param reason - 原因码(见 {@link QUOTA_REASON})。
 * @param message - 人读一句(中文)。
 * @param credentialSource - 已知时的来源层(可省)。
 * @returns 一条 unavailable 来源记录。
 */
export function unavailableSource(provider, ref, reason, message, credentialSource = null) {
  return {
    provider,
    status: 'unavailable',
    reason,
    message,
    ref,
    credentialSource,
    fetchedAt: null,
  }
}

/**
 * 造一个额度查询器。
 *
 * 用法(宿主侧):`snapshot()` 同步读快照(永不抛),`touch()` 按 TTL 触发一次后台刷新,
 * `forceRefresh()` **绕过 TTL 只刷指定的几家**(0.8.0 起,路由侧的冷却补查用)。
 * 三者的 Promise 都**永不 reject**(失败已经变成 unavailable 记录)。
 * **没有定时器** —— 不主动查,所以 headless(无 webServer)与"没人看面板"时零外部流量。
 *
 * @param options - `{ config, credentials, fetchImpl, now, logger }`。
 *   返回 `{ snapshot, touch, forceRefresh }`。
 *   `config` 是 {@link normalizeQuota} 的产物(缺省取默认);
 *   `credentials` 是凭据服务(或 `() => 服务`,用于服务可能后到的场景);
 *   `fetchImpl` 缺省取 `globalThis.fetch`(**每次请求现取**,便于测试与热替换);
 *   `now` 是时钟(缺省 `Date.now`,测试用假钟)。
 * @returns `{ snapshot, touch }`。
 */
export function createQuotaTracker(options = {}) {
  const config = options.config ?? cloneDefaults()
  const logger = options.logger
  const nowOf = typeof options.now === 'function' ? options.now : () => Date.now()
  const credentialsOf = typeof options.credentials === 'function' ? options.credentials : () => options.credentials

  /** provider → 最近一次落定的来源记录(ok 或 unavailable);原子替换,不原地改。 */
  let payloads = new Map()
  /** 最近一次刷新**完成**的时间(成败都算);null = 还没刷过。 */
  let checkedAt = null
  /**
   * 最近一次刷新的**发起**时间 —— TTL 从它起算(失败也占坑,避免每次请求都打上游)。
   *
   * 初值是 `-Infinity` 而不是 0:第一次 `touch()` 必须能刷。取 0 时,在"时钟从 0 附近开始"
   * 的场合(单测的假钟、或任何以很小的时间值为 now 的宿主)会被 TTL 闸门当成"刚刷过"挡掉,
   * 症状是快照永远停在 `pending`。
   */
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  /** 在飞的刷新(macOS 单飞:连点刷新只打一轮)。 */
  let refreshing = null
  /**
   * 在飞的**强制**刷新:provider 组合的键 → Promise(macOS 单飞)。
   *
   * ⚠ 与 `refreshing` **分开两张表**:`refreshing` 是"整链 TTL 刷新"的单飞闸门,而强制刷新
   * 是"绕开 TTL、只刷一家"的旁路 —— 共用一个槽会让"TTL 刷新正在跑"变成"这一次补查被静默
   * 跳过"(冷却判定于是拿到旧快照,白撞到下一个 TTL 窗口)。
   */
  const forcing = new Map()

  /**
   * 本模块认识的那一家(只认**自己的属性**)。
   *
   * ⚠ 必须 `hasOwnProperty`:直接 `config.sources[name]` 时,`toString` / `constructor` / `valueOf`
   * 这类名字会顺着原型链拿到函数(truthy)⇒ 一个不存在的 provider 会被当成"认识"并画到面板上。
   * @param provider - 候选 provider 名。
   * @returns 该家的计划对象,或 undefined。
   */
  function planOf(provider) {
    if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(config.sources, provider)) return undefined
    return config.sources[provider]
  }

  /** 当前链上"本模块认识且没被关掉"的 provider,按链上的出现顺序去重。 */
  function supportedOf(providers) {
    const out = []
    for (const provider of Array.isArray(providers) ? providers : []) {
      const plan = planOf(provider)
      if (plan === undefined || plan.enabled === false) continue
      if (!out.includes(provider)) out.push(provider)
    }
    return out
  }

  /** 解析一个引用:优先凭据服务,退环境变量(托管库"永不物化进环境"是设计使然,所以是兜底)。 */
  async function resolveCredential(ref) {
    if (!QUOTA_REF_PATTERN.test(ref)) throw quotaError(QUOTA_REASON.BAD_REF, `凭据引用名 ${ref} 不是合法的环境变量名`)
    let credentials
    try {
      credentials = credentialsOf()
    } catch (error) {
      credentials = undefined
      note(`auto: 读凭据服务失败 —— ${text(error)}`)
    }
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return { value: resolved.value, source: typeof resolved.source === 'string' ? resolved.source : null }
      }
      return undefined
    }
    const ambient = typeof process !== 'undefined' ? process.env?.[ref] : undefined
    return typeof ambient === 'string' && ambient.length > 0 ? { value: ambient, source: 'env' } : undefined
  }

  /** 一次性请求:超时走 AbortController,非 2xx 与坏形状都归成带原因码的错误。 */
  async function requestJson(url, headers) {
    const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    if (typeof fetchImpl !== 'function') throw quotaError(QUOTA_REASON.NO_FETCH, '当前运行时没有全局 fetch,无法查询额度')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      let response
      try {
        response = await fetchImpl(url, { headers, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw timeoutError()
        throw quotaError(QUOTA_REASON.NETWORK, `网络请求失败:${text(error)}`)
      }
      if (response === null || typeof response !== 'object') throw quotaError(QUOTA_REASON.NETWORK, 'fetch 没有返回响应对象')
      // ⚠ 超时预算**必须覆盖到 body 读完**。只把 signal 交给 fetch 是不够的:body 挂住时(真实 fetch
      //   的 abort 会连身体一起中断,但替身/别的实现不一定)这一次 refresh 就永不落定 ⇒ `refreshing`
      //   永久非 null ⇒ 之后每一次 `touch()` 都复用同一个 promise ⇒ **静默停更**(端点仍 200,没人知道)。
      //   所以 readBody() 显式与 abort 赛跑:abort 一响,读体立刻以 TIMEOUT 收场。
      const body = await readBody(response, controller)
      if (response.ok !== true) throw classifyHttpError(Number.isInteger(response.status) ? response.status : 0, body)
      if (body === undefined) throw quotaError(QUOTA_REASON.PARSE, '上游响应不是合法 JSON')
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  /** 超时错误(连接阶段与读体阶段共用同一文案与原因码)。 */
  function timeoutError() {
    return quotaError(QUOTA_REASON.TIMEOUT, `查询超时(${config.timeoutMs}ms)`)
  }

  /**
   * 读一次响应体,并与这次请求的 abort 信号赛跑。
   *
   * 解析不了 / 不是对象 ⇒ undefined(交给上层归成 parse);被中止 ⇒ TIMEOUT 错误。
   * @param response - fetch 的响应。
   * @param controller - 这次请求的 AbortController。
   * @returns 已解析的对象或 undefined。
   */
  async function readBody(response, controller) {
    if (typeof response.json !== 'function') return undefined
    const parsed = Promise.resolve().then(() => response.json()).then(
      (body) => (body !== null && typeof body === 'object' ? body : undefined),
      () => undefined,
    )
    if (controller.signal.aborted) throw timeoutError()
    const aborted = new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(timeoutError()), { once: true })
    })
    return Promise.race([parsed, aborted])
  }

  /** 请求头:只在这里出现凭据**值**;UA 由上一步挡住 Cloudflare 的签名黑名单。 */
  function requestHeaders(key) {
    return {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': config.userAgent,
    }
  }

  /** Command Code:credits 必需、subscriptions 次要(它失败只让 plan 为 null)。 */
  async function readCommandCode(ref, credential) {
    const headers = requestHeaders(credential.value)
    const [creditsBody, subscriptionsBody] = await Promise.all([
      requestJson(`${COMMANDCODE_BASE}${COMMANDCODE_CREDITS_PATH}`, headers),
      requestJson(`${COMMANDCODE_BASE}${COMMANDCODE_SUBSCRIPTIONS_PATH}`, headers).catch(() => undefined),
    ])
    const credits = creditsBody.credits
    if (credits === null || typeof credits !== 'object') throw quotaError(QUOTA_REASON.PARSE, 'credits 响应里没有 credits 对象')
    const windows = pickCommandCodeWindows(creditsBody.windowLimits)
    return {
      provider: QUOTA_PROVIDERS.COMMANDCODE,
      status: 'ok',
      reason: null,
      message: null,
      ref,
      credentialSource: credential.source,
      fetchedAt: isoOf(nowOf()),
      // ⚠ 取不到的字段**不带键**,绝不填 0:上游一旦改形状,填 0 会显示成"余额 $0.00",
      //   那正是本模块第一条硬规矩禁止的(0 是合法真值,不能拿它当"不知道")。
      credits: finiteOnly({
        total: sumCredits({ monthly: credits.monthlyCredits, purchased: credits.purchasedCredits, free: credits.freeCredits }),
        monthly: numberOrNull(credits.monthlyCredits),
        purchased: numberOrNull(credits.purchasedCredits),
        free: numberOrNull(credits.freeCredits),
        belowThreshold: credits.belowThreshold === true,
        threshold: numberOrNull(credits.creditThreshold),
      }),
      windows,
      plan: pickCommandCodePlan(subscriptionsBody),
    }
  }

  /** OpenCode Go:三档窗口原样透传(含 `status` —— `rate-limited` 就是"该窗口已耗尽")。 */
  async function readOpencodeGo(ref, credential) {
    const body = await requestJson(OPENCODE_GO_USAGE_URL, requestHeaders(credential.value))
    const usage = body.usage
    if (usage === null || typeof usage !== 'object') throw quotaError(QUOTA_REASON.PARSE, 'usage 响应里没有 usage 对象')
    const windows = {}
    for (const name of ['rolling', 'weekly', 'monthly']) {
      const window = usage[name]
      if (window === null || typeof window !== 'object') continue
      windows[name] = finiteOnly({
        status: typeof window.status === 'string' ? window.status : 'unknown',
        percent: Number.isFinite(window.percent) ? Math.max(0, Math.min(100, Math.trunc(window.percent))) : null,
        resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
      })
    }
    if (Object.keys(windows).length === 0) throw quotaError(QUOTA_REASON.PARSE, 'usage 响应里一档窗口都没有')
    return {
      provider: QUOTA_PROVIDERS.OPENCODE_GO,
      status: 'ok',
      reason: null,
      message: null,
      ref,
      credentialSource: credential.source,
      fetchedAt: isoOf(nowOf()),
      windows,
    }
  }

  /**
   * 一次刷新:各来源并行,逐来源隔离失败;结果**并入**快照(只动这次真查到的几家)。
   *
   * ⚠ 是"并入"而不是"整体替换":强制刷新只查一家,整体替换会把别的来源挤掉 —— 面板上
   * 那几家会凭空消失(状态从 ok 掉回 pending),而它们其实好好地待在上一次快照里。
   * @param wanted - 这一轮要查哪些 provider(调用方已收窄;不认识的会被忽略)。
   * @returns Promise<void>(永不 reject:失败已收成 unavailable 记录)。
   */
  async function refresh(wanted) {
    const satisfied = (Array.isArray(wanted) ? wanted : []).filter((provider) => planOf(provider) !== undefined)
    if (satisfied.length === 0) return
    const settled = await Promise.all(satisfied.map(async (provider) => {
      const plan = planOf(provider)
      let credential
      try {
        credential = await resolveCredential(plan.apiKeyEnv)
      } catch (error) {
        const reason = error?.quotaReason ?? QUOTA_REASON.NO_CREDENTIAL
        return [provider, unavailableSource(provider, plan.apiKeyEnv, reason, reason === QUOTA_REASON.BAD_REF ? text(error) : `凭据 ${plan.apiKeyEnv} 未配置:在「模型」页填入它(或设同名环境变量)后重启一次 DSH`)]
      }
      if (credential === undefined) {
        return [provider, unavailableSource(provider, plan.apiKeyEnv, QUOTA_REASON.NO_CREDENTIAL, `凭据 ${plan.apiKeyEnv} 未配置:在「模型」页填入它(或设同名环境变量)后重启一次 DSH`)]
      }
      try {
        const payload = provider === QUOTA_PROVIDERS.COMMANDCODE
          ? await readCommandCode(plan.apiKeyEnv, credential)
          : await readOpencodeGo(plan.apiKeyEnv, credential)
        return [provider, payload]
      } catch (error) {
        const reason = error?.quotaReason ?? QUOTA_REASON.ERROR
        return [provider, unavailableSource(provider, plan.apiKeyEnv, reason, text(error), credential.source)]
      }
    }))

    const next = new Map(payloads)
    for (const [provider, payload] of settled) {
      const previous = next.get(provider)
      if (previous !== undefined && previous.status !== payload.status) {
        note(`auto: 额度来源 ${provider} ${previous.status} → ${payload.status}${payload.status === 'unavailable' && payload.reason ? `(${payload.reason})` : ''}`)
      }
      next.set(provider, payload)
    }
    payloads = next
    checkedAt = nowOf()
  }

  /** 同步读快照(永不抛):`providers` 是当前链上的 provider 名(按链顺序)。 */
  function snapshot(providers) {
    const sources = []
    for (const provider of supportedOf(providers)) {
      const payload = payloads.get(provider)
      if (payload !== undefined) sources.push({ ...payload })
    }
    const base = {
      // 坏时钟(NaN/越界)下 `toISOString()` 会抛 RangeError ⇒ 用 isoOf/ageOf 兜住,
      // "快照永不抛"这条对坏时钟也必须成立。
      checkedAt: isoOf(checkedAt),
      ageMs: ageOf(checkedAt),
      ttlMs: config.ttlMs,
      timeoutMs: config.timeoutMs,
      inFlight: refreshing !== null,
      sources,
    }
    if (config.enabled === false) return { state: 'disabled', ...base, sources: [] }
    if (!Number.isFinite(checkedAt)) return { state: 'pending', ...base }
    const age = nowOf() - checkedAt
    return { state: Number.isFinite(age) && age <= config.ttlMs ? 'fresh' : 'stale', ...base }
  }

  /**
   * **绕过 TTL 只刷指定的几家**(0.8.0 起;路由侧"确认某家是不是真耗尽"的补查用)。
   *
   * 与 `touch()` 的三点不同:① **不看 TTL**,调用方说要查就查;② **只查指定的几家**,
   * 不动别的来源;③ **不占 `lastAttemptAt`** —— 它不该把正常的面板 TTL 周期整体推后。
   *
   * 三条硬保证(与 `touch()` 同口径,回归测试里逐条钉住):
   *  · Promise **永不 reject**(失败已经变成 unavailable 记录);
   *  · **单飞**:同一组在飞的强制刷新只有一次(并发/连点不会打出多轮上游请求);
   *  · **失败不污染其它来源**:刷新失败(断网/超时/形状不认)只会把那一家写成 unavailable
   *    (上一次成功的数字不再保留,与 `touch()` 一致 —— 观测层不缓存过期结论),
   *    且绝不会把别的来源的既有快照挤掉。
   * @param providers - 要强制刷新的 provider 名(单家传 `[name]` 即可;不认识的会被忽略)。
   * @returns Promise<void>。
   */
  function forceRefresh(providers) {
    if (config.enabled === false) return Promise.resolve()
    const wanted = supportedOf(providers)
    if (wanted.length === 0) return Promise.resolve()
    const key = wanted.join('\u0000')
    const pending = forcing.get(key)
    if (pending !== undefined) return pending
    // ⚠ **不 await** 正在跑的 TTL 刷新:强制刷新已经绕开了 TTL,还要等"整链刷新先跑完"
    //   就等于把 TTL 语义偷偷加回来(最坏要等满一次超时窗口,而冷却补查是 fire-and-forget)。
    //   两者都只做"并入"而不是"整体替换",所以并发跑也不会互相丢结果。
    const run = refresh(wanted).catch((error) => note(`auto: 额度强制刷新失败 —— ${text(error)}`))
    const guarded = run.then(() => {
      if (forcing.get(key) === guarded) forcing.delete(key)
    })
    forcing.set(key, guarded)
    return guarded
  }

  /** 按 TTL 触发一次后台刷新;返回的 Promise 永不 reject(失败已经变成 unavailable 记录)。 */
  function touch(providers) {
    if (config.enabled === false) return Promise.resolve()
    const wanted = supportedOf(providers)
    if (wanted.length === 0) return Promise.resolve()
    if (refreshing !== null) return refreshing
    const at = nowOf()
    // ⚠ 时钟回退(NTP 校正 / 虚拟机恢复)时 `at - lastAttemptAt` 恒为负 ⇒ 旧写法会让 TTL 闸门
    //   永不通过、刷新从此冻住。回退就当作"可以刷"。
    const elapsed = at - lastAttemptAt
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < config.ttlMs) return Promise.resolve()
    lastAttemptAt = at
    refreshing = refresh(wanted)
      .catch((error) => note(`auto: 额度刷新失败 —— ${text(error)}`))
      .then(() => {
        refreshing = null
      })
    return refreshing
  }

  /** 时间戳 → 距现在多少毫秒;坏值给 null(不用 0 假装"刚好")。 */
  function ageOf(at) {
    if (!Number.isFinite(at)) return null
    const now = nowOf()
    return Number.isFinite(now) ? Math.max(0, now - at) : null
  }

  /** 节流日志:只有状态翻转与真异常才出声,正常请求零日志(与插件其它部分同风格)。 */
  function note(message) {
    if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
  }

  return { snapshot, touch, forceRefresh }
}

/** 取 CC 的两档窗口(形状不对就少给,不编数)。 */
function pickCommandCodeWindows(windowLimits) {
  const windows = {}
  if (windowLimits === null || typeof windowLimits !== 'object') return windows
  const pairs = [['fiveHour', 'fiveHour'], ['weekly', 'weekly']]
  for (const [key, name] of pairs) {
    const window = windowLimits[key]
    if (window === null || typeof window !== 'object') continue
    // "不知道"一律表达成**字段缺席**(与 credits 同口径),不留 null 占位、更不填 0。
    windows[name] = finiteOnly({
      used: numberOrNull(window.used),
      cap: numberOrNull(window.cap),
      exceeded: window.exceeded === true,
      resetAt: numberOrNull(window.resetAt),
    })
  }
  return windows
}

/** 取 CC 的套餐身份(次要接口;形状不对就给 null,不影响整源 ok)。 */
function pickCommandCodePlan(body) {
  const data = body !== null && typeof body === 'object' ? body.data : undefined
  if (data === null || typeof data !== 'object') return null
  return {
    planId: typeof data.planId === 'string' ? data.planId : null,
    status: typeof data.status === 'string' ? data.status : null,
    currentPeriodEnd: typeof data.currentPeriodEnd === 'string' ? data.currentPeriodEnd : null,
    cancelAtPeriodEnd: data.cancelAtPeriodEnd === true,
    endedAt: typeof data.endedAt === 'string' ? data.endedAt : null,
  }
}

/** 有限数原样、其余给 null(绝不用 0 顶替"不知道")。 */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

/**
 * 去掉值为 null/undefined 的键(把"不知道"表达成**字段缺席**,而不是 0 或 null 占位)。
 * @param source - 候选字段表。
 * @returns 只剩有值字段的新对象。
 */
function finiteOnly(source) {
  const out = {}
  for (const [key, value] of Object.entries(source)) if (value !== null && value !== undefined) out[key] = value
  return out
}

/**
 * 时间戳 → ISO 串;坏时钟(NaN / 越界)时给 null,**绝不抛**。
 * @param at - 毫秒时间戳(可为 null/NaN)。
 * @returns ISO 串或 null。
 */
function isoOf(at) {
  if (!Number.isFinite(at)) return null
  try {
    return new Date(at).toISOString()
  } catch {
    return null
  }
}

/** 错误 → 可读一行(不回显请求头,永不打印凭据值)。 */
function text(error) {
  return String(error?.message ?? error)
}
