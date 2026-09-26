/**
 * 路由链解析与环形缓冲:`normalizeRoutes` / `describeChain` / `createRing`。
 * 全部是纯函数,不依赖 harness。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRing } from '../lib/index.js'
import { DEFAULT_CONTEXT_WINDOW, RouteConfigError, describeChain, normalizeRoutes } from '../lib/routes.js'

describe('normalizeRoutes', () => {
  it('按原顺序保留合法链', () => {
    const { routes, skipped } = normalizeRoutes([
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    assert.deepEqual(routes, [
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    assert.deepEqual(skipped, [])
  })

  it('空 routes 明确报错(三种"空"都要报)', () => {
    assert.throws(() => normalizeRoutes(undefined), RouteConfigError)
    assert.throws(() => normalizeRoutes(null), RouteConfigError)
    assert.throws(() => normalizeRoutes([]), RouteConfigError)
    assert.throws(() => normalizeRoutes('commandcode/x'), /必须是数组/u)
  })

  it('全部条目都不可用时也算空,并在消息里点名每条原因', () => {
    assert.throws(
      () => normalizeRoutes([{ provider: 'auto', model: 'auto' }, { model: 'x' }]),
      (error) => {
        assert.ok(error instanceof RouteConfigError)
        assert.match(error.message, /解析后为空/u)
        assert.match(error.message, /自递归/u)
        return true
      },
    )
  })

  it('provider: auto 自递归被拒并记 reason', () => {
    const { routes, skipped } = normalizeRoutes([
      { provider: 'auto', model: 'auto' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    assert.deepEqual(routes, [{ provider: 'ww', model: 'gpt-6-astra' }])
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].index, 1)
    assert.match(skipped[0].reason, /自递归/u)
  })

  it('单条结构问题只跳过该条,不拖垮整条链', () => {
    const { routes, skipped } = normalizeRoutes([
      'nope',
      { provider: '', model: 'x' },
      { provider: 'ww' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    assert.deepEqual(routes, [{ provider: 'ww', model: 'gpt-6-astra' }])
    assert.equal(skipped.length, 3)
    assert.deepEqual(skipped.map((item) => item.index), [1, 2, 3])
  })

  it('完全重复的 provider+model 只保留第一次', () => {
    const { routes, skipped } = normalizeRoutes([
      { provider: 'ww', model: 'gpt-6-astra' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    assert.equal(routes.length, 1)
    assert.match(skipped[0].reason, /重复/u)
  })
})

describe('describeChain', () => {
  it('短链全列,长链截断', () => {
    assert.equal(describeChain([{ provider: 'a', model: 'b' }]), 'a/b')
    const long = Array.from({ length: 5 }, (_, index) => ({ provider: `p${index}`, model: 'm' }))
    assert.equal(describeChain(long, 2), 'p0/m → p1/m …(+3)')
  })
})

describe('createRing', () => {
  it('按容量淘汰最旧的', () => {
    const ring = createRing(3)
    for (let i = 1; i <= 5; i += 1) ring.push({ at: i })
    assert.equal(ring.size, 3)
    assert.deepEqual(ring.list().map((item) => item.at), [3, 4, 5])
  })

  it('limit 取最近的 N 条,非法 limit 视为不限', () => {
    const ring = createRing(10)
    for (let i = 1; i <= 4; i += 1) ring.push({ at: i })
    assert.deepEqual(ring.list(2).map((item) => item.at), [3, 4])
    assert.deepEqual(ring.list(0).map((item) => item.at), [1, 2, 3, 4])
    assert.deepEqual(ring.list(-1).map((item) => item.at), [1, 2, 3, 4])
    assert.deepEqual(ring.list(99).map((item) => item.at), [1, 2, 3, 4])
  })

  it('容量也可以传取值函数(宿主里 logLimit 是 volatile 引用):读时求值,缩小后立刻淘汰', () => {
    let capacity = 3
    const ring = createRing(() => capacity)
    for (let i = 1; i <= 3; i += 1) ring.push({ at: i })
    assert.equal(ring.capacity, 3)
    assert.deepEqual(ring.list().map((item) => item.at), [1, 2, 3])
    capacity = 1
    assert.equal(ring.capacity, 1, 'capacity 是读时求值的 getter')
    ring.push({ at: 4 })
    assert.deepEqual(ring.list().map((item) => item.at), [4], '缩容后 push 时淘汰多余项')
  })

  it('保守上下文窗口是个正整数', () => {
    assert.ok(Number.isInteger(DEFAULT_CONTEXT_WINDOW) && DEFAULT_CONTEXT_WINDOW > 0)
  })
})
