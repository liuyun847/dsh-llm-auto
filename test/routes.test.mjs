/**
 * 路由链解析与环形缓冲:`normalizeRoutes` / `describeChain` / `createRing`。
 * 全部是纯函数,不依赖 harness。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRing } from '../lib/index.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  ROUTE_OPTION_KEYS,
  RouteConfigError,
  describeChain,
  isRouteOptionKey,
  mutateRouteDraft,
  normalizeRoutes,
  routeSignature,
  sameRoutes,
  toRouteChain,
  toRouteConfig,
  toRouteDraft,
} from '../lib/routes.js'

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
  it('短链全列,长链按 max 截断(默认 3 条)', () => {
    assert.equal(describeChain([{ provider: 'a', model: 'b' }]), 'a/b')
    const long = Array.from({ length: 5 }, (_, index) => ({ provider: `p${index}`, model: 'm' }))
    assert.equal(describeChain(long, 2), 'p0/m → p1/m …(+3)')
    assert.equal(describeChain(long, 3), 'p0/m → p1/m → p2/m …(+2)')
    assert.equal(describeChain(long), 'p0/m → p1/m → p2/m …(+2)', '默认 max = 3')
    assert.equal(describeChain(long, 0), '…(+5)', 'max = 0 ⇒ 一条都不列,只报藏了几条(不留悬空箭头)')
    assert.equal(describeChain(long, 99), 'p0/m → p1/m → p2/m → p3/m → p4/m', 'max 比链长 ⇒ 全列、不带后缀')
  })

  it('maxItems 单独限条数(模型选择器那行用 3, 2):不再跟着 max 一起被当条数用', () => {
    const chain = [
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      { provider: 'deepseek-official', model: 'deepseek-flash' },
    ]
    assert.equal(describeChain(chain, 3, 2), 'commandcode/deepseek/deepseek-v4.1-flash → opencode-go/deepseek-v4.1-flash …(+1)')
    assert.equal(describeChain(chain, 3, 9), describeChain(chain, 3))
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

describe('normalizeRoutes: keepThinking', () => {
  it('只有 true 落进结果;显式 false 与缺省同形;非布尔值 warn 并回落缺省', () => {
    const { routes, skipped } = normalizeRoutes([
      { provider: 'a', model: 'one', keepThinking: true },
      { provider: 'b', model: 'two', keepThinking: false },
      { provider: 'c', model: 'three', keepThinking: 'yes' },
      { provider: 'd', model: 'four', keepThinking: 1 },
      { provider: 'e', model: 'five', keepThinking: null },
    ])
    // v0.6.0:false 不再保留 —— 否则链编辑器会把一条没改过的链判成脏(见 lib/routes.js 的注释)
    assert.deepEqual(routes, [
      { provider: 'a', model: 'one', keepThinking: true },
      { provider: 'b', model: 'two' },
      { provider: 'c', model: 'three' },
      { provider: 'd', model: 'four' },
      { provider: 'e', model: 'five' },
    ])
    assert.equal(skipped.length, 3, '只有"不是布尔值"才记 note:显式 false 与缺省同义,不再产生 note')
    assert.deepEqual(skipped.map((item) => item.index), [3, 4, 5], 'null 也算非布尔值(第 5 条)')
    assert.ok(skipped.every((item) => /keepThinking/u.test(item.reason)))
  })
})


describe('链编辑器纯函数(v0.6.0)', () => {
  /** 造一条草稿链,省去每条都写全字段。 */
  const drafts = (...pairs) => pairs.map(([provider, model], index) => toRouteDraft({ provider, model }, `r${index + 1}`))

  it('toRouteDraft / toRouteConfig 互逆:草稿显式化开关,配置只写打开的那一个', () => {
    const draft = toRouteDraft({ provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true }, 'r1')
    assert.deepEqual(draft, { key: 'r1', provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true, breakToolLoop: false })
    assert.deepEqual(toRouteConfig(draft), { provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true })
    // 没打开的开关不进配置(与手写 YAML 同形)
    assert.deepEqual(toRouteConfig(toRouteDraft({ provider: 'ww', model: 'gpt-6-astra' }, 'r2')), { provider: 'ww', model: 'gpt-6-astra' })
  })

  it('回环稳定:规范化之后再过一次草稿/配置,结果逐字不变(这就是「改没改」的判据)', () => {
    const { routes } = normalizeRoutes([
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      { provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true, breakToolLoop: true },
    ])
    const once = toRouteChain(routes.map((route, index) => toRouteDraft(route, `r${index}`)))
    const twice = toRouteChain(once.map((route, index) => toRouteDraft(route, `r${index}`)))
    assert.deepEqual(once, routes, '第一次回环就该与规范化结果一致')
    assert.ok(sameRoutes(once, twice))
  })

  it('append / update / remove / move:不改入参,返回新数组', () => {
    const base = drafts(['a', 'm1'], ['b', 'm2'], ['c', 'm3'])
    const appended = mutateRouteDraft(base, { kind: 'append', entry: toRouteDraft({ provider: 'd', model: 'm4' }, 'r4') })
    assert.equal(appended.length, 4)
    assert.equal(base.length, 3, '入参没被改')

    const updated = mutateRouteDraft(base, { kind: 'update', index: 1, entry: { provider: 'b2', model: 'm2b', keepThinking: true, breakToolLoop: false } })
    assert.equal(updated[1].provider, 'b2')
    assert.equal(updated[1].key, base[1].key, '替换保留原来的稳定 key')

    const removed = mutateRouteDraft(base, { kind: 'remove', index: 0 })
    assert.deepEqual(removed.map((item) => item.provider), ['b', 'c'])

    const moved = mutateRouteDraft(base, { kind: 'move', from: 0, to: 2 })
    assert.deepEqual(moved.map((item) => item.provider), ['b', 'c', 'a'])
    assert.ok(sameRoutes(mutateRouteDraft(base, { kind: 'move', from: 1, to: 1 }), base), '原地挪动等于没动')
  })

  it('toggle 只翻一个开关,键名必须是已知开关', () => {
    const base = drafts(['a', 'm1'])
    const on = mutateRouteDraft(base, { kind: 'toggle', index: 0, key: 'keepThinking' })
    assert.equal(on[0].keepThinking, true)
    assert.equal(on[0].breakToolLoop, false, '另一个开关不受影响')
    assert.equal(mutateRouteDraft(on, { kind: 'toggle', index: 0, key: 'keepThinking' })[0].keepThinking, false)
    assert.throws(() => mutateRouteDraft(base, { kind: 'toggle', index: 0, key: 'unknownKnob' }), RouteConfigError)
    assert.deepEqual(ROUTE_OPTION_KEYS, ['keepThinking', 'breakToolLoop'])
    assert.ok(isRouteOptionKey('breakToolLoop') && !isRouteOptionKey('reasoningEffort'))
  })

  it('最后一条不能删(空链会让插件整行不注册)', () => {
    const single = drafts(['a', 'm1'])
    assert.throws(() => mutateRouteDraft(single, { kind: 'remove', index: 0 }), /至少要保留一条/u)
    assert.equal(mutateRouteDraft(drafts(['a', 'm1'], ['b', 'm2']), { kind: 'remove', index: 0 }).length, 1)
  })

  it('越界与未知操作一律抛错,不静默吞掉', () => {
    const base = drafts(['a', 'm1'])
    for (const action of [
      { kind: 'update', index: 3, entry: {} },
      { kind: 'remove', index: -1 },
      { kind: 'move', from: 0, to: 5 },
      { kind: 'toggle', index: 9, key: 'keepThinking' },
      { kind: 'frobnicate' },
      undefined,
    ]) {
      assert.throws(() => mutateRouteDraft(base, action), RouteConfigError)
    }
  })

  it('routeSignature 是缓存指纹:成员、顺序、开关任一变化都要变', () => {
    const one = toRouteChain(drafts(['a', 'm1'], ['b', 'm2']))
    assert.equal(routeSignature(one), routeSignature(toRouteChain(drafts(['a', 'm1'], ['b', 'm2']))))
    assert.notEqual(routeSignature(one), routeSignature(toRouteChain(drafts(['b', 'm2'], ['a', 'm1']))), '换序')
    assert.notEqual(routeSignature(one), routeSignature(toRouteChain(drafts(['a', 'm1']))), '少一条')
    assert.notEqual(routeSignature(one), routeSignature([{ provider: 'a', model: 'm1', keepThinking: true }, { provider: 'b', model: 'm2' }]), '开关')
    assert.equal(routeSignature([]), '')
  })
})
describe('normalizeRoutes: breakToolLoop', () => {
  it('布尔值透传;非布尔值 warn 并回落缺省;与 keepThinking 互不影响', () => {
    const { routes, skipped } = normalizeRoutes([
      { provider: 'a', model: 'one', breakToolLoop: true },
      { provider: 'b', model: 'two', breakToolLoop: false },
      { provider: 'c', model: 'three', breakToolLoop: 'yes' },
      { provider: 'd', model: 'four', keepThinking: true, breakToolLoop: true },
    ])
    assert.deepEqual(routes, [
      { provider: 'a', model: 'one', breakToolLoop: true },
      { provider: 'b', model: 'two' },
      { provider: 'c', model: 'three' },
      { provider: 'd', model: 'four', keepThinking: true, breakToolLoop: true },
    ])
    assert.equal(skipped.length, 1)
    assert.match(skipped[0].reason, /breakToolLoop/u)
    assert.equal(skipped[0].index, 3)
  })

  it('两个开关各写各的:只写一个时另一个键不出现', () => {
    const { routes } = normalizeRoutes([
      { provider: 'a', model: 'one', keepThinking: true },
      { provider: 'b', model: 'two', breakToolLoop: true },
    ])
    assert.deepEqual(Object.keys(routes[0]).sort(), ['keepThinking', 'model', 'provider'])
    assert.deepEqual(Object.keys(routes[1]).sort(), ['breakToolLoop', 'model', 'provider'])
  })
})
