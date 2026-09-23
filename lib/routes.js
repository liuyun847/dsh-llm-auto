/**
 * dsh-llm-auto —— 路由链的解析与校验。
 *
 * 纯函数模块:不 import 任何 Harness 运行时,便于 `node --test` 直接覆盖。
 * 这里只做「把 YAML 里的 routes 变成一条可信的有序链」,不做任何 I/O。
 */

/** 本插件注册的 provider 路由名(模型选择器里的分组 id)。 */
export const AUTO_PROVIDER = 'auto'
/** 该路由下唯一的模型 id。 */
export const AUTO_MODEL = 'auto'
/** provider 分组在模型选择器里的显示名。 */
export const AUTO_GROUP_NAME = 'Auto'
/** 模型默认显示名(可用 config.name 覆盖)。 */
export const DEFAULT_MODEL_NAME = 'Auto'
/**
 * 取不到首选路由上下文窗口时的保守值。
 *
 * 取得过小 ⇒ 压缩提前触发(浪费额度但不会失败);取得过大 ⇒ 请求可能撞上游窗口上限。
 * 因此这里选一个"绝大多数现代模型都够得着"的小值,宁可早压缩。
 */
export const DEFAULT_CONTEXT_WINDOW = 65536
/** 路由日志环形缓冲默认容量(条)。 */
export const DEFAULT_LOG_LIMIT = 50

/** 配置结构错误(与"某条路由被跳过"不同:前者必须报错,后者只 warn)。 */
export class RouteConfigError extends Error {
  /** @param message - 可读中文原因。 */
  constructor(message) {
    super(message)
    this.name = 'RouteConfigError'
  }
}

/** 一条路由的可读标签,日志与错误消息共用。 */
export function describeRoute(route) {
  return `${route.provider}/${route.model}`
}

/**
 * 解析并校验 `config.routes`。
 *
 * 语义(与 README「边界」一节逐条对应):
 *  - 结构问题(没配 / 不是数组 / 空数组 / 全部条目都不可用)⇒ 抛 {@link RouteConfigError};
 *  - 单条问题(不是对象 / provider 或 model 不是非空字符串)⇒ 跳过该条并记一条 note;
 *  - 自递归(`provider: auto`)⇒ 跳过该条并记一条 note(运行时拒绝,不在请求路径上才发现);
 *  - 完全重复的 provider+model ⇒ 只保留第一次出现的那条。
 *
 * @param raw - `config.routes` 原始值。
 * @returns `{ routes, skipped }`;`skipped` 每项为 `{ index, reason, label }`(index 从 1 起,与用户写法对齐)。
 * @throws {RouteConfigError} 结构不可用时。
 */
export function normalizeRoutes(raw) {
  if (raw === undefined || raw === null) {
    throw new RouteConfigError('dsh-llm-auto: 缺少 config.routes —— 至少要给一条 { provider, model }')
  }
  if (!Array.isArray(raw)) {
    throw new RouteConfigError(`dsh-llm-auto: config.routes 必须是数组,实际是 ${typeof raw}`)
  }

  const routes = []
  const skipped = []
  const seen = new Set()

  raw.forEach((entry, offset) => {
    const index = offset + 1
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push({ index, label: String(entry), reason: '不是 { provider, model } 对象' })
      return
    }
    const provider = entry.provider
    const model = entry.model
    if (typeof provider !== 'string' || provider.trim().length === 0) {
      skipped.push({ index, label: String(provider), reason: 'provider 缺失或不是非空字符串' })
      return
    }
    if (typeof model !== 'string' || model.trim().length === 0) {
      skipped.push({ index, label: `${provider}/*`, reason: 'model 缺失或不是非空字符串' })
      return
    }
    if (provider === AUTO_PROVIDER) {
      // 自递归:auto 指向自己 ⇒ 无限嵌套。必须在挂载时就拒,不能留到请求时。
      skipped.push({ index, label: `${provider}/${model}`, reason: 'provider 指向本插件自己的 auto 路由(自递归),已拒绝' })
      return
    }
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) {
      skipped.push({ index, label: `${provider}/${model}`, reason: '与前一条完全重复' })
      return
    }
    seen.add(key)
    routes.push({ provider, model })
  })

  if (routes.length === 0) {
    const because = skipped.length === 0 ? '未给出任何条目' : `全部 ${skipped.length} 条都不可用(${skipped.map((s) => `#${s.index} ${s.reason}`).join(';')})`
    throw new RouteConfigError(`dsh-llm-auto: config.routes 解析后为空 —— ${because}`)
  }
  return { routes, skipped }
}

/**
 * 把一条链渲染成一行可读描述(用于模型选择器的 description 与日志)。
 * @param routes - 已规范化的路由链。
 * @param max - 最多列出几条,超出以 `…(+N)` 收尾。
 * @returns 形如 `commandcode/deepseek-v4.1-flash → ww/gpt-6-astra` 的字符串。
 */
export function describeChain(routes, max = 3) {
  const head = routes.slice(0, max).map(describeRoute).join(' → ')
  return routes.length <= max ? head : `${head} …(+${routes.length - max})`
}
