/**
 * dsh-llm-auto —— 把路由日志按「一次 auto 请求」分组。
 *
 * ## 为什么要有这一步
 * 环形缓冲(AutoAdapter 写进来的)是**逐次尝试**的平铺记录:一次 auto 请求在多条
 * 路由间回退时,一次就占 1~N 条(默认策略下最坏 = 链长 × 6)。直接摊平给界面看不出
 * "哪几条属于同一次请求",于是 0.5.0 给每条记录补上本次 `stream()` 调用的序号 `call`
 * (见 lib/adapter.js 的 #record),由这里还原成"一次请求依次经过了哪几条路由"。
 *
 * 输出形状(给 Web 插件页的面板直接用,纯数据、无界面代码):
 * ```js
 * [{ call: 7, at: '2026-09-27T…Z', elapsedMs: 3100, outcome: 'ok',
 *    routes: [{ attempt: 1, provider: 'a', model: 'x', tries: 5, ok: false,
 *               code: 'SERVER', reason: 'SERVER(502): …', elapsedMs: 1200,
 *               switched: true, switchedTo: 'b/y' },
 *             { attempt: 2, provider: 'b', model: 'y', tries: 1, ok: true,
 *               code: null, reason: null, elapsedMs: 1900, switched: false,
 *               switchedTo: null }] }]
 * ```
 *
 * 纯函数:不 import 任何运行时,便于 `node --test` 直接覆盖;浏览器半侧(lib/client.js)
 * 也拿同一份端点响应渲染,两侧口径一致。
 */

/** 一次请求的结局:`ok` 链上某条成功;`failed` 全部失败(含"错误码不允许回退"的止步);`aborted` 被取消。 */
export const CALL_OUTCOME = Object.freeze({ OK: 'ok', FAILED: 'failed', ABORTED: 'aborted' })

/**
 * 一条记录的耗时(防御坏值:环形缓冲里的 elapsedMs 由 Date.now() 差得到,理论上都是数)。
 * @param record - 一条路由日志记录。
 * @returns 非负毫秒数;拿不到时 0。
 */
function elapsedOf(record) {
  return Number.isFinite(record.elapsedMs) && record.elapsedMs > 0 ? record.elapsedMs : 0
}

/**
 * 把环形缓冲的记录按一次 `stream()` 调用分组。
 *
 * 同组内同一 `attempt`(同一条候选路由)的多次尝试会**合并成一行**,`tries` 是尝试次数,
 * `code`/`reason` 取最后一次失败的(成功路由为 null);`elapsedMs` 是组内所有记录的耗时之和
 * (只含上游尝试,不含退避等待 —— 等待不计入任何记录)。
 *
 * @param records - 环形缓冲记录(时间正序;通常来自 `GET /api/llm-auto/routes` 的 `routes`)。
 * @param options - `{ order?: 'asc'|'desc', maxCalls?: number }`;
 *   `order` 默认 `desc`(最近一次请求在最前,插件页要的就是"最近发生了什么");
 *   `maxCalls` 正整数时只保留最近这么多个分组(按 `order` 取)。
 * @returns 分组数组;`records` 不是数组或为空时返回空数组。
 */
export function groupCalls(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) return []
  const order = options.order === 'asc' ? 'asc' : 'desc'
  const maxCalls = Number.isInteger(options.maxCalls) && options.maxCalls > 0 ? options.maxCalls : null

  /** 按"第一条记录出现顺序"插入的组 —— 只作稳定排序的辅助值,见下面 lastIndex。 */
  const groups = new Map()
  let fallbackId = 0

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === null || typeof record !== 'object') continue
    let key
    if (Number.isInteger(record.call) && record.call > 0) {
      key = `call:${record.call}`
    } else {
      if (record.attempt === 1) fallbackId += 1
      key = `fallback:${fallbackId}`
    }

    let group = groups.get(key)
    if (group === undefined) {
      group = {
        call: key.startsWith('call:') ? Number(key.slice(5)) : null,
        at: typeof record.at === 'string' ? record.at : null,
        elapsedMs: 0,
        routes: [],
        byAttempt: new Map(),
        lastIndex: index,
      }
      groups.set(key, group)
    }
    if (group.at === null && typeof record.at === 'string') group.at = record.at
    // 组内最后一条记录的下标 ⇒ 排序用它(desc 的"最近请求在前"该按**请求结束**算,
    // 否则一条很长的回退过程会被后来的短请求挤到后面去)。
    group.lastIndex = index
    group.elapsedMs += elapsedOf(record)

    const attemptKey = String(record.attempt)
    let route = group.byAttempt.get(attemptKey)
    if (route === undefined) {
      route = {
        attempt: record.attempt,
        provider: record.provider,
        model: record.model,
        tries: 0,
        ok: false,
        code: null,
        reason: null,
        elapsedMs: 0,
        switched: false,
      }
      group.byAttempt.set(attemptKey, route)
      group.routes.push(route)
    }
    route.tries += 1
    route.elapsedMs += elapsedOf(record)
    if (record.ok === true) route.ok = true
    else if (typeof record.code === 'string' && record.code.length > 0) {
      // 同一条路由的最后一次失败(成功那次不会带 code;带 code 的一定是失败记录)
      route.code = record.code
      route.reason = typeof record.reason === 'string' ? record.reason : null
    }
    if (record.switched === true) route.switched = true
  }

  // 后处理:切换目标(失败且 switched ⇒ 指向同组下一条路由)
  for (const group of groups.values()) {
    for (let index = 0; index < group.routes.length; index += 1) {
      const route = group.routes[index]
      const next = group.routes[index + 1]
      route.switchedTo = route.switched === true && next !== undefined
        ? `${next.provider}/${next.model}`
        : null
    }
  }

  // 按组内**最后一条**记录的下标排序:desc 的"最近请求在前"按请求结束算,一条很长的
  // 回退过程不会被后来的短请求挤下去。
  let list = [...groups.values()].sort(function (left, right) {
    return order === 'desc' ? right.lastIndex - left.lastIndex : left.lastIndex - right.lastIndex
  })
  if (maxCalls !== null) list = order === 'desc' ? list.slice(0, maxCalls) : list.slice(-maxCalls)

  return list.map((group) => {
    const last = group.routes[group.routes.length - 1]
    return {
      call: group.call,
      at: group.at,
      elapsedMs: group.elapsedMs,
      outcome: last === undefined
        ? CALL_OUTCOME.FAILED
        : last.ok === true
          ? CALL_OUTCOME.OK
          : last.code === 'ABORTED'
            ? CALL_OUTCOME.ABORTED
            : CALL_OUTCOME.FAILED,
      routes: group.routes.map((route) => ({ ...route })),
    }
  })
}
