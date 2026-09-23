/**
 * 路由行为:用可编排的假上游精确构造每条路径。
 * 覆盖验收要求的六条,外加暂存分片、不可回退码、取消、空响应、窗口解析等边界。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AutoAdapter, createRing } from '../lib/index.js'
import { DEFAULT_CONTEXT_WINDOW } from '../lib/routes.js'
import { EXHAUSTED_CODE } from '../lib/errors.js'
import { chunk, drain, makeFakeLlm, successScript } from './helpers.mjs'

/** 组装一个被测 adapter(默认两条路由:first / second)。 */
function build(scripts, options = {}) {
  const routes = options.routes ?? [{ provider: 'first', model: 'm1' }, { provider: 'second', model: 'm2' }]
  const { llm, calls } = makeFakeLlm(scripts, options.windows ?? { first: 500000, second: 200000 })
  const ring = createRing(20)
  const warnings = []
  const adapter = new AutoAdapter({
    llm,
    routes,
    modelName: 'Auto',
    ring,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    resolveContextWindow: async () => 123456,
  })
  return { adapter, calls, ring, warnings, routes }
}

const request = () => ({ provider: 'auto', model: 'auto', messages: [] })
describe('stdout 契约:providerInfo / listModels / resolveModel', () => {
  it('providerInfo 回显 id 且名字是 Auto(目录里的分组名)', () => {
    const { adapter } = build({})
    assert.deepEqual(adapter.providerInfo('auto'), { id: 'auto', name: 'Auto' })
  })

  it('listModels 只给一条 auto,且 name 非空', async () => {
    const { adapter } = build({})
    const models = await adapter.listModels('auto')
    assert.equal(models.length, 1)
    assert.equal(models[0].provider, 'auto')
    assert.equal(models[0].id, 'auto')
    assert.equal(models[0].name, 'Auto')
    assert.match(models[0].description, /first\/m1 → second\/m2/u)
  })

  it('resolveModel 回显 provider/id 并带上上下文窗口', async () => {
    const { adapter } = build({})
    const info = await adapter.resolveModel('auto', 'auto')
    assert.equal(info.provider, 'auto')
    assert.equal(info.id, 'auto')
    assert.equal(info.context.contextWindow, 123456)
  })

  it('窗口取第一条可解析的路由;全解析不出来时用保守值', async () => {
    const resolverCalls = []
    const routes = [{ provider: 'dead', model: 'x' }, { provider: 'alive', model: 'y' }]
    const { llm } = makeFakeLlm({ alive: () => successScript() }, { alive: 999 })
    // 直接驱动 index.js 里的解析器,确认"跳过不可解析的前缀"
    const { createContextWindowResolver } = await import('../lib/adapter.js')
    const resolver = createContextWindowResolver(llm, routes)
    assert.equal(await resolver(), 999)
    resolverCalls.push(await resolver()) // 命中 TTL 缓存
    assert.equal(resolverCalls[0], 999)

    const nothing = createContextWindowResolver(makeFakeLlm({}).llm, routes)
    assert.equal(await nothing(), DEFAULT_CONTEXT_WINDOW)
  })
})

describe('路由主循环', () => {
  it('【首次成功】只调一次上游,分片原样透传', async () => {
    const { adapter, calls, ring } = build({ first: () => successScript('hello') })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('hello'))
    assert.deepEqual(calls.map((call) => call.provider), ['first'])
    assert.equal(ring.list().length, 1)
    assert.equal(ring.list()[0].ok, true)
    assert.equal(ring.list()[0].switched, false)
  })

  it('【首条失败后回退成功】第二条接管,且日志记了切换', async () => {
    const { adapter, calls, ring, warnings } = build({
      first: () => [chunk.finishError('RATE_LIMIT', 'too many requests', 429)],
      second: () => successScript('from second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('from second'))
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.equal(ring.list().length, 2)
    assert.equal(ring.list()[0].switched, true)
    assert.equal(ring.list()[0].code, 'RATE_LIMIT')
    assert.equal(ring.list()[1].ok, true)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /静默切换/u)
  })

  it('【全部失败】抛聚合错误,消息里逐条列出路由与原因', async () => {
    const { adapter } = build({
      first: () => [chunk.finishError('MISSING_CREDENTIAL', 'no key for route first')],
      second: () => [chunk.finishError('SERVER', '502 status code', 502)],
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.deepEqual(chunks, [], '全部失败时不应向调用方交出任何分片')
    assert.ok(thrown, '应当抛错')
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.match(thrown.message, /全部 2 条路由均失败/u)
    assert.match(thrown.message, /first\/m1 → MISSING_CREDENTIAL: no key for route first/u)
    assert.match(thrown.message, /second\/m2 → SERVER\(HTTP 502\): 502 status code/u)
    assert.ok(thrown.cause instanceof AggregateError)
  })

  it('【已产出内容后失败】不回退,如实上报终止分片', async () => {
    const { adapter, calls, ring, warnings } = build({
      first: () => [
        chunk.blockStart(0), chunk.text('half'), chunk.textBlockEnd('half'),
        chunk.usage(),
        chunk.finishError('SERVER', 'upstream died mid-answer', 503),
      ],
      second: () => successScript('should never run'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.equal(calls.length, 1, '绝不应当在已产出内容后再打第二条路由')
    assert.deepEqual(chunks, [
      chunk.blockStart(0), chunk.text('half'), chunk.textBlockEnd('half'), chunk.usage(),
      chunk.finishError('SERVER', 'upstream died mid-answer', 503),
    ])
    assert.match(warnings[0], /已产出内容后失败/u)
    assert.equal(ring.list()[0].switched, false)
  })

  it('暂存 block-start 与 usage:首条只发了协议分片就失败 ⇒ 干净地换到第二条', async () => {
    const { adapter, calls } = build({
      // 真机形态:上游先发一个全零 usage,再报 502
      first: () => [chunk.usage(0, 0), chunk.finishError('SERVER', '502 status code', 502)],
      second: () => successScript('second wins'),
    })
    const { chunks } = await drain(adapter.stream(request()))
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.deepEqual(chunks, successScript('second wins'), '第一条的 usage 必须被丢弃,不能透传')
    assert.equal(chunks.filter((item) => item.type === 'usage').length, 1)
  })

  it('暂存的分片在成功时按原顺序放行(usage 不会丢也不会变成两条)', async () => {
    const script = [chunk.usage(7, 9), chunk.blockStart(0), chunk.text('x'), chunk.textBlockEnd('x'), chunk.finishStop()]
    const { adapter } = build({ first: () => script })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, script, '顺序不变;usage 只有一条')
  })

  it('只有 usage + 正常结束、没有任何内容 ⇒ 仍算空响应', async () => {
    const { adapter } = build({ first: () => [chunk.usage(7, 9), chunk.finishStop()], second: () => successScript('second') })
    const { chunks } = await drain(adapter.stream(request()))
    assert.deepEqual(chunks, successScript('second'), '第一条的 usage 与空 finish 都不该交出去')
  })

  it('【空响应】上游正常结束却没有内容 ⇒ 也算失败,可回退', async () => {
    const { adapter, calls } = build({
      first: () => [chunk.usage(), chunk.finishStop()],
      second: () => successScript('second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.deepEqual(chunks, successScript('second'))
  })

  it('所有路由都空响应 ⇒ 抛聚合错误(而不是静默交出一个空回合)', async () => {
    const { adapter } = build({ first: () => [chunk.finishStop()], second: () => [chunk.finishStop()] })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.deepEqual(chunks, [])
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.match(thrown.message, /EMPTY_RESPONSE/u)
  })

  it('不可回退的错误码即使不是最后一条也原样上报', async () => {
    for (const code of ['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED']) {
      const { adapter, calls } = build({
        first: () => [chunk.finishError(code, `${code} happened`)],
        second: () => successScript('nope'),
      })
      const { chunks, thrown } = await drain(adapter.stream(request()))
      assert.equal(thrown, undefined, `${code} 不该抛聚合错误`)
      assert.equal(calls.length, 1, `${code} 不该触发回退`)
      assert.deepEqual(chunks, [chunk.finishError(code, `${code} happened`)])
    }
  })

  it('终止分片 kind=aborted(非我方取消)原样上报,不回退', async () => {
    const { adapter, calls } = build({
      first: () => [chunk.finishAborted('ABORTED', 'upstream aborted')],
      second: () => successScript('nope'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.equal(calls.length, 1)
    assert.deepEqual(chunks, [chunk.finishAborted('ABORTED', 'upstream aborted')])
  })

  it('调用方取消:如实结束,绝不换路由', async () => {
    const controller = new AbortController()
    const { adapter, calls } = build({
      first: () => {
        controller.abort()
        return { throw: Object.assign(new Error('aborted by caller'), { code: 'ABORTED' }) }
      },
      second: () => successScript('nope'),
    })
    const { chunks, thrown } = await drain(adapter.stream({ ...request(), signal: controller.signal }))
    assert.equal(thrown, undefined)
    assert.equal(calls.length, 1)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
  })

  it('上游 stream() 自身抛异常(中间件失败)也能被当成该条失败并回退', async () => {
    const { adapter, calls } = build({
      first: () => ({ throw: Object.assign(new Error('middleware blew up'), { code: 'INVARIANT' }) }),
      second: () => successScript('recovered'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.deepEqual(chunks, successScript('recovered'))
  })

  it('档位按该路由可用的最高强度定:取声明里最后一项(max > high > medium > low)', async () => {
    const { llm, calls } = makeFakeLlm(
      { plain: () => successScript('ok'), rich: () => successScript('ok'), lower: () => successScript('ok') },
      { plain: 1000, rich: 1000, lower: 1000 },
      { rich: ['off', 'high', 'max'], lower: ['low', 'medium'] },
    )
    const mk = (provider) => new AutoAdapter({
      llm,
      routes: [{ provider, model: 'm' }],
      modelName: 'Auto',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      resolveContextWindow: async () => 1,
    })
    await drain(mk('plain').stream({ ...request(), reasoningEffort: 'low' }))
    assert.equal(calls[0].reasoningEffort, 'low', '该路由不声明任何档位 ⇒ 不改动(原样透传,交给分发判定)')

    await drain(mk('rich').stream({ ...request(), reasoningEffort: 'low' }))
    assert.equal(calls[1].reasoningEffort, 'max', '声明里最后一项即最高强度 ⇒ 用 max,而不是调用方的 low')

    await drain(mk('lower').stream({ ...request(), reasoningEffort: 'max' }))
    assert.equal(calls[2].reasoningEffort, 'medium', '只有 low|medium 时用 medium')
  })

  it('单条路由链也能工作(失败即聚合)', async () => {
    const { adapter } = build(
      { first: () => [chunk.finishError('AUTH', 'bad key', 401)] },
      { routes: [{ provider: 'first', model: 'm1' }] },
    )
    const { thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.match(thrown.message, /全部 1 条路由均失败/u)
  })
})
