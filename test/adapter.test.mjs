/**
 * 路由行为:用可编排的假上游精确构造每条路径。
 * 覆盖验收要求的六条,外加暂存分片、不可回退码、取消、空响应、窗口解析等边界,
 * 以及"路由内重试"(默认开启,官方同款策略)的全部路径。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AutoAdapter, createRing, NO_RETRY_POLICY } from '../lib/index.js'
import { groupCalls } from '../lib/calls.js'
import { DEFAULT_CONTEXT_WINDOW } from '../lib/routes.js'
import { EXHAUSTED_CODE } from '../lib/errors.js'
import { chunk, drain, makeFakeLlm, successScript } from './helpers.mjs'

/** 组装一个被测 adapter(默认两条路由:first / second);`options.modelName` 可传取值函数。 */
function build(scripts, options = {}) {
  const routes = options.routes ?? [{ provider: 'first', model: 'm1' }, { provider: 'second', model: 'm2' }]
  const { llm, calls } = makeFakeLlm(scripts, options.windows ?? { first: 500000, second: 200000 })
  const ring = createRing(20)
  const warnings = []
  const delays = []
  const adapter = new AutoAdapter({
    llm,
    routes,
    modelName: options.modelName ?? 'Auto',
    retryPolicy: options.retryPolicy,
    ring,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    resolveContextWindow: async () => 123456,
    // 测试不真等退避:默认"立刻等到"并记录延迟;要模拟取消的用例自己覆盖 sleep。
    sleep: options.sleep ?? (async (ms) => { delays.push(ms); return true }),
    random: options.random,
    // 0.8.0:排序与失败回调都由宿主注入(adapter 不认识额度/排序);不传时是旧行为。
    buildOrder: options.buildOrder,
    onFailure: options.onFailure,
  })
  return { adapter, calls, ring, warnings, delays, routes }
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
    assert.deepEqual(models[0].inputModalities, ['text', 'image'])
    assert.match(models[0].description, /first\/m1 → second\/m2/u)
  })

  it('modelName 可以是取值函数(宿主里 config.name 是 volatile 引用)⇒ 每次调用现取', async () => {
    let current = 'Auto'
    const { adapter, routes } = build({}, { modelName: () => current })
    assert.equal((await adapter.listModels('auto'))[0].name, 'Auto')
    assert.equal((await adapter.resolveModel('auto', 'auto')).name, 'Auto')
    current = '我的聚合模型'
    assert.equal((await adapter.listModels('auto'))[0].name, '我的聚合模型', '取值函数换值后立刻生效')
    assert.equal((await adapter.resolveModel('auto', 'auto')).name, '我的聚合模型')
    assert.deepEqual(routes, [{ provider: 'first', model: 'm1' }, { provider: 'second', model: 'm2' }])
  })

  it('resolveModel 回显 provider/id 并带上上下文窗口', async () => {
    const { adapter } = build({})
    const info = await adapter.resolveModel('auto', 'auto')
    assert.equal(info.provider, 'auto')
    assert.equal(info.id, 'auto')
    assert.equal(info.context.contextWindow, 123456)
    assert.deepEqual(info.inputModalities, ['text', 'image'])
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

  it('【首条瞬时失败】RATE_LIMIT 在瞬时白名单:先原地重试,耗尽(默认 5 次)后回退第二条', async () => {
    const { adapter, calls, ring, warnings } = build({
      first: () => [chunk.finishError('RATE_LIMIT', 'too many requests', 429)],
      second: () => successScript('from second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('from second'))
    // 默认 maxRetries=5 ⇒ first 共 6 次尝试,最后一次失败才切 second
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first', 'first', 'first', 'first', 'second'])
    assert.equal(ring.list().length, 7)
    assert.equal(ring.list()[4].willRetry, true, '前 5 条是重试记录(不进聚合错误)')
    assert.equal(ring.list()[5].switched, true)
    assert.equal(ring.list()[5].try, 6)
    assert.equal(ring.list()[6].ok, true)
    // 5 条重试 warn + 1 条切换 warn;切换 warn 里带"共尝试 6 次"
    assert.equal(warnings.length, 6)
    assert.match(warnings[5], /共尝试 6 次.*静默切换/u)
  })

  it('【全部失败】抛聚合错误,消息里逐条列出路由与原因(重试过的带尝试次数)', async () => {
    const { adapter } = build({
      first: () => [chunk.finishError('MISSING_CREDENTIAL', 'no key for route first')],
      second: () => [chunk.finishError('SERVER', '502 status code', 502)],
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.deepEqual(chunks, [], '全部失败时不应向调用方交出任何分片')
    assert.ok(thrown, '应当抛错')
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.match(thrown.message, /全部 2 条路由均失败/u)
    // MISSING_CREDENTIAL 不在瞬时白名单 ⇒ 不重试,不带次数后缀
    assert.match(thrown.message, /first\/m1 → MISSING_CREDENTIAL: no key for route first/u)
    // SERVER 在白名单 ⇒ 重试 5 次后才计入聚合
    assert.match(thrown.message, /second\/m2 → SERVER\(HTTP 502\): 502 status code（\d+ ms，共 6 次尝试）/u)
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

  it('暂存 block-start 与 usage:首条只发了协议分片就失败 ⇒ 重试耗尽后干净地换到第二条', async () => {
    const { adapter, calls } = build({
      // 真机形态:上游先发一个全零 usage,再报 502(SERVER 在瞬时白名单,会先重试 5 次)
      first: () => [chunk.usage(0, 0), chunk.finishError('SERVER', '502 status code', 502)],
      second: () => successScript('second wins'),
    })
    const { chunks } = await drain(adapter.stream(request()))
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first', 'first', 'first', 'first', 'second'])
    assert.deepEqual(chunks, successScript('second wins'), '每一次尝试的 usage 都必须被丢弃,不能透传')
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

  it('【空响应】上游正常结束却没有内容 ⇒ 也算失败;EMPTY_RESPONSE 在瞬时白名单,先原地重试再回退', async () => {
    const { adapter, calls } = build({
      first: () => [chunk.usage(), chunk.finishStop()],
      second: () => successScript('second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    // 空响应可重试:first 重试 5 次仍空,才切 second
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first', 'first', 'first', 'first', 'second'])
    assert.deepEqual(chunks, successScript('second'))
  })

  it('所有路由都空响应 ⇒ 抛聚合错误(而不是静默交出一个空回合)', async () => {
    const { adapter } = build({ first: () => [chunk.finishStop()], second: () => [chunk.finishStop()] })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.deepEqual(chunks, [])
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.match(thrown.message, /EMPTY_RESPONSE/u)
    assert.match(thrown.message, /共 6 次尝试/u, '每条路由都重试到耗尽才计入聚合')
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

describe('路由内重试(默认开启:官方同款策略,每路由最多 5 次重试)', () => {
  it('第 3 次尝试成功 ⇒ 不切第二条,分片以成功那一次为准', async () => {
    let n = 0
    const { adapter, calls, ring, warnings } = build({
      first: () => (n += 1, n < 3 ? [chunk.finishError('SERVER', 'boom', 502)] : successScript('recovered on try 3')),
      second: () => successScript('should not run'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first'])
    assert.deepEqual(chunks, successScript('recovered on try 3'))
    assert.equal(ring.list().length, 3)
    assert.equal(ring.list()[1].willRetry, true)
    assert.equal(ring.list()[2].ok, true)
    assert.equal(ring.list()[2].try, 3)
    assert.equal(warnings.length, 2, '只有重试 warn,没有切换 warn')
    assert.match(warnings[0], /第 1 次尝试失败.*后重试/u)
  })

  it('白名单外的错误码(NO_ADAPTER/UNKNOWN_MODEL/MISSING_CREDENTIAL/QUOTA_EXCEEDED)一次败就切,不重试', async () => {
    for (const code of ['NO_ADAPTER', 'UNKNOWN_MODEL', 'MISSING_CREDENTIAL', 'QUOTA_EXCEEDED']) {
      const { adapter, calls, ring, delays } = build({
        first: () => [chunk.finishError(code, `${code} happened`)],
        second: () => successScript('second'),
      })
      const { chunks, thrown } = await drain(adapter.stream(request()))
      assert.equal(thrown, undefined, `${code} 不该抛聚合错误`)
      assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'], `${code} 不该触发重试`)
      assert.deepEqual(delays, [], `${code} 不该有任何退避等待`)
      assert.equal(ring.list()[0].try, 1)
      assert.equal(ring.list()[0].switched, true)
      assert.deepEqual(chunks, successScript('second'))
    }
  })

  it('maxRetries: 0 ⇒ 关闭重试,恢复"一次败就切"的旧行为', async () => {
    const { adapter, calls, delays } = build(
      { first: () => [chunk.finishError('SERVER', 'boom', 502)], second: () => successScript('second') },
      { retryPolicy: NO_RETRY_POLICY },
    )
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.deepEqual(delays, [])
    assert.deepEqual(chunks, successScript('second'))
  })

  it('EMPTY_RESPONSE 在瞬时白名单:空响应两次后,第三次出内容', async () => {
    let n = 0
    const { adapter, calls } = build({
      first: () => (n += 1, n < 3 ? [chunk.usage(), chunk.finishStop()] : successScript('finally')),
      second: () => successScript('should not run'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first'])
    assert.deepEqual(chunks, successScript('finally'))
    assert.equal(chunks.filter((item) => item.type === 'usage').length, 1, '前两次的 usage 必须被丢弃')
  })

  it('退避序列按官方口径(500/1000/2000/4000/8000ms;random 固定 0.5 ⇒ jitter 系数恰为 1)', async () => {
    const { adapter, delays } = build(
      { first: () => [chunk.finishError('SERVER', 'boom', 502)], second: () => successScript('second') },
      { random: () => 0.5 },
    )
    await drain(adapter.stream(request()))
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000])
  })

  it('上游 Retry-After 在退避上限内 ⇒ 优先于本地退避', async () => {
    const { adapter, delays } = build({
      first: () => [chunk.finishError('RATE_LIMIT', 'slow down', 429, 700)],
      second: () => successScript('second'),
    })
    await drain(adapter.stream(request()))
    assert.deepEqual(delays, [700, 700, 700, 700, 700])
  })

  it('上游 Retry-After 超过 maxDelayMs ⇒ 不等了,直接切下一条(与官方 normal 模式一致)', async () => {
    const { adapter, calls, delays } = build({
      first: () => [chunk.finishError('RATE_LIMIT', 'calm down', 429, 120000)],
      second: () => successScript('second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
    assert.deepEqual(delays, [])
    assert.deepEqual(chunks, successScript('second'))
  })

  it('退避期间调用方取消 ⇒ 不再打上游,分片以 aborted 收尾', async () => {
    const controller = new AbortController()
    const { adapter, calls } = build(
      { first: () => [chunk.finishError('SERVER', 'boom', 502)], second: () => successScript('nope') },
      { sleep: async () => { controller.abort(); return false } },
    )
    const { chunks, thrown } = await drain(adapter.stream({ ...request(), signal: controller.signal }))
    assert.equal(thrown, undefined)
    assert.equal(calls.length, 1, '取消后绝不再发起下一次尝试')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED')
  })

  it('已产出内容后失败:不重试也不回退(现有约束在重试启用后仍然成立)', async () => {
    let n = 0
    const { adapter, calls } = build({
      first: () => (n += 1, [
        chunk.blockStart(0), chunk.text('half'), chunk.textBlockEnd('half'), chunk.usage(),
        chunk.finishError('SERVER', 'upstream died mid-answer', 503),
      ]),
      second: () => successScript('should never run'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.equal(calls.length, 1, 'committed 之后绝不重试、绝不换路由')
    assert.deepEqual(chunks, [
      chunk.blockStart(0), chunk.text('half'), chunk.textBlockEnd('half'), chunk.usage(),
      chunk.finishError('SERVER', 'upstream died mid-answer', 503),
    ])
  })
})

describe('路由日志:call 序号(0.5.0 起,插件页面板按它分组)', () => {
  it('同一请求的所有记录 call 相同;不同请求自增', async () => {
    const { adapter, ring } = build({
      first: () => [chunk.finishError('SERVER', 'boom', 502)],
      second: () => successScript('from second'),
    })
    await drain(adapter.stream(request()))
    await drain(adapter.stream(request()))
    const entries = ring.list()
    // 两次请求:第一次 first×6 + second×1,第二次同样 7 条
    assert.equal(entries.length, 14)
    assert.equal(new Set(entries.map((entry) => entry.call)).size, 2, '两个不同的 call')
    assert.deepEqual(entries.slice(0, 7).map((entry) => entry.call), Array(7).fill(1))
    assert.deepEqual(entries.slice(7).map((entry) => entry.call), Array(7).fill(2))
  })

  it('ring → groupCalls 打通:一次请求还原成一条回退路径(面板要的形状)', async () => {
    const { adapter, ring } = build({
      first: () => [chunk.finishError('RATE_LIMIT', 'too many requests', 429)],
      second: () => successScript('from second'),
    })
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    const calls = groupCalls(ring.list())
    assert.equal(calls.length, 1)
    assert.equal(calls[0].outcome, 'ok')
    assert.equal(calls[0].routes.length, 2, '两条候选路由各一行')
    assert.equal(calls[0].routes[0].tries, 6, '首条 6 次尝试合并成一行')
    assert.equal(calls[0].routes[0].code, 'RATE_LIMIT')
    assert.equal(calls[0].routes[0].switchedTo, 'second/m2')
    assert.equal(calls[0].routes[1].ok, true)
    assert.deepEqual(chunks, successScript('from second'))
  })
})

describe('0.5.2 DeepSeek keepThinking chain integration', () => {
  function deepseekHistory() {
    const history = []
    for (let i = 0; i < 15; i += 1) {
      history.push(Object.freeze({ role: 'assistant', content: Object.freeze([
        Object.freeze({ type: 'reasoning', text: `reasoning-${i}` }),
        Object.freeze({ type: 'text', text: `answer-${i}` }),
        Object.freeze({ type: 'tool-call', id: `tool-${i}`, name: 'noop', arguments: '{}' }),
      ]), source: Object.freeze({ provider: 'auto', model: 'auto', replayState: Object.freeze({ response: Object.freeze({ kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), blocks: Object.freeze([{ type: 'reasoning' }, { type: 'text' }, { type: 'tool-call' }]) }) }) }))
      history.push(Object.freeze({ role: 'user', content: Object.freeze([{ type: 'tool-result', toolCallId: `tool-${i}`, content: 'ok' }]) }))
    }
    return history
  }
  async function run(keepThinking) {
    let outgoing
    const { llm } = makeFakeLlm({
      fallback: () => [chunk.finishError('NO_ADAPTER', 'missing')],
      'deepseek-official': (options) => { outgoing = options; return successScript() },
    })
    const adapter = new AutoAdapter({ llm, routes: [
      { provider: 'fallback', model: 'broken' },
      { provider: 'deepseek-official', model: 'deepseek-flash', keepThinking },
    ], modelName: 'Auto', ring: createRing(20), logger: { info() {}, warn() {}, error() {} }, resolveContextWindow: async () => 1000 })
    const options = { ...request(), messages: [...deepseekHistory(), Object.freeze({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'last', content: 'ok' }] })] }
    await drain(adapter.stream(options))
    return { outgoing, options }
  }
  it('15 pi-ai assistant turns + trailing tool result preserve reasoning for enabled DeepSeek route', async () => {
    const { outgoing } = await run(true)
    assert.equal(outgoing.messages.filter((message) => message.role === 'assistant').length, 15)
    assert.ok(outgoing.messages.filter((message) => message.role === 'assistant').every((message) => message.content[0].type === 'reasoning'))
  })
  it('same chain without keepThinking strips reasoning by default', async () => {
    const { outgoing } = await run(undefined)
    assert.ok(outgoing.messages.filter((message) => message.role === 'assistant').every((message) => message.content[0].type === 'text'))
  })
})

describe('额度感知排序 + 失败回调(0.8.0:buildOrder / onFailure)', () => {
  /** 一个"反过来排 + 滤掉指定 provider"的 buildOrder 替身(宿主侧那套纯规则在 test/ordering.test.mjs 里测)。 */
  const reverseOrder = (drop) => (routes) => ({
    entries: routes.filter((route) => route.provider !== drop).slice().reverse(),
    ignoredCooldown: false,
  })

  it('按 buildOrder 给的实际顺序尝试(不是配置顺序),模型名照旧带对', async () => {
    const orderCalls = []
    const { adapter, calls } = build(
      { first: () => successScript('from first'), second: () => successScript('from second') },
      { buildOrder: (routes) => { orderCalls.push(routes); return { entries: routes.slice().reverse(), ignoredCooldown: false } } },
    )
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), ['second/m2'], '实际顺序反过来了 ⇒ 先试 second')
    assert.deepEqual(chunks, successScript('from second'))
    assert.equal(orderCalls.length, 1, '一次请求只投影一次(快照)')
    assert.deepEqual(orderCalls[0], [{ provider: 'first', model: 'm1' }, { provider: 'second', model: 'm2' }], '投影拿到的是配置链')
  })

  it('冷却中的 provider 一次都不被尝试,失败后按实际顺序切下一条', async () => {
    const events = []
    const { adapter, calls, ring } = build(
      { first: () => successScript('from first'), second: () => [chunk.finishError('QUOTA', 'insufficient credits')], third: () => successScript('nope') },
      {
        routes: [{ provider: 'first', model: 'm1' }, { provider: 'second', model: 'm2' }, { provider: 'third', model: 'm3' }],
        buildOrder: reverseOrder('third'),
        onFailure: (event) => events.push(event.provider),
      },
    )
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['second', 'first'], 'third 被滤掉 ⇒ 一次都不尝试;顺序取反 ⇒ second 在前')
    assert.deepEqual(chunks, successScript('from first'))
    assert.equal(ring.list()[0].attempt, 1, 'attempt 是实际顺序的序号')
    assert.equal(ring.list()[0].provider, 'second')
    assert.deepEqual(events, ['second'], '告吹的那一条按事实报给宿主')
  })

  it('buildOrder 缺席 / 返回坏东西 / 抛错 ⇒ 一律退化成配置顺序(绝不少试一跳)', async () => {
    for (const buildOrder of [undefined, () => ({ entries: [] }), () => ({ entries: 'nope' }), () => { throw new Error('boom') }]) {
      const { adapter, calls, warnings } = build(
        { first: () => [chunk.finishError('NO_ADAPTER', 'nope')], second: () => successScript('ok') },
        { buildOrder },
      )
      const { thrown } = await drain(adapter.stream(request()))
      assert.equal(thrown, undefined, `${buildOrder} ⇒ 仍能回退到 second`)
      assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'])
      if (buildOrder !== undefined && typeof buildOrder === 'function' && buildOrder.toString().includes('throw')) {
        assert.ok(warnings.some((warning) => /排序失败/u.test(warning)), '排序抛错要留一条 warn')
      }
    }
  })

  it('每次"真的告吹"恰好回调一次 onFailure;重试过程中一次都不回调', async () => {
    const events = []
    const { adapter, calls } = build(
      { first: () => [chunk.finishError('SERVER', 'boom', 502)], second: () => successScript('ok') },
      { onFailure: (event) => events.push(event) },
    )
    await drain(adapter.stream(request()))
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'first', 'first', 'first', 'first', 'first', 'second'], 'SERVER 在白名单里 ⇒ 先重试 5 次')
    assert.equal(events.length, 1, '前 5 次是可重试的失败,不算告吹')
    assert.equal(events[0].provider, 'first')
    assert.equal(events[0].failure.code, 'SERVER')
    assert.equal(events[0].failure.status, 502)
  })

  it('QUOTA 失败:一次败就切,并把 {provider, failure} 报给 onFailure(宿主据此补查额度)', async () => {
    const events = []
    const { adapter, calls } = build(
      { first: () => [chunk.finishError('QUOTA', 'Insufficient credits', 400)], second: () => successScript('from second') },
      { onFailure: (event) => events.push(event) },
    )
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(calls.map((call) => call.provider), ['first', 'second'], 'QUOTA 不在重试白名单 ⇒ 不白等退避')
    assert.deepEqual(chunks, successScript('from second'))
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].provider, 'first')
    assert.equal(events[0].failure.code, 'QUOTA')
    assert.match(events[0].failure.message, /Insufficient credits/u)
  })

  it('全部失败时也是逐条各回调一次(顺序 = 实际尝试顺序)', async () => {
    const events = []
    const { adapter } = build(
      { first: () => [chunk.finishError('QUOTA', 'insufficient quota')], second: () => [chunk.finishError('QUOTA', 'usage limit reached')] },
      { onFailure: (event) => events.push(event.provider) },
    )
    const { thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown.code, EXHAUSTED_CODE)
    assert.deepEqual(events, ['first', 'second'])
  })

  it('onFailure 抛错 / 坏形状不影响请求(adapter 只报事实)', async () => {
    const { adapter, warnings } = build(
      { first: () => [chunk.finishError('QUOTA', 'insufficient credits')], second: () => successScript('ok') },
      { onFailure: () => { throw new Error('hook exploded') } },
    )
    const { chunks, thrown } = await drain(adapter.stream(request()))
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('ok'))
    assert.ok(warnings.some((warning) => /失败回调抛错/u.test(warning)))
  })

  it('已产出内容后失败 / 不可回退码:都不算"告吹",不回调 onFailure', async () => {
    const committed = []
    const { adapter: committedAdapter } = build(
      { first: () => [chunk.text('half'), chunk.finishError('QUOTA', 'insufficient credits')] },
      { routes: [{ provider: 'first', model: 'm1' }], onFailure: (event) => committed.push(event) },
    )
    await drain(committedAdapter.stream(request()))
    assert.deepEqual(committed, [], '吐了内容之后不换路由,也就不该触发额度补查')

    const never = []
    const { adapter: neverAdapter } = build(
      { first: () => [chunk.finishError('CONTEXT_WINDOW_EXCEEDED', 'too long')] },
      { routes: [{ provider: 'first', model: 'm1' }], onFailure: (event) => never.push(event) },
    )
    await drain(neverAdapter.stream(request()))
    assert.deepEqual(never, [], '不可回退的码直接上报,不是"告吹"')
  })
})
