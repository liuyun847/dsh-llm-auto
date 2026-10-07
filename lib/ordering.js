/**
 * dsh-llm-auto v0.8.0 —— 额度感知的「自动排序 + 耗尽冷却」。
 *
 * 干什么:把「实际尝试顺序」从"配置里怎么排就怎么试"改成**按订阅到期时间自动决定**,
 * 并在某一跳因窗口额度耗尽被拒(`code === 'QUOTA'`)时,**暂时跳过**它、到重置时刻自动恢复。
 *
 * 纯模块:零 harness 依赖,不 import 任何东西,也不碰 I/O —— 额度快照、冷却表、时钟、
 * 模式全部由调用方注入,所以 `node --test` 能直接覆盖(见 test/ordering.test.mjs)。
 * 查询额度本身不在本模块(那是 lib/quota.js 的活),这里只**读**查询结果。
 *
 * ── 三桶排序(§3.1) ──────────────────────────────────────────────────────────
 *  1. `monthly-reset-asc` —— 已知月度重置时刻的订阅条目,按该时刻**升序**;
 *  2. `unknown`           —— 查不到 / 形状不认的条目,按配置顺序;
 *  3. `never-expires`     —— 按量兜底(无窗口概念、永不过期),按配置顺序,**永远最后**。
 * 桶内**保持配置顺序**(稳定排序),且**不改 `routes` 配置本身** —— 排序只发生在每次请求的
 * 现场副本上。
 *
 * 为什么用月度重置而不是 5h/周窗口的重置点:后者是速率闸门,按它排会每几小时抖一次。
 * 为什么"按量永远最后":它永不过期 ⇒ 拿它当首选等于每次都按量付费。
 *
 * ── 冷却(§3.2) ─────────────────────────────────────────────────────────────
 *  · 触发是**反应式**的:只在真的看到 `QUOTA` 失败后才动作,不做请求前预判;
 *  · 粒度是 **provider**(额度是账号级的)⇒ 同一家所有条目一起冷;
 *  · 终点是**被耗尽的那几档里最晚的重置时刻**(多档同时打满要等最晚那档解开);
 *  · 恢复**不用定时器**:每次重算时 `now >= until` 自然解除;
 *  · 兜底:过滤后一条都不剩时**忽略冷却**(按量不参与冷却,理论上不会发生;这里防的是
 *    "全被冷却 ⇒ 假故障「链已用尽」");
 *  · 失败处理是 **fail-open**:补查失败(断网/超时/形状不认)**不冷却** —— 宁可下次白撞,
 *    也不能因为一次查不到就误伤一条其实能用的订阅。判定"要不要冷却"的合成判据就是本模块的
 *    {@link cooldownUntilOf}(`isExhausted` + `exhaustedUntil`),宿主只调它一个。
 *
 * 不落盘:冷却表是进程内 Map,重启重算。最坏白撞一次,而 `QUOTA` 不在重试白名单里
 * ⇒ 代价只是一次失败往返。
 */

/** 排序模式。`auto` = 本模块的规则;`manual` = 完全回到 0.7.0 行为(严格按配置顺序)。 */
export const ORDERING_MODE = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
})

/** 缺省配置(全部可省;坏值只 warn 并回落这里)。 */
export const DEFAULT_ORDERING_CONFIG = Object.freeze({
  mode: ORDERING_MODE.AUTO,
})

/**
 * 三个桶的名字。**顺序即优先级**(拼接时按这个顺序)。
 *
 * 面板与端点用的 `reason` 就是这几个字符串(§7:端点 `effective[].reason`
 * 取值 `monthly-reset-asc | unknown | never-expires`,冷却中的条目额外带 `cooling: true`)。
 */
export const ORDER_BUCKETS = Object.freeze([
  'monthly-reset-asc',
  'unknown',
  'never-expires',
])

/**
 * 本模块认识的两家订阅 provider id —— 与 lib/quota.js 的 `QUOTA_PROVIDERS` 逐字一致。
 *
 * 这里**刻意不 import** lib/quota.js:那个模块要注入 fetch/凭据,而本模块要能在
 * 最干净的环境里直测(零 import);两家 id 是稳定契约,重复两个字符串比引入依赖划算。
 */
const COMMANDCODE = 'commandcode'
const OPENCODE_GO = 'opencode-go'

/**
 * 解析并校验 `config.ordering`。
 *
 * 口径与包内其它配置一致(见 lib/quota.js / lib/routes.js):**这里**只 warn 并回落默认。
 * schema 那一层同样是宽松的(union + `z.any` 兜底,见 lib/index.js 的 `Config`)——
 * 两层加起来才是"坏值不让整行插件加载失败"这条约定(0.6.0 的教训:坏值一度让整行起不来)。
 * @param raw - `config.ordering` 原始值(可省)。
 * @returns `{ config, warnings }`;`config` 已填满默认值且形状固定。
 */
export function normalizeOrdering(raw) {
  const warnings = []
  if (raw === undefined || raw === null) return { config: { ...DEFAULT_ORDERING_CONFIG }, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('auto: 排序配置(ordering)应为对象,已回落默认')
    return { config: { ...DEFAULT_ORDERING_CONFIG }, warnings }
  }
  const config = { ...DEFAULT_ORDERING_CONFIG }
  if (raw.mode === undefined || raw.mode === null) return { config, warnings }
  if (raw.mode === ORDERING_MODE.AUTO || raw.mode === ORDERING_MODE.MANUAL) {
    config.mode = raw.mode
    return { config, warnings }
  }
  warnings.push(`auto: ordering.mode 只支持 ${ORDERING_MODE.AUTO} / ${ORDERING_MODE.MANUAL},实际是 ${JSON.stringify(raw.mode)} —— 已回落 ${ORDERING_MODE.AUTO}`)
  return { config, warnings }
}

/**
 * 把任意输入收成一个模式名(不认识的回落 `auto`,与 {@link normalizeOrdering} 同口径)。
 * @param mode - 候选模式。
 * @returns `auto` 或 `manual`。
 */
export function normalizeMode(mode) {
  return mode === ORDERING_MODE.MANUAL ? ORDERING_MODE.MANUAL : ORDERING_MODE.AUTO
}

/**
 * 时间戳:数字原样(非有限数给 null)、ISO 串解析成毫秒、其它给 null。
 *
 * ⚠ 两种口径都要吃:Command Code 的 `windowLimits.*.resetAt` 是**毫秒时间戳**,
 * OpenCode Go 的 `resetsAt` 与套餐的 `currentPeriodEnd` 是 **ISO 串**。写死一种就会让
 * 一家永远排不进去(静默退回配置顺序)。
 * @param value - 毫秒数或 ISO 串。
 * @returns 毫秒时间戳或 null。
 */
export function timestampOf(value) {
  if (Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.length === 0) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/**
 * 时间戳 → ISO 串;坏值(NaN / 越界 / Infinity)给 null,**绝不抛**。
 * @param at - 毫秒时间戳。
 * @returns ISO 串或 null。
 */
export function isoOf(at) {
  if (!Number.isFinite(at)) return null
  try {
    return new Date(at).toISOString()
  } catch {
    return null
  }
}

/**
 * 额度快照 → 某个 provider 的来源记录(只认**自己的属性**,不吃原型链)。
 *
 * @param quota - `GET /api/llm-auto/routes` 响应里的 `quota`(或 `snapshot()` 的返回值)。
 * @param provider - provider id。
 * @returns 该来源的记录,或 undefined(快照坏形状 / 该家不在快照里)。
 */
export function quotaSourceOf(quota, provider) {
  if (quota === null || typeof quota !== 'object') return undefined
  const sources = quota.sources
  if (!Array.isArray(sources) || typeof provider !== 'string' || provider.length === 0) return undefined
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    // ⚠ `provider` 键缺席时**不能**拿 `source.provider` 去比(undefined 会匹配上任何非字符串候选);
    //   索引兜底用 `Object.prototype.hasOwnProperty` 而不是直接取,免得命中原型上的函数。
    const id = typeof source.provider === 'string' ? source.provider : undefined
    if (id !== undefined) {
      if (id === provider) return source
      continue
    }
    if (Object.prototype.hasOwnProperty.call(source, provider)) return source[provider]
  }
  return undefined
}

/**
 * 一档窗口是不是"已耗尽"。
 *
 * 两家用**同一个判据**:上游把耗尽的档标成 `status: 'rate-limited'`(OpenCode Go 的三档如此),
 * Command Code 则用布尔 `exceeded: true`(5h 窗 / 周窗;`windowLimits.exceeded` 是聚合位)。
 * `percent === 100` **不算**耗尽 —— 上游在服务端把百分比硬编码成 100 而不改 status 时语义不明,
 * 宁可漏判(下次白撞一次)也不要误判(白白冷掉一条其实能用的订阅)。
 * @param window - 一档窗口记录。
 * @returns 耗尽为 true。
 */
export function isExhaustedWindow(window) {
  if (window === null || typeof window !== 'object') return false
  return window.status === 'rate-limited' || window.exceeded === true
}

/**
 * 该来源当前是否**任一档**耗尽(含 Command Code 的月度余额 —— 见 {@link exhaustedWindows})。
 * @param source - 来源记录(可省)。
 * @returns 有任意一档耗尽为 true。
 */
export function isExhausted(source) {
  return exhaustedWindows(source).length > 0
}

/**
 * 该来源里所有处于耗尽态的那几档(顺序 = `windows` 的键序,稳定;**另外含合成的那一档**,见下)。
 *
 * Command Code 的月度额度是**余额**(`credits.*`)而不是窗口,设计档 §3.2 决策 4 把"三档窗口都看"
 * 的第三条臂落在它身上 ⇒ 这里为它合成一条记录(`id === CREDITS_WINDOW_ID`),与真实窗口记录同列。
 * @param source - 来源记录(可省)。
 * @returns 窗口记录数组(可能含合成档);没有则空数组。
 */
export function exhaustedWindows(source) {
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return []
  const out = []
  const windows = source.windows
  if (windows !== null && typeof windows === 'object') {
    for (const key of Object.keys(windows)) {
      if (isExhaustedWindow(windows[key])) out.push(windows[key])
    }
  }
  // §3.2 决策 4 的**第三条臂**:Command Code 的月度额度是**余额**(`credits.*`),不在 `windows`
  // 里,但它同样"见底即耗尽"。合成一档并进来:`exhaustedUntil` 在它身上找不到 resetAt/resetsAt,
  // 于是退到该家的月度重置时刻(套餐 `currentPeriodEnd`)—— 正好就是它的终点;连它也没有
  // ⇒ 终点未知 ⇒ 不冷却(fail-open,别硬编一个时间)。
  if (isCreditsExhausted(source)) out.push({ id: CREDITS_WINDOW_ID, status: 'rate-limited' })
  return out
}

/**
 * 本模块认得的窗口 id(**固定枚举**)—— 端点的 `windows` 与 `createCooldown` 只认这几个字符串。
 *
 * 与两家的档案一一对应:OpenCode Go 的三档(`rolling` / `weekly` / `monthly`)、Command Code 的
 * 5 小时档(`fiveHour`),外加一档**合成**的 `credits`(CC 的月度余额,见 {@link CREDITS_WINDOW_ID})。
 * 要这层映射的理由:端点要把"哪一档打满"给到面板,而面板得把它翻成一句人话 —— 直接把上游的键名
 * 透传上去,等于让上游决定界面上显示什么(它们改个键名,用户就会看到一串英文键)。所以这里
 * **只放行白名单里的 id**,认不出的一律丢掉。
 */
export const WINDOW_IDS = Object.freeze(['rolling', 'fiveHour', 'weekly', 'monthly', 'credits'])

/**
 * Command Code **月度余额**那一档的合成 id(它不是上游的窗口键,是本模块给面板的固定枚举名)。
 *
 * 为什么要有它:CC 的月度额度是"余额池"而不是"窗口",上游只给 `credits.monthly/purchased/free`
 * 这类数字与一个 `belowThreshold` 标志。设计档 §3.2 决策 4 要求把它算作"三档窗口都看"的第三条臂,
 * 于是这里给它起一个自己的名字 —— 端点与冷却表只带这个名字,面板把它翻成「余额已耗尽」。
 */
export const CREDITS_WINDOW_ID = 'credits'

/**
 * 把候选的窗口 id 收敛成固定枚举里的那几个(去重、保序、坏形状不抛)。
 * @param windows - 候选(id 数组;给 `undefined` / 非数组 / 混入坏值都安全)。
 * @returns 干净的 id 数组(可能为空)。
 */
function windowIdsOf(windows) {
  const out = []
  for (const id of Array.isArray(windows) ? windows : []) {
    if (WINDOW_IDS.includes(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 这一家的**月度余额**见底了没有(§3.2 决策 4 的第三条臂)。
 *
 * 两条判据取或:① 上游自己给的 `credits.belowThreshold === true`;
 * ② `credits.monthly` 与 `credits.total` **两个键都在**、且都 `<= 0`(两个都见底才算 —— 充值额度
 * 可结转,单看一个可能误判)。
 * ⚠ 取不到的字段**不带键**(lib/quota.js 的第一条硬规矩:绝不填 0),所以 `undefined` **绝不能**
 * 当成 0:那会把"不知道"说成"用光了",白冷掉一条其实能用的订阅。形状坏 / 该家 unavailable
 * (`status !== 'ok'`)一律 false。
 * @param source - 来源记录(可省)。
 * @returns 见底为 true。
 */
export function isCreditsExhausted(source) {
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return false
  const credits = source.credits
  if (credits === null || typeof credits !== 'object') return false
  if (credits.belowThreshold === true) return true
  if (!Number.isFinite(credits.monthly) || !Number.isFinite(credits.total)) return false
  return credits.monthly <= 0 && credits.total <= 0
}

/**
 * 该来源里处于耗尽态的窗口 **id**(固定枚举,顺序 = {@link WINDOW_IDS};一个都不认得就给空数组)。
 *
 * 判据与 {@link exhaustedWindows} 逐条一致(同一个 `isExhaustedWindow` + 同一条余额判据),区别只是
 * 这里回的是 **id** 而不是窗口记录 —— 冷却表与端点要的是前者(面板拿它查字典)。
 * @param source - 来源记录(可省)。
 * @returns 窗口 id 数组(可能为空)。
 */
export function exhaustedWindowIds(source) {
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return []
  const windows = source.windows !== null && typeof source.windows === 'object' ? source.windows : {}
  const out = []
  for (const id of WINDOW_IDS) {
    if (id === CREDITS_WINDOW_ID) {
      if (isCreditsExhausted(source)) out.push(id)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(windows, id) && isExhaustedWindow(windows[id])) out.push(id)
  }
  return out
}

/**
 * 快照里这一家**本轮真的查到了**没有(`status === 'ok'`)。
 *
 * 路由侧的"算不算查过"就用它:查到 ok 才占长闸门(重置时刻 / 6 小时上界),查不到
 * (断网 / 超时 / 形状不认 / 401)只占**短**闸门(10 分钟)后重试 —— 设计档 §4。
 * ⚠ 判据**不能**写成"Promise 有没有 reject":lib/quota.js 的查询 Promise 永不 reject
 * (失败已经收成 unavailable 记录),那样写等于把失败也当成"查到了"。
 * @param quota - 额度快照。
 * @param provider - provider id。
 * @returns 该家是 ok 为 true。
 */
export function isSourceOk(quota, provider) {
  const source = quotaSourceOf(quota, provider)
  return source !== null && typeof source === 'object' && source.status === 'ok'
}

/**
 * 某 provider 的**月度重置时刻** —— 排序键(§3.1 决策 1)。
 *
 *  · Command Code:套餐的 `currentPeriodEnd`(额度随月度周期回满);
 *  · OpenCode Go:`usage.monthly.resetsAt`(月度档)。
 *
 * ⚠ 刻意**不**看 5h/周窗口:那是速率闸门,按它排会每几小时抖一次顺序。
 * ⚠ 取不到就给 null(调用方据此归进"未知档"),**绝不**用"现在"顶替 —— 那会让它排到最前。
 * @param provider - provider id。
 * @param quota - 额度快照。
 * @returns 毫秒时间戳或 null。
 */
export function monthlyResetOf(provider, quota) {
  const source = quotaSourceOf(quota, provider)
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return null
  if (provider === COMMANDCODE) {
    const plan = source.plan
    if (plan === null || typeof plan !== 'object') return null
    return timestampOf(plan.currentPeriodEnd)
  }
  if (provider === OPENCODE_GO) {
    const monthly = source.windows === null || typeof source.windows !== 'object' ? undefined : source.windows.monthly
    if (monthly === null || typeof monthly !== 'object') return null
    return timestampOf(monthly.resetsAt)
  }
  return null
}

/**
 * 该来源被耗尽后应该冷却到什么时候 —— **被耗尽的那几档里最晚的重置时刻**(§3.2 决策 5)。
 *
 * 多档同时打满时要等**最晚**那档解开,所以取 max 而不是 min。
 *
 * ⚠ 调用前先看 {@link isExhausted}:本函数只管"冷却到几点",**不负责**判定是否耗尽。
 *   对一家没耗尽的订阅调用它会得到一个没有意义的时间点。
 * ⚠ 一档耗尽但**拿不到重置时刻**(上游改形状)时返回 null:冷却终点未知,当作**不冷却**
 *   (fail-open)。拿"现在 + 兜底时长"编一个终点等于用猜测去摘掉一条可能马上就好的订阅。
 * @param provider - provider id。
 * @param quota - 额度快照。
 * @param now - 当前毫秒时间戳(判据不依赖它;保留形参是为了端点/宿主侧调用方便)。
 * @returns 毫秒时间戳(冷却终点),或 null(终点未知 ⇒ 不该冷却)。
 */
export function exhaustedUntil(provider, quota, now) {
  void now
  const source = quotaSourceOf(quota, provider)
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return null
  const resets = []
  for (const window of exhaustedWindows(source)) {
    for (const name of ['resetAt', 'resetsAt']) {
      const at = timestampOf(window[name])
      if (at !== null) resets.push(at)
    }
  }
  // 一档都没给重置时刻时退一步:用该家的月度重置时刻(CC 的 `currentPeriodEnd` /
  // Go 的月度档 `resetsAt`)。⚠ "CC 的额度在 currentPeriodEnd 回满"是**假设**
  // (见设计档 §10 第 2 条),这里只在"窗口自己没给终点"时才用它兜底 —— 取的是"最晚"
  // 而不是"最早",宁可晚一点解冻(多白撞一次)也不要早解冻(白冷却一轮)。
  if (resets.length === 0) {
    const monthly = monthlyResetOf(provider, quota)
    if (monthly !== null) resets.push(monthly)
  }
  return resets.length === 0 ? null : Math.max(...resets)
}

/**
 * 该 provider **现在该不该冷却** —— 判定 + 终点的合成判据(宿主侧只调这一个)。
 *
 * fail-open 的两条出口都在这里收口:① 快照里查不到这一家、或该家 `status !== 'ok'`
 * (断网 / 超时 / 形状不认)⇒ `isExhausted` 为 false ⇒ **不冷却**;② 确实耗尽但拿不到任何
 * 重置时刻 ⇒ {@link exhaustedUntil} 给 null ⇒ **不冷却**。
 * @param provider - provider id。
 * @param quota - 额度快照(通常是补查**之后**的那一份)。
 * @param now - 当前毫秒时间戳。
 * @returns 毫秒时间戳(冷却终点),或 null(不冷却)。
 */
export function cooldownUntilOf(provider, quota, now) {
  if (!isExhausted(quotaSourceOf(quota, provider))) return null
  return exhaustedUntil(provider, quota, now)
}

/**
 * 一家的额度"长相":订阅 / 按量兜底 / 查不到。
 *
 * 三态的依据:
 *  · `unavailable` 或**快照里没有这家** ⇒ `unknown`(查不到就不猜 —— 猜成"按量"会把它
 *    排在订阅后面,猜成"订阅"又会用一个编造的重置时刻排序);
 *  · 有月度重置时刻 ⇒ `subscription`;
 *  · 认识的一家、但没有任何窗口概念(没有月度重置、也没有耗尽窗口)⇒ `never-expires`
 *    (本机的 `deepseek-official` 就是这一类:按量付费,永不过期,永远排最后)。
 * @param provider - provider id。
 * @param quota - 额度快照。
 * @returns `'subscription' | 'never-expires' | 'unknown'`。
 */
export function providerKind(provider, quota) {
  const source = quotaSourceOf(quota, provider)
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return 'unknown'
  if (monthlyResetOf(provider, quota) !== null) return 'subscription'
  if (exhaustedWindows(source).length > 0) return 'subscription'
  return 'never-expires'
}

/**
 * 一条路由落在哪个桶里 —— 端点 `effective[].reason` 的取值来源(§7)。
 * @param provider - provider id。
 * @param quota - 额度快照。
 * @returns `'monthly-reset-asc' | 'unknown' | 'never-expires'`。
 */
export function reasonOf(provider, quota) {
  if (monthlyResetOf(provider, quota) !== null) return 'monthly-reset-asc'
  return providerKind(provider, quota) === 'never-expires' ? 'never-expires' : 'unknown'
}

/**
 * 冷却表(进程内,不落盘)。
 *
 * 语义:记下"这家冷到什么时候、是被哪一档打满的(§7 的面板要说清这一点)"。**恢复不靠定时器** ——
 * 每次重算时 `now >= until` 就是自动解除,所以时钟回退也不会把它冻住(判据是绝对时刻的一次比较)。
 * @returns `{ mark, until, has, windowsOf, clear, snapshot, size }`。
 */
export function createCooldown() {
  /** @type {Map<string, { until: number, windows: string[] }>} provider → 冷却终点 + 被耗尽的窗口 id。 */
  const table = new Map()
  return {
    /**
     * 记下/更新一家的冷却终点。
     *
     * 坏值(`null` / 非有限数)一律**忽略**:不能用一个编造的终点去摘掉一条能用的订阅。
     * 同一家已有更晚的终点时保留更晚的那个(晚的包含早的)。
     * @param provider - provider id。
     * @param until - 冷却终点(毫秒时间戳)。
     * @param windows - 被耗尽的窗口 id(可省;见 {@link exhaustedWindowIds};认不出的一律丢掉)。
     * @returns 真的记下了为 true。
     */
    mark(provider, until, windows) {
      if (typeof provider !== 'string' || provider.length === 0) return false
      const at = timestampOf(until)
      if (at === null) return false
      const previous = table.get(provider)
      if (previous !== undefined && previous.until >= at) return true
      table.set(provider, { until: at, windows: windowIdsOf(windows) })
      return true
    },
    /**
     * 某家当前是不是在冷却中。
     * @param provider - provider id。
     * @param now - 当前毫秒时间戳(坏时钟 ⇒ 当作不在冷却,宁可白撞一次)。
     * @returns 在冷却中为 true。
     */
    has(provider, now) {
      const record = table.get(provider)
      if (record === undefined || !Number.isFinite(now)) return false
      return now < record.until
    },
    /**
     * 某家的冷却终点(不在冷却中给 null)。
     * @param provider - provider id。
     * @param now - 当前毫秒时间戳。
     * @returns 毫秒时间戳或 null。
     */
    until(provider, now) {
      return this.has(provider, now) ? table.get(provider).until : null
    },
    /**
     * 某家当前冷却是**被哪几档打满**的(不在冷却中给空数组)。
     *
     * 只可能是 {@link WINDOW_IDS} 里的 id(含合成的 `credits`);终点记下了但一档都没认出来时也是
     * 空数组(面板据此退回中性的"额度已耗尽",而不是编一档出来)。
     * @param provider - provider id。
     * @param now - 当前毫秒时间戳。
     * @returns 窗口 id 数组(可能为空)。
     */
    windowsOf(provider, now) {
      if (!this.has(provider, now)) return []
      return [...table.get(provider).windows]
    },
    /**
     * 清掉一家的冷却(手动解冻;或该家额度恢复正常时)。
     * @param provider - provider id。
     * @returns 真的删掉了为 true。
     */
    clear(provider) {
      return table.delete(provider)
    },
    /**
     * 当前冷却表快照(只读口径:已到点/坏终点都不出现)。
     * @param now - 当前毫秒时间戳。
     * @returns `[{ provider, until, windows }]`,按 provider 名排序(稳定输出,便于比对)。
     */
    snapshot(now) {
      const out = []
      for (const [provider, record] of table) {
        if (!Number.isFinite(now) || now >= record.until) continue
        out.push({ provider, until: record.until, windows: [...record.windows] })
      }
      out.sort((left, right) => (left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0))
      return out
    },
    /** 表里的条数(不过滤到点与否;诊断用)。 */
    get size() {
      return table.size
    },
  }
}

/**
 * 一条路由 → 端点 `effective[]` 的条目形状。
 *
 * ⚠ **必须原样带上 `provider` / `model` / 逐条开关**(用展开而不是逐字段抄):适配器直接拿
 * `entries` 当路由链用 —— 少一个 `model`,嵌套调用就会变成 `provider: 'ww', model: undefined`
 * (实测踩过:面板与端点看着都对,真请求全打到不存在的模型上)。
 * 在此之上**追加**只读字段:`label`(与端点既有 `chain[]` 同拼法,面板可直接复用自己那套
 * `splitLabel()`)、`reason`(落哪个桶)、冷却中的 `cooling: true` + `until`(ISO 串)+ `windows`
 * (被耗尽的档,固定枚举 id,见 {@link exhaustedWindowIds})。
 * @param route - 已规范化的路由。
 * @param reason - 该条落在哪个桶里(见 {@link ORDER_BUCKETS})。
 * @param until - 冷却终点(不在冷却中给 null)。
 * @param windows - 被耗尽的窗口 id(可省;见 {@link exhaustedWindowIds})。
 * @returns 端点形状的条目(同时是可用的路由)。
 */
export function effectiveEntry(route, reason, until, windows) {
  const entry = {
    ...route,
    label: `${route.provider}/${route.model}`,
    reason,
  }
  // ⚠ 只有**有效**的终点才写进端点形状:坏值(`Infinity` / `NaN` / 越界)时 `toISOString()`
  // 会抛 `RangeError`,而"端点永不因为坏数据变成 500"是本插件的硬规矩(观测能力不该有能力
  // 影响状态码)。坏终点当作没有终点 ⇒ 该条按"不冷却"放行。
  if (Number.isFinite(until)) {
    const iso = isoOf(until)
    if (iso !== null) {
      entry.cooling = true
      entry.until = iso
      // 被耗尽的那几档(面板据此说"月度已耗尽"/"余额已耗尽")。只写**认得出来**的 id:认不出就
      // 整键缺席,面板退回中性的"额度已耗尽" —— 绝不把上游的原始键名当文案透传出去。
      const ids = windowIdsOf(windows)
      if (ids.length > 0) entry.windows = ids
    }
  }
  return entry
}

/**
 * 算「实际尝试顺序」与三桶归属。
 *
 * **不改入参**:返回的条目是新对象,`routes` 数组本身一个字节都不动(这是"排序不落回配置"的实现)。
 *
 * @param routes - 已规范化的路由链(配置顺序)。
 * @param options - `{ quota, cooldown, now, mode }`:
 *   `quota` 是额度快照(可省);`cooldown` 是 {@link createCooldown} 的产物(可省);
 *   `now` 是毫米时间戳(缺省 `Date.now()`);`mode` 是排序模式(缺省 `auto`)。
 * ⚠ 时钟先规范化(`now` 不是有限数就取 `Date.now()`),再交给 `cooldown.until`:坏时钟绝不能
 * 让某一条"既不在 entries 也不在 skipped"(那等于凭空少试一跳)。
 * @returns `{ mode, entries, buckets, skipped, ignoredCooldown, order }`:
 *   `entries` = **冷却过滤后**的实际尝试顺序(每条带 `reason`);被滤掉的那些在 `skipped` 里
 *   (端点把两者一起投影给面板,带 `cooling`/`until`/`windows` 的才是"被跳过"的);
 *   `buckets` = 三桶的完整归属(**不过滤冷却**,给端点/面板解释"为什么这么排");
 *   `skipped` = 因冷却被滤掉的条目;`ignoredCooldown` = 是否触发了"全冷却 ⇒ 忽略冷却"兜底;
 *   `order` = provider 名的实际顺序(日志与断言用)。
 */
export function buildOrder(routes, options = {}) {
  const chain = Array.isArray(routes) ? routes : []
  const quota = options.quota
  const cooldown = options.cooldown
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const mode = normalizeMode(options.mode)

  const buckets = { 'monthly-reset-asc': [], unknown: [], 'never-expires': [] }
  /** 配置顺序的完整归属(后面要按桶序重排它)。 */
  const assigned = []
  for (const route of chain) {
    const provider = route.provider
    const reason = reasonOf(provider, quota)
    const monthlyReset = reason === 'monthly-reset-asc' ? monthlyResetOf(provider, quota) : null
    const until = cooldown !== undefined && cooldown !== null && typeof cooldown.until === 'function' ? cooldown.until(provider, now) : null
    const windows = until !== null && cooldown !== undefined && cooldown !== null && typeof cooldown.windowsOf === 'function' ? cooldown.windowsOf(provider, now) : []
    const item = { route, provider, reason, monthlyReset, until, windows, cooling: until !== null }
    buckets[reason].push(item)
    assigned.push(item)
  }

  // 桶内保持配置顺序(对 `assigned` 的稳定分桶天然如此),桶序由 ORDER_BUCKETS 决定。
  const ordered = []
  for (const name of ORDER_BUCKETS) ordered.push(...buckets[name])

  // `auto` 模式的排序:只有"桶序 + 订阅桶内按月重置升序"两件事。同桶内**必须稳定**,
  // 否则配置里的次序会被打乱 —— 用户排的顺序只在同桶内有意义,所以它必须被保住
  // (JS 的 sort 自 ES2019 起稳定,同值的两条保持配置顺序)。
  const sortable = mode === ORDERING_MODE.MANUAL ? assigned : ordered
  if (mode === ORDERING_MODE.AUTO) {
    buckets['monthly-reset-asc'].sort((left, right) => left.monthlyReset - right.monthlyReset)
    ordered.length = 0
    for (const name of ORDER_BUCKETS) ordered.push(...buckets[name])
  }

  const kept = []
  const skipped = []
  for (const item of sortable) {
    // ⚠ `manual` 模式**不跳过任何一跳**(§3.3:严格按 `routes` 顺序,不排序、不跳过、不冷却)。
    //   冷却表照旧记录(切换模式回来时立刻生效),但在这里一律不参与过滤 —— 否则
    //   "手动挡"会莫名其妙少一条路由,而且面板还看不出为什么。
    const cooling = mode === ORDERING_MODE.AUTO && item.cooling
    const entry = effectiveEntry(item.route, item.reason, cooling ? item.until : null, cooling ? item.windows : [])
    if (cooling) skipped.push(entry)
    else kept.push(entry)
  }

  // 兜底:一条都不剩时忽略冷却(§3.2)。理论到不了这里(按量不参与冷却),但"全冷 ⇒
  // 假故障「链已用尽」"的代价比"白撞一次"大得多。
  let entries = kept
  let ignoredCooldown = false
  if (mode === ORDERING_MODE.AUTO && kept.length === 0 && skipped.length > 0) {
    ignoredCooldown = true
    entries = sortable.map((item) => effectiveEntry(item.route, item.reason, null))
  }

  return {
    mode,
    entries,
    buckets,
    skipped,
    ignoredCooldown,
    order: entries.map((entry) => entry.provider),
  }
}

// ── 路由侧额度缓存(§4)───────────────────────────────────────────────────────
//
// 面板那份额度快照是"只读观测",按 60 秒 TTL 刷;路由侧另起一份**低频**缓存,有效期到
// "已知的重置时刻"。两者的 TTL 语义**不共用** —— 这里只做"什么时候该去问一次"的节流,
// 真正的查询与解析完全交给 lib/quota.js(fetch + 白名单解析那套),本模块不碰网络。

/** 一次查询结果最多认多久:没有任何"已知重置时刻"可等时的上界(§4 的上界建议 6 小时)。 */
export const DEFAULT_ORDERING_TTL_MS = 6 * 60 * 60 * 1000
/** 查询失败后的重试间隔(§4 的"建议 10 分钟")。 */
export const DEFAULT_ORDERING_RETRY_MS = 10 * 60 * 1000

/**
 * 路由侧的额度查询节流表(纯内存、零网络:只决定"要不要问",不发请求)。
 *
 * 与面板那份的区别:面板那份 `inFlight`/`ttlMs` 是给界面看的观测语义;这一份只回答
 * 「这一家现在该不该去问一次」,而且**有效期跟着额度快照里的重置时刻走**。
 * @param options - `{ now }`(时钟,缺省 `Date.now`;测试注入假钟)。
 * @returns `{ plan, markChecked, markFromQuota }`。
 */
export function createOrderRefresh(options = {}) {
  const nowOf = typeof options.now === 'function' ? options.now : () => Date.now()
  /** provider → `{ attemptedAt, ok, validUntil }`。 */
  const table = new Map()

  /**
   * 记下一次**已完成**的查询。
   *
   * 有效期 = 该家已知重置时刻里**最早**的那个(月度重置会让排序键变化;被耗尽窗口的重置要到点
   * 才能确认恢复),再挂一条上界兜底(防止"没有任何重置时刻可等"时缓存永不过期)。
   * 失败(`ok === false`)一律只记短 TTL(默认 10 分钟)后重试。
   *
   * @param providers - 这一轮查过哪些 provider。
   * @param quota - 查询后的额度快照(用来算有效期)。
   * @param ok - 本轮是否成功(任一来源不可查就算失败)。
   * @param bounds - `{ ttlMs, retryMs }`(可省,取默认)。
   * @returns 每个 provider 的有效期 `{ provider, validUntil }`。
   */
  function markChecked(providers, quota, ok, bounds = {}) {
    const ttlMs = Number.isFinite(bounds.ttlMs) && bounds.ttlMs > 0 ? bounds.ttlMs : DEFAULT_ORDERING_TTL_MS
    const retryMs = Number.isFinite(bounds.retryMs) && bounds.retryMs > 0 ? bounds.retryMs : DEFAULT_ORDERING_RETRY_MS
    const at = nowOf()
    const out = []
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (typeof provider !== 'string' || provider.length === 0) continue
      let validUntil = at + (ok === true ? ttlMs : retryMs)
      if (ok === true) {
        const earliest = earliestResetOf(provider, quota)
        if (earliest !== null && earliest > at && earliest < validUntil) validUntil = earliest
      }
      table.set(provider, { attemptedAt: at, ok: ok === true, validUntil })
      out.push({ provider, validUntil })
    }
    return out
  }

  /**
   * 记下一次**已完成**的查询,`ok` 由**快照本身**判定(见 {@link isSourceOk})—— 宿主侧该用的入口。
   *
   * 为什么不直接 `markChecked(…, true)`:那个 `ok` 说的是"这次调用成功了没有",而查询失败会被
   * lib/quota.js 收成 unavailable 记录(它的 Promise 永不 reject)。写死 `true` 就等于把"断网/
   * 超时/形状不认/401"也当成"查到了",该家于是占满 6 小时上界 —— 设计档 §4 那条"查询失败记一条
   * 短 TTL(10 分钟)后重试"成了死代码。这里**逐家判**:查到 `status === 'ok'` 的占长闸门,
   * 没查到的只占短闸门。
   * @param providers - 这一轮查过哪些 provider。
   * @param quota - 查询**之后**的额度快照。
   * @param bounds - `{ ttlMs, retryMs }`(可省,取默认)。
   * @returns 每个 provider 的有效期 `{ provider, validUntil }`。
   */
  function markFromQuota(providers, quota, bounds = {}) {
    const list = Array.isArray(providers) ? providers : []
    const confirmed = list.filter((provider) => isSourceOk(quota, provider))
    const missing = list.filter((provider) => !isSourceOk(quota, provider))
    return [...markChecked(confirmed, quota, true, bounds), ...markChecked(missing, quota, false, bounds)]
  }

  /**
   * 该不该为这些 provider 发一次查询。
   *
   * 返回值是**两个清单**:`due`(缓存过期/从没查过)与 `fresh`(还在有效期内)。调用方只对
   * `due` 发起查询,查完把结果交给 {@link createOrderRefresh.markChecked}。
   * @param providers - 候选 provider 名(按链顺序;内部去重)。
   * @returns `{ due, fresh, checkedAt, validUntil }`。
   */
  function plan(providers) {
    const at = nowOf()
    const due = []
    const fresh = []
    let earliestValid = null
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (typeof provider !== 'string' || provider.length === 0 || due.includes(provider) || fresh.includes(provider)) continue
      const record = table.get(provider)
      if (record === undefined || !Number.isFinite(record.validUntil) || at >= record.validUntil) {
        due.push(provider)
        continue
      }
      fresh.push(provider)
      if (earliestValid === null || record.validUntil < earliestValid) earliestValid = record.validUntil
    }
    return { due, fresh, checkedAt: table.size === 0 ? null : at, validUntil: earliestValid }
  }

  return { plan, markChecked, markFromQuota }
}

/**
 * 该家"已知的重置时刻里最早的那个"。
 *
 * 口径:只看会改变结论的重置点 —— Command Code 的月度周期末 + 两档窗口的重置;
 * OpenCode Go 的三档窗口重置。取**最早**的那个:到了那一刻,缓存的排序键与被耗尽判定都可能变。
 * @param provider - provider id。
 * @param quota - 额度快照。
 * @returns 毫秒时间戳或 null(一个都拿不到)。
 */
export function earliestResetOf(provider, quota) {
  const source = quotaSourceOf(quota, provider)
  if (source === null || typeof source !== 'object' || source.status !== 'ok') return null
  const resets = []
  const plan = source.plan
  if (plan !== null && typeof plan === 'object') {
    const at = timestampOf(plan.currentPeriodEnd)
    if (at !== null) resets.push(at)
  }
  const windows = source.windows
  if (windows !== null && typeof windows === 'object') {
    for (const key of Object.keys(windows)) {
      const window = windows[key]
      if (window === null || typeof window !== 'object') continue
      for (const name of ['resetAt', 'resetsAt']) {
        const at = timestampOf(window[name])
        if (at !== null) resets.push(at)
      }
    }
  }
  return resets.length === 0 ? null : Math.min(...resets)
}
