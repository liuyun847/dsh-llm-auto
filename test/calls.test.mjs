/**
 * groupCalls:把环形缓冲的逐次尝试记录还原成"一次请求的回退路径"。
 *
 * 这些记录就是 `/api/llm-auto/routes` 的 `routes`(0.5.0 起每条多一个 `call`,
 * 由 AutoAdapter.stream() 写入),浏览器面板读的 `calls` 正是它们分组后的结果。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CALL_OUTCOME, groupCalls } from '../lib/calls.js'

/** 造一条日志记录(字段与 AutoAdapter.#record 写进 ring 的一致)。 */
function rec(over = {}) {
  return {
    at: '2026-09-27T10:00:00.000Z',
    call: 1,
    attempt: 1,
    try: 1,
    provider: 'first',
    model: 'm1',
    ok: true,
    switched: false,
    elapsedMs: 100,
    ...over,
  }
}

describe('groupCalls:健壮性', () => {
  it('非数组/空数组 → 空数组', () => {
    assert.deepEqual(groupCalls(undefined), [])
    assert.deepEqual(groupCalls(null), [])
    assert.deepEqual(groupCalls('nope'), [])
    assert.deepEqual(groupCalls([]), [])
  })

  it('数组里的坏条目(非对象)被跳过,不影响其余分组', () => {
    const calls = groupCalls([rec({ call: 1 }), null, 'junk', 42, rec({ call: 1, try: 2, attempt: 1 })])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].routes[0].tries, 2)
  })
})

describe('groupCalls:按一次 stream() 调用分组', () => {
  it('两次请求分成两组,默认最近一次在前', () => {
    const calls = groupCalls([
      rec({ call: 1, attempt: 1, provider: 'first', model: 'm1' }),
      rec({ call: 2, attempt: 1, at: '2026-09-27T10:05:00.000Z' }),
    ])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].call, 2, 'desc:最近的请求排前面')
    assert.equal(calls[1].call, 1)
    assert.equal(calls[0].at, '2026-09-27T10:05:00.000Z')
  })

  it('order: asc ⇒ 时间正序(与端点 raw routes 同向)', () => {
    const calls = groupCalls([rec({ call: 1 }), rec({ call: 2 })], { order: 'asc' })
    assert.deepEqual(calls.map((item) => item.call), [1, 2])
  })

  it('desc 按请求**结束**排序:长回退过程不被后来的短请求挤下去', () => {
    // 一份真实形状的记录:call 5 有三次尝试(回退),call 6 只一次成功 —— 但 call 6 更早开始
    const calls = groupCalls([
      rec({ call: 6, attempt: 1, try: 1, ok: true }),
      rec({ call: 5, attempt: 1, try: 1, ok: false, code: 'SERVER', willRetry: true }),
      rec({ call: 5, attempt: 1, try: 2, ok: false, code: 'SERVER', switched: true }),
      rec({ call: 5, attempt: 2, provider: 'second', model: 'm2', ok: true }),
    ])
    assert.deepEqual(calls.map((item) => item.call), [5, 6], 'call 5 是最近结束的请求,排最前')
  })

  it('maxCalls 只保留最近的若干组(desc 取头 / asc 取尾)', () => {
    const records = [1, 2, 3, 4].map((call) => rec({ call }))
    assert.deepEqual(groupCalls(records, { maxCalls: 2 }).map((item) => item.call), [4, 3])
    assert.deepEqual(groupCalls(records, { maxCalls: 2, order: 'asc' }).map((item) => item.call), [3, 4])
    assert.equal(groupCalls(records, { maxCalls: 0 }).length, 4, '0/非正整数 = 不限')
  })

  it('同组内同一 attempt 的多次尝试合并成一行,tries 记次数', () => {
    const calls = groupCalls([
      rec({ call: 7, attempt: 1, try: 1, ok: false, code: 'SERVER', reason: 'SERVER(502)', elapsedMs: 10 }),
      rec({ call: 7, attempt: 1, try: 2, ok: false, code: 'SERVER', reason: 'SERVER(503)', elapsedMs: 20, willRetry: true }),
      rec({ call: 7, attempt: 1, try: 3, ok: false, code: 'TIMEOUT', reason: 'timeout', elapsedMs: 30, switched: true }),
      rec({ call: 7, attempt: 2, provider: 'second', model: 'm2', try: 1, ok: true, elapsedMs: 40 }),
    ])
    assert.equal(calls.length, 1)
    const [route1, route2] = calls[0].routes
    assert.equal(route1.tries, 3)
    assert.equal(route1.ok, false)
    assert.equal(route1.code, 'TIMEOUT', '同一条路由合并:code/reason 取最后一次失败')
    assert.equal(route1.reason, 'timeout')
    assert.equal(route1.elapsedMs, 60, '一条路由内的耗时求和')
    assert.equal(route1.switched, true)
    assert.equal(route1.switchedTo, 'second/m2', '切换目标指向同组下一条路由')
    assert.equal(route2.tries, 1)
    assert.equal(route2.ok, true)
    assert.equal(route2.code, null)
    assert.equal(route2.switchedTo, null)
    assert.equal(calls[0].elapsedMs, 100, '整次请求的耗时 = 各次尝试之和(不含退避等待)')
    assert.equal(calls[0].outcome, CALL_OUTCOME.OK)
  })

  it('willRetry 的中间记录也计入 tries(它只是"不是终态",仍在这次调用里)', () => {
    const calls = groupCalls([
      rec({ call: 1, attempt: 1, try: 1, ok: false, code: 'RATE_LIMIT', willRetry: true }),
      rec({ call: 1, attempt: 1, try: 2, ok: true }),
    ])
    assert.equal(calls[0].routes[0].tries, 2)
    assert.equal(calls[0].routes[0].ok, true, '该路由最终成功 ⇒ ok 为 true')
    assert.equal(calls[0].outcome, CALL_OUTCOME.OK)
  })
})

describe('groupCalls:结局判定', () => {
  it('链上最后一条成功 ⇒ ok', () => {
    const calls = groupCalls([
      rec({ call: 1, attempt: 1, ok: false, code: 'SERVER', switched: true }),
      rec({ call: 1, attempt: 2, ok: true }),
    ])
    assert.equal(calls[0].outcome, 'ok')
  })

  it('最后一条也不成功(全部失败 / 错误码不允许回退)⇒ failed', () => {
    const exhausted = groupCalls([rec({ call: 1, attempt: 1, ok: false, code: 'SERVER' })])
    assert.equal(exhausted[0].outcome, CALL_OUTCOME.FAILED)
    const sticky = groupCalls([
      rec({ call: 1, attempt: 1, ok: false, code: 'NO_ADAPTER', switched: false }),
    ])
    assert.equal(sticky[0].outcome, CALL_OUTCOME.FAILED)
  })

  it('最后一条是 ABORTED ⇒ aborted(要与失败区分开)', () => {
    const calls = groupCalls([rec({ call: 1, attempt: 1, ok: false, code: 'ABORTED', reason: '调用方取消' })])
    assert.equal(calls[0].outcome, CALL_OUTCOME.ABORTED)
  })
})

describe('groupCalls:没有 call 字段的旧记录(重启前写入的)', () => {
  it('按 attempt 回到 1 开新组降级处理', () => {
    const legacy = [rec({ call: undefined, attempt: 1 }), rec({ call: undefined, attempt: 1, provider: 'second', model: 'm2' })]
    const calls = groupCalls(legacy)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].call, null, '旧记录没有调用序号 ⇒ call 为 null(面板不显示它)')
    assert.deepEqual(calls.map((item) => item.call), [null, null])
    // 混合:带 call 的按序号分组,旧的按 attempt 降级,互不串组
    const mixed = groupCalls([
      rec({ call: 3, attempt: 1 }),
      rec({ call: undefined, attempt: 1, provider: 'legacy', model: 'old' }),
      rec({ call: 3, attempt: 2, provider: 'second', model: 'm2' }),
    ])
    assert.equal(mixed.length, 2)
    assert.equal(mixed[0].call, 3)
    assert.equal(mixed[0].routes.length, 2)
  })
})
