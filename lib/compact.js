/**
 * dsh-llm-auto —— 「把自动压缩点钉在指定 token 数附近」的反算式与配置解析。
 *
 * 纯函数模块:不 import 任何 Harness 运行时(也不 import schemastery),
 * 便于 `node --test` 直接覆盖。这里只做「token 数 ↔ 声明窗口」的算术与配置取舍,不做 I/O。
 *
 * ## 为什么需要这一层
 *
 * DSH 自带的自动压缩引擎 `@deepseek-ai/dsh-compaction-basic` **不看真实上游窗口**,
 * 只用"该请求声明的上下文窗口"算阈值(`resolveCompactSpec`,该包 lib/index.js:124-147):
 *
 * ```
 * threshold = floor(min( contextWindow × thresholdRatio,
 *                        contextWindow − reserved − headroomTokens ))
 * ```
 *
 *  · `thresholdRatio` 默认 0.8(`DEFAULT_THRESHOLD_RATIO`,同文件:15);
 *  · `headroomTokens` 默认 65536(`resolveConfig` 的 `config.headroomTokens ?? 65536`,同文件:63);
 *  · `reserved` = 请求头 `config.maxTokens` ?? 适配器声明的 `defaultMaxTokens` ?? 0
 *    (`reservedCompletionTokens`,同文件:756-758)。
 *
 * 本插件的 `resolveModel` 既不声明 `defaultMaxTokens`、调用方也不带 `maxTokens` ⇒ `reserved = 0`,
 * 于是 `threshold = floor(min(cw × 0.8, cw − 65536))`。
 *
 * 反过来解:想让压缩**正好**落在 T,需要 `cw × 0.8 ≥ T` 且 `cw − 65536 ≥ T`:
 *
 * ```
 * cw = max(ceil(T × 1.25), T + 65536)      // 见 declaredWindowForCompactPoint
 * ```
 *
 * 例:T = 500000 ⇒ cw = 625000(0.8 × 625000 = 500000;625000 − 65536 = 559464 > 500000,min 取前者)。
 *
 * ## 两条附带约束(引擎里的硬校验,越界会抛 `TargetPressureConfigError`)
 *
 *  1. 保留尾部 `retainTokens = floor((cw − reserved) × retainRatio)`(retainRatio 默认 0.16,
 *     同文件:17)必须**严格小于** `threshold`,否则每轮抛
 *     `retainTokens (...) must be less than threshold tokens ...`(同文件:134)。
 *     T 太小时 `floor(0.16 × (T + 65536))` 会顶到 T ⇒ 见 {@link minimumUsableCompactWindow}。
 *  2. `retainRatio ≥ thresholdRatio` 会在**加载配置时**直接拒绝整块 compaction-basic 配置
 *     (同文件:155-157),与本插件的 T 无关 —— 这里只提示,不改别人的配置。
 *
 * ## 这些假设是"可验算的假设",不是公理
 *
 * 三个常量(0.8 / 65536 / 0.16)抄自引擎源码:引擎换版本、或使用者把 compaction-basic 的
 * `thresholdRatio` / `headroomTokens` 改成别的值,映射就不再精确。所以:
 *
 *  · 挂载日志会把假设随映射结果一起打出来(`lib/index.js` 的 `describeWindowPlan()`,内建 `auto: 压缩点 500000 → 声明窗口 625000(假设 …)`
 *    的格式),事后能从日志倒推当时用的是哪套假设;
 *  · {@link compactThresholdFor} 逐行复刻引擎那段算式,测试用它验算"映射出的窗口真能把阈值钉在 T"。
 */

/** 压缩阈值占声明窗口的比例(引擎 `DEFAULT_THRESHOLD_RATIO`)。 */
export const COMPACT_THRESHOLD_RATIO = 0.8
/** 窗口里给压缩本身预留的余量 token(引擎 `headroomTokens` 默认值)。 */
export const COMPACT_HEADROOM_TOKENS = 65536
/** 压缩后原样保留的尾部比例(引擎 `DEFAULT_RETAIN_RATIO`)。 */
export const COMPACT_RETAIN_RATIO = 0.16
/**
 * `compactWindow` 的默认值(压缩点,token)。
 *
 * 500000 不是随手取的:本机 auto 链的四跳「窗口/输出上限」= 884000/384000、1024000/65536、
 * 884000/256000、884000/384000 ⇒ 全链最紧的**可用输入预算** = 884000 − 384000 = 500000。
 * 压缩点落在这里,等于"用满最紧那一跳的输入预算再压缩"。
 */
export const DEFAULT_COMPACT_WINDOW = 500000

/** 声明窗口的取值来源(优先级从高到低,见 {@link planDeclaredWindow})。 */
export const WINDOW_SOURCE = Object.freeze({
  /** 由 `config.compactWindow` 反算(默认口径:宿主里 schema 总会给这个键补默认值)。 */
  COMPACT_WINDOW: 'compactWindow',
  /** 由旧键 `config.contextWindow` 直接声明。 */
  CONTEXT_WINDOW: 'contextWindow',
  /** 都没配:交给调用方逐跳解析(取第一条可解析路由的窗口,取不到回落 65536)。 */
  ROUTES: 'routes',
})

/** cosmokit 的 volatile 引用标记(ESM/CJS 两份拷贝共用同一个 Symbol)。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 读出配置字段的真实值。
 *
 * ⚠ **宿主里凡是 `.volatile()` 声明的字段,拿到的都不是值本身**,而是 cosmokit 的
 * `Volatile` 引用(`createVolatile()` 返回 `{ get, [write] }`,见 cosmokit `src/volatile.ts`);
 * schemastery 在 `Schema.resolve` 里对 `meta.volatile` 的字段套上它(`src/index.ts:521-530`)。
 * 所以插件读 `config.compactWindow` 必须解包,否则会拿到一个对象去做算术。
 *
 * 用 `Symbol.for()` 而不是 `import cosmokit` 判定:与官方 `isVolatile()` 同一口径,
 * 但不必为一个标记位引入依赖。非引用值(直接调用 `apply()` 的单测、非 volatile 字段)原样返回。
 *
 * @param value - `config.<key>` 的原始值(可能是 Volatile 引用)。
 * @returns 真实值(引用缺失时为 undefined)。
 */
export function unwrapVolatile(value) {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value && typeof value.get === 'function') return value.get()
  return value
}

/** 是不是"可用的正整数配置值"。 */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/** 把配置值渲染成日志里可读的一小段(字符串加引号,便于分辨 `"4096"` 与 `4096`)。 */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组(${value.length} 项)`
  if (typeof value === 'object') return '对象'
  return String(value)
}

/**
 * 把一个"压缩点"反算成应当对外声明的上下文窗口。
 *
 * `cw = max(ceil(T × 1.25), T + 65536)`。max 两项的胜出关系(逐点实测,262144 不是严格
 * 意义上的切换点):T ≤ 262140 时 headroom 项(T + 65536)严格更大;T = 262141~262144 时
 * 两项**完全相等**(1.25T 经 ceil 正好顶到 T + 65536);T ≥ 262145 起比例项 ceil(T × 1.25)
 * 才严格胜出。落到引擎 `min()` 上:T ≤ 262144 时 headroom 分支 cw − 65536 恰等于 T
 * (仅 T = 262144 两个分支相等),T ≥ 262145 时比例分支 cw × 0.8 落在 [T, T + 0.8) ——
 * 三种情形 floor 后都是 T。
 *
 * 用 `ceil(T × 5 / 4)` 而不是 `ceil(T / 0.8)`:两者在本插件关心的量级上实测等价(1 万~300 万
 * 逐点比对无差异),但 `0.8` 在 IEEE754 里不是精确值,除法会把那个误差带进算式;写成乘 5 除 4
 * 就没有"差一"的空间 —— 这里的 ±1 直接决定压缩点在 500000 还是 499999。
 *
 * @param compactPoint - 期望的压缩点(token),正整数。
 * @returns 应当声明的上下文窗口(token,正整数)。
 * @throws {TypeError} `compactPoint` 不是正整数时(编程错误,不是配置错误 —— 配置错误在
 *   {@link planDeclaredWindow} 里被 warn 兜住,不会走到这里)。
 */
export function declaredWindowForCompactPoint(compactPoint) {
  if (!isPositiveInteger(compactPoint)) throw new TypeError(`declaredWindowForCompactPoint: 需要正整数,收到 ${describeValue(compactPoint)}`)
  return Math.max(Math.ceil((compactPoint * 5) / 4), compactPoint + COMPACT_HEADROOM_TOKENS)
}

/**
 * 复刻引擎的阈值算式,用于**验算**映射结果(测试与排查用,插件运行时不依赖它)。
 *
 * @param contextWindow - 该请求声明的上下文窗口(正整数)。
 * @param reservedCompletionTokens - 该请求预留的输出 token(本插件恒为 0,见模块注释)。
 * @returns `floor(min(cw × 0.8, cw − reserved − 65536))`。
 */
export function compactThresholdFor(contextWindow, reservedCompletionTokens = 0) {
  return Math.floor(Math.min(contextWindow * COMPACT_THRESHOLD_RATIO, contextWindow - reservedCompletionTokens - COMPACT_HEADROOM_TOKENS))
}

/**
 * 复刻引擎的"保留尾部"算式(验算用)。
 * @param contextWindow - 声明窗口。
 * @param reservedCompletionTokens - 预留输出 token。
 * @returns `floor((cw − reserved) × 0.16)`。
 */
export function compactRetainFor(contextWindow, reservedCompletionTokens = 0) {
  return Math.floor((contextWindow - reservedCompletionTokens) * COMPACT_RETAIN_RATIO)
}

/**
 * 压缩点的**最小可用值**:比它小的 T 会让引擎每轮抛 `TargetPressureConfigError`。
 *
 * 推导(不是拍脑袋的常量):T ≤ 262144 时声明窗口恒为 T + 65536(262141~262144 两分支
 * 同值,取到的仍是它)、阈值恰为 T,而引擎要求 `floor(0.16 × (T + 65536)) < T`,解出
 * `T > 0.16 × 65536 ÷ 0.84 = 12483.05` ⇒ 最小整数 12484。T = 12483 时
 * `floor(0.16 × 78019) = 12483 ≥ 12483` ⇒ 抛错。
 *
 * @returns 最小可用压缩点(12484)。
 */
export function minimumUsableCompactWindow() {
  const boundary = (COMPACT_RETAIN_RATIO * COMPACT_HEADROOM_TOKENS) / (1 - COMPACT_RETAIN_RATIO)
  return Math.floor(boundary) + 1
}

/**
 * 解析「对外声明的上下文窗口」该怎么取 —— 本插件唯一的窗口口径决策点。
 *
 * 优先级(同名键"给出"= 键存在且非 null;**宿主里 schema 总会给 `compactWindow` 补默认值
 * 500000,所以宿主的默认口径就是映射**:声明 625000、压缩点 500000):
 *
 * ```
 * 1. compactWindow(正整数)  → 反算声明窗口(默认 500000 ⇒ 625000)
 * 2. contextWindow(正整数)  → 直接声明(旧键,显式声明窗口的逃生门)
 * 3. 逐跳解析                → 第一条可解析路由的窗口
 * 4. 兜底 65536
 * ```
 *
 * 1 与 2 同时给出 ⇒ 用 1、忽略 2,并打一条 warn 说明用了哪个、忽略了哪个。
 * `compactWindow` 给出但非法(非正整数)⇒ warn 后**回落默认值 500000**(遵循本插件既有约定:
 * 配置错误只 warn,不让宿主起不来),此时 `contextWindow` 仍按"1 胜出"被忽略。
 *
 * @param config - 插件配置(`apply()` 收到的那个;字段可能是 volatile 引用,内部会解包)。
 * @returns `{ compactPoint, declaredContextWindow, source, warnings }`;
 *   `source === 'routes'` 时两个数值都是 null(表示"交给调用方逐跳解析")。
 */
export function planDeclaredWindow(config = {}) {
  const warnings = []
  const rawCompact = unwrapVolatile(config.compactWindow)
  const rawContext = unwrapVolatile(config.contextWindow)
  const compactGiven = rawCompact !== undefined && rawCompact !== null
  const contextGiven = rawContext !== undefined && rawContext !== null

  if (compactGiven) {
    const valid = isPositiveInteger(rawCompact)
    const compactPoint = valid ? rawCompact : DEFAULT_COMPACT_WINDOW
    if (!valid) {
      warnings.push(
        `dsh-llm-auto: compactWindow 应为正整数(压缩点 token 数),实际是 ${describeValue(rawCompact)}`
        + ` —— 回落默认 ${DEFAULT_COMPACT_WINDOW}(声明窗口 ${declaredWindowForCompactPoint(DEFAULT_COMPACT_WINDOW)})`,
      )
    }
    if (contextGiven) {
      const because = isPositiveInteger(rawContext)
        ? `contextWindow(${rawContext})`
        : `contextWindow(${describeValue(rawContext)},本来也不是正整数)`
      warnings.push(
        `dsh-llm-auto: compactWindow 与 contextWindow 同时给出 —— 用 compactWindow(${compactPoint} ⇒ 声明窗口 ${declaredWindowForCompactPoint(compactPoint)}),忽略 ${because}`,
      )
    }
    if (compactPoint < minimumUsableCompactWindow()) {
      const declared = declaredWindowForCompactPoint(compactPoint)
      warnings.push(
        `dsh-llm-auto: compactWindow ${compactPoint} 偏小 —— 压缩引擎要求"保留尾部 < 阈值":`
        + `保留尾部 floor(0.16 × ${declared}) = ${compactRetainFor(declared)} ≥ 阈值 ${compactPoint};`
        + `T < ${minimumUsableCompactWindow()} 时 @deepseek-ai/dsh-compaction-basic 每轮抛 TargetPressureConfigError`
        + `(它捕获取消该目标:第一次 warn,之后静默跳过压缩、回合照常继续 ⇒ 净效果是"压缩从不发生")`
        + ` —— 建议取 ≥ ${minimumUsableCompactWindow()}`,
      )
    }
    return {
      compactPoint,
      declaredContextWindow: declaredWindowForCompactPoint(compactPoint),
      source: WINDOW_SOURCE.COMPACT_WINDOW,
      warnings,
    }
  }

  if (isPositiveInteger(rawContext)) {
    return { compactPoint: null, declaredContextWindow: rawContext, source: WINDOW_SOURCE.CONTEXT_WINDOW, warnings }
  }

  return { compactPoint: null, declaredContextWindow: null, source: WINDOW_SOURCE.ROUTES, warnings }
}

/**
 * 把窗口方案渲染成挂载日志的一行。
 *
 * 映射那一支会把**所依赖的假设**一并打出来 —— 常量抄自引擎源码,引擎换版本后这行日志
 * 是唯一能倒推"当时按哪套假设反算"的证据:
 *
 * ```
 * auto: 压缩点 500000 → 声明窗口 625000(假设 compaction-basic thresholdRatio 0.8 / headroomTokens 65536)
 * ```
 *
 * @param plan - {@link planDeclaredWindow} 的结果。
 * @param fallbackWindow - `source === 'routes'` 时的兜底窗口(本插件常量 65536)。
 * @returns 一行中文描述。
 */
export function describeWindowPlan(plan, fallbackWindow) {
  if (plan.source === WINDOW_SOURCE.COMPACT_WINDOW) {
    return `auto: 压缩点 ${plan.compactPoint} → 声明窗口 ${plan.declaredContextWindow}`
      + `(假设 compaction-basic thresholdRatio ${COMPACT_THRESHOLD_RATIO} / headroomTokens ${COMPACT_HEADROOM_TOKENS})`
  }
  if (plan.source === WINDOW_SOURCE.CONTEXT_WINDOW) {
    const cw = plan.declaredContextWindow
    // cw ≤ headroom 时引擎的 pressure budget ≤ 0,连压缩阈值都算不出来(直接抛 TargetPressureConfigError)
    const pressure = cw > COMPACT_HEADROOM_TOKENS ? `压缩点 ${compactThresholdFor(cw)}` : `比 headroomTokens(${COMPACT_HEADROOM_TOKENS})还小 ⇒ 压缩引擎的 pressure budget ≤ 0,每轮抛 TargetPressureConfigError`
    return `auto: 声明窗口 ${cw}(来自 contextWindow,未启用压缩点映射)→ ${pressure}`
  }
  return `auto: 未配置 compactWindow/contextWindow —— 声明窗口取第一条可解析路由的窗口,取不到回落 ${fallbackWindow}`
}
