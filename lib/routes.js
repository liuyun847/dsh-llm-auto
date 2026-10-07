/**
 * dsh-llm-auto v0.8.0 —— 路由链的解析、校验与编辑。
 *
 * 纯函数模块:不 import 任何 Harness 运行时,便于 `node --test` 直接覆盖。
 * 这里只做「把 YAML 里的 routes 变成一条可信的有序链」以及
 * 「浏览器半侧的链编辑器怎么改这条链」,不做任何 I/O。
 *
 * ── 两套形状,别混 ──────────────────────────────────────────────────────────
 *  · **配置形状** = `{ provider, model, keepThinking?, breakToolLoop? }`,可直接序列化成 YAML;
 *    规范化的出口是 {@link normalizeRoutes},关注的是「能不能用」;
 *  · **草稿形状** = 配置形状 + 一个客户端专用的 `key`(稳定身份,给 React 列表与拖拽用),
 *    关注的是「用户改到哪一步了」。{@link toRouteConfig} 负责把它收敛回配置形状 ——
 *    两个**互逆**操作:{@link toRouteDraft} 塞进 key 并把缺省的开关显式化成 `false`。
 *  分开的理由:草稿里没有「缺省」这个概念(开关只有明确的 on/off 才画得出来),配置里
 *  却必须省略 false(省了才与手写 YAML 逐字一致,不会把 keepThinking: false 写进文件)。
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
 *  - 完全重复的 provider+model ⇒ 只保留第一次出现的那条;
 *  - 逐条开关(keepThinking / breakToolLoop)**只保留 true**:缺省与显式 false 等价,
 *    收敛掉 false 才能让规范化结果与链编辑器的草稿形状(见 {@link toRouteConfig})逐字一致。
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
    const keepThinking = entry.keepThinking
    if (keepThinking !== undefined && typeof keepThinking !== 'boolean') skipped.push({ index, label: `${provider}/${model}`, reason: 'keepThinking 不是布尔值,已回落缺省 false' })
    const breakToolLoop = entry.breakToolLoop
    if (breakToolLoop !== undefined && typeof breakToolLoop !== 'boolean') skipped.push({ index, label: `${provider}/${model}`, reason: 'breakToolLoop 不是布尔值,已回落缺省 false' })
    // 只**打开**的开关才落进规范化结果。
    //
    // v0.6.0 起口径从"布尔值一律透传"收窄成"打开才写":两个开关的语义本就是
    // `!== true` 即关闭,而保留 `false` 会让"YAML 里写了 false"与"根本没写"变成两种
    // 不同的规范化结果 ⇒ 插件页的链编辑器会把一条**没改过**的链判成脏(草稿里 false 一律
    // 省略,规范化结果里却带着 false),用户一动别处就被要求保存链。收敛成一种形状之后,
    // `sameRoutes(toRouteChain(draft), readRoutes())` 就是可靠的"改没改"判据。
    routes.push({
      provider,
      model,
      ...(keepThinking === true ? { keepThinking: true } : {}),
      ...(breakToolLoop === true ? { breakToolLoop: true } : {}),
    })
  })

  if (routes.length === 0) {
    const because = skipped.length === 0 ? '未给出任何条目' : `全部 ${skipped.length} 条都不可用(${skipped.map((s) => `#${s.index} ${s.reason}`).join(';')})`
    throw new RouteConfigError(`dsh-llm-auto: config.routes 解析后为空 —— ${because}`)
  }
  return { routes, skipped }
}

/**
 * 把一条链渲染成一行可读描述(用于模型选择器的 description 与日志)。
 *
 * ⚠ 两个上限不是一回事,别混:`max` 是**字符预算**(prose 一行放得下多少),默认 3 条;
 * `maxItems` 是**条数上限**,默认 0 = 不限 —— 模型选择器里的描述用 (3, 2),因为那行
 * 后面还挂着模型名,列满三条就会把描述挤成两三行。
 * @param routes - 已规范化的路由链。
 * @param max - 最多列出几条,超出以 `…(+N)` 收尾(默认 3)。
 * @param maxItems - 更紧的条数硬上限(`> 0` 时生效,且只在它比 `max` 更小时起作用):
 *   给"这一行后面还要挂别的字"的调用方用。省略的部分一律并进 `…(+N)`。
 * @returns 形如 `commandcode/deepseek-v4.1-flash → ww/gpt-6-astra` 的字符串。
 */
export function describeChain(routes, max = 3, maxItems = 0) {
  const limit = maxItems > 0 ? Math.min(maxItems, max) : max
  const items = routes.slice(0, Math.max(0, limit))
  const head = items.map(describeRoute).join(' → ')
  const hidden = routes.length - items.length
  if (hidden <= 0) return head
  // 一条都没列出来时(head 为空)不留悬空的分隔箭头,只报"藏了几条"
  return head.length === 0 ? `…(+${hidden})` : `${head} …(+${hidden})`
}

/**
 * 链签名:链的成员、顺序与逐条开关的短指纹。
 *
 * 用途是**缓存失效**而不是真值比较 —— 上下文窗口解析器按它判断「链换了没有」
 * (见 lib/adapter.js 的 `createContextWindowResolver`)。
 * @param routes - 配置形状的路由链。
 * @returns 一条可比较的字符串;链为空时是空串。
 */
export function routeSignature(routes) {
  return routes
    .map((route) => `${route.provider}\u0000${route.model}\u0000${route.keepThinking === true ? 'k' : ''}${route.breakToolLoop === true ? 'b' : ''}`)
    .join('\u0001')
}

/**
 * 两条链是否逐项等价(供编辑器的「有没有改动」判定与测试断言用)。
 *
 * 用 JSON 逐字节比而不是自己写字段比较:两边由同一套构造顺序产出
 * (provider → model → keepThinking → breakToolLoop),字段序天然一致;
 * 自写比较反而容易漏掉某个开关。
 * @param left - 链 A。
 * @param right - 链 B。
 * @returns 等价为 true。
 */
export function sameRoutes(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 把一条路由拆成草稿:补上稳定 key,并把缺省的两个开关**显式化为 false**。
 *
 * 显式化是必须的:开关控件只有明确的 on/off 才画得出来,而草稿里没有「缺省」这个状态。
 * @param route - 配置形状的一条路由。
 * @param key - 该条在草稿里的稳定身份(客户端生成,例如 `r1`)。
 * @returns 一条草稿条目。
 */
export function toRouteDraft(route, key) {
  return {
    key,
    provider: route.provider,
    model: route.model,
    keepThinking: route.keepThinking === true,
    breakToolLoop: route.breakToolLoop === true,
  }
}

/**
 * 把草稿条目收敛回配置形状(逐条开关**打开才写**,关闭即省略)。
 *
 * 收敛口径与手写 YAML 一致:`keepThinking: false` 不写进文件 —— 插件对两个开关的
 * 缺省判定本就是「`!== true` 即关闭」(见 {@link normalizeRoutes}),写 false 只会白占一行。
 * @param draft - 一条草稿条目(多余的 `key` 会被忽略)。
 * @returns `{ provider, model }` 加上已打开的可选开关。
 */
export function toRouteConfig(draft) {
  return {
    provider: draft.provider,
    model: draft.model,
    ...(draft.keepThinking === true ? { keepThinking: true } : {}),
    ...(draft.breakToolLoop === true ? { breakToolLoop: true } : {}),
  }
}

/**
 * 把整条草稿链收敛成配置形状(保存前的那一刻调用)。
 * @param drafts - 草稿链。
 * @returns 可直接交给设置服务写入、也可与端点 `chain` 比对的链。
 */
export function toRouteChain(drafts) {
  return drafts.map(toRouteConfig)
}

/**
 * 逐条开关的键名(草稿上的布尔字段,同时也是配置里的键名)。
 *
 * 收在一张表里:UI 的开关列表与 {@link mutateRouteDraft} 的校验共用一份,
 * 以后加第三个开关(例如某个 provider 需要的新旋钮)只改这一处。
 */
export const ROUTE_OPTION_KEYS = Object.freeze(['keepThinking', 'breakToolLoop'])

/** @param key - 待判定的键名。@returns 是不是本插件认识的逐条开关。 */
export function isRouteOptionKey(key) {
  return ROUTE_OPTION_KEYS.includes(key)
}

/**
 * 链编辑器的草稿状态机(纯函数:不改入参,永远返回新数组)。
 *
 * 三种「改不动」的情形一律抛 {@link RouteConfigError} 让调用方显式处理(UI 据此禁用保存):
 *  · **删到空** —— `normalizeRoutes()` 对空链是硬失败(整行插件不注册),所以下限钉在 1;
 *  · 未知操作 / 未知开关 —— 静默忽略只会让 UI 装作改成功了,必须报出来;
 *  · 越界下标 / 越界移动 —— 同上。
 * 复用 `RouteConfigError` 的理由:它与挂载期的「配置结构不可用」是同一类失败,
 * 调用方用 `instanceof` 一条判据就能全覆盖。
 *
 * @param drafts - 当前草稿链。
 * @param action - `{ kind, ... }`:append(尾插一条) / update(替换第 index 条) /
 *   remove(删第 index 条) / move(把 from 挪到 to) / toggle(翻转第 index 条的某个开关)。
 * @returns 新的草稿链。
 * @throws {RouteConfigError} 见上。
 */
export function mutateRouteDraft(drafts, action) {
  const kind = action?.kind
  if (kind === 'append') return [...drafts, action.entry]

  if (kind === 'update') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= drafts.length) {
      throw new RouteConfigError(`dsh-llm-auto: 链编辑器要替换第 ${action.index} 条,但链上只有 ${drafts.length} 条`)
    }
    return drafts.map((draft, offset) => (offset === action.index ? { ...action.entry, key: draft.key } : draft))
  }

  if (kind === 'remove') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= drafts.length) {
      throw new RouteConfigError(`dsh-llm-auto: 链编辑器要删除第 ${action.index} 条,但链上只有 ${drafts.length} 条`)
    }
    if (drafts.length <= 1) {
      throw new RouteConfigError('dsh-llm-auto: 回退链至少要保留一条路由(空链会让插件整行不注册),最后一条不能删')
    }
    return drafts.filter((_draft, offset) => offset !== action.index)
  }

  if (kind === 'move') {
    const { from, to } = action
    if (!Number.isInteger(from) || from < 0 || from >= drafts.length || !Number.isInteger(to) || to < 0 || to >= drafts.length) {
      throw new RouteConfigError(`dsh-llm-auto: 链编辑器要把第 ${from} 条挪到第 ${to} 条,但链上只有 ${drafts.length} 条`)
    }
    if (from === to) return [...drafts]
    const next = [...drafts]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }

  if (kind === 'toggle') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= drafts.length) {
      throw new RouteConfigError(`dsh-llm-auto: 链编辑器要切换第 ${action.index} 条的开关,但链上只有 ${drafts.length} 条`)
    }
    if (!isRouteOptionKey(action.key)) {
      throw new RouteConfigError(`dsh-llm-auto: 不认识的逐条开关 ${JSON.stringify(action.key)}(已知:${ROUTE_OPTION_KEYS.join(' / ')})`)
    }
    return drafts.map((draft, offset) => (offset === action.index ? { ...draft, [action.key]: draft[action.key] !== true } : draft))
  }

  throw new RouteConfigError(`dsh-llm-auto: 链编辑器不认识的改动 ${JSON.stringify(kind)}`)
}
