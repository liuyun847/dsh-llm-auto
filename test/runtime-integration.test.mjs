/**
 * 端到端契约测试:用**真实的** `LlmRuntime` + **真实的** 流语法不变式
 * (`@deepseek-ai/dsh-llm/invariant` 的 `validateStream`)跑一遍本插件。
 *
 * 为什么值得单独一个文件:`adapter.test.mjs` 用的是假 llm,能证明"我的逻辑对",
 * 但证明不了"我的输出能被宿主接受"。这里注册真实的 provider 路由、走真实的
 * `adapterStream`(异常归一化 + 目录校验 + 不变的语法检查),把两者的接缝也钉住 ——
 * 尤其是"回退时不能出现重复 block-start / 重复 usage"这条约束。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { AutoAdapter } from '../lib/index.js'
import { EXHAUSTED_CODE } from '../lib/errors.js'
import { chunk, successScript } from './helpers.mjs'

/** 每个用例一套干净的运行时(含真实的流语法校验)。 */
async function makeRuntime() {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const violations = []
  ctx.provide('invariants', { register: (_pkg, install) => install(ctx, (message) => violations.push(message)) })
  const invariant = await import('@deepseek-ai/dsh-llm/invariant')
  await invariant.apply(ctx)
  return { ctx, llm, violations }
}

/** 一个可编排的上游适配器:脚本是分片数组,或一个"抛异常"的标记。 */
class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = script
  }

  async *stream() {
    if (typeof this.script === 'function') {
      for await (const item of this.script()) yield item
      return
    }
    for (const item of this.script) {
      if (item !== null && typeof item === 'object' && 'throw' in item) throw item.throw
      yield item
    }
  }
}

/** 装好 auto 路由 + 若干上游路由,返回收集分片的工具。 */
async function setup(upstreams, routes) {
  const { ctx, llm, violations } = await makeRuntime()
  for (const [provider, script] of Object.entries(upstreams)) llm.registerAdapter([provider], new ScriptedAdapter(script))
  const adapter = new AutoAdapter({
    llm,
    routes,
    modelName: 'Auto',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    resolveContextWindow: async () => 4096,
  })
  const handle = llm.registerAdapter(['auto'], adapter)
  return { ctx, llm, violations, handle }
}

/** 消费一次 `auto` 请求。 */
async function run(llm, extra = {}) {
  const chunks = []
  let thrown
  try {
    for await (const item of llm.stream({ provider: 'auto', model: 'auto', messages: [], ...extra })) chunks.push(item)
  } catch (error) {
    thrown = error
  }
  return { chunks, thrown }
}

const ROUTES = [{ provider: 'up1', model: 'm1' }, { provider: 'up2', model: 'm2' }]

describe('真实 LlmRuntime + 真实流语法不变式', () => {
  it('目录:auto 出现在 listProviders,且 listModels/resolveModelInfo 通过真品校验', async () => {
    const { llm } = await setup({ up1: successScript() }, ROUTES)
    assert.deepEqual(llm.listProviders().map((provider) => `${provider.id}=${provider.name}`), ['up1=up1', 'auto=Auto'])

    const models = await llm.listModels('auto')
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'auto')
    assert.equal(models[0].name, 'Auto')

    const info = await llm.resolveModelInfo('auto', 'auto')
    assert.equal(info.provider, 'auto')
    assert.equal(info.id, 'auto')
    assert.equal(info.context.contextWindow, 4096)
  })

  it('首选成功:分片逐条一致,且不变式零违规', async () => {
    const { llm, violations } = await setup({ up1: successScript('first route') }, ROUTES)
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('first route'))
    assert.deepEqual(violations, [])
  })

  it('首条以终止分片报错 ⇒ 静默切第二条,不变式零违规', async () => {
    const { llm, violations } = await setup({
      up1: [chunk.finishError('SERVER', 'boom', 500)],
      up2: successScript('second route'),
    }, ROUTES)
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('second route'))
    assert.deepEqual(violations, [])
  })

  it('首条只发了 block-start + usage 就报错 ⇒ 回退后流语法仍然合法(这条最容易写错)', async () => {
    const { llm, violations } = await setup({
      up1: [chunk.blockStart(0), chunk.usage(0, 0), chunk.finishError('SERVER', '502 status code', 502)],
      up2: successScript('second route'),
    }, ROUTES)
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('second route'))
    assert.deepEqual(violations, [], '若把第一条的 block-start/usage 先透传出去,这里会报"repeated block-start"或"usage more than once"')
  })

  it('上游适配器抛异常 ⇒ 被归一成终止分片并触发回退', async () => {
    const { llm, violations } = await setup({
      up1: [{ throw: new LlmError('upstream adapter exploded', 'SERVER') }],
      up2: successScript('recovered'),
    }, ROUTES)
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('recovered'))
    assert.deepEqual(violations, [])
  })

  it('全部失败 ⇒ 调用方拿到 AUTO_ROUTES_EXHAUSTED 的终止 error 分片,消息含逐条原因', async () => {
    const { llm, violations } = await setup({
      up1: [chunk.finishError('MISSING_CREDENTIAL', 'no key for up1')],
      up2: [chunk.finishError('SERVER', '502 status code', 502)],
    }, ROUTES)
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined, '适配器抛出的错误会被 LlmRuntime 归一成终止分片,不会冒泡到调用方')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'error')
    assert.equal(chunks[0].reason.failure.code, EXHAUSTED_CODE)
    assert.match(chunks[0].reason.failure.message, /全部 2 条路由均失败/u)
    assert.match(chunks[0].reason.failure.message, /up1\/m1 → MISSING_CREDENTIAL/u)
    assert.match(chunks[0].reason.failure.message, /up2\/m2 → SERVER/u)
    assert.deepEqual(violations, [])
  })

  it('已产出内容后失败 ⇒ 不回退,终止分片如实反映上游错误', async () => {
    let secondCalls = 0
    const { llm, violations } = await setup({
      up1: [chunk.blockStart(0), chunk.text('half'), chunk.textBlockEnd('half'), chunk.finishError('SERVER', 'died mid-answer', 503)],
      up2: () => {
        secondCalls += 1
        return successScript('should not happen')
      },
    }, ROUTES)
    const { chunks } = await run(llm)
    assert.equal(secondCalls, 0)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'SERVER')
    assert.equal(chunks.filter((item) => item.type === 'text-delta')[0].text, 'half')
    assert.deepEqual(violations, [])
  })

  it('未注册的 provider 路由(真机 NO_ADAPTER)也能被回退吃掉', async () => {
    const { llm, violations } = await setup({ up2: successScript('second route') }, [
      { provider: 'ghost', model: 'nope' },
      { provider: 'up2', model: 'm2' },
    ])
    const { chunks, thrown } = await run(llm)
    assert.equal(thrown, undefined)
    assert.deepEqual(chunks, successScript('second route'))
    assert.deepEqual(violations, [])
  })

  it('注销注册后 auto 路由立刻消失(热重载不会留下死路由)', async () => {
    const { llm, handle } = await setup({ up1: successScript() }, ROUTES)
    assert.ok(llm.listProviders().some((provider) => provider.id === 'auto'))
    handle()
    assert.ok(!llm.listProviders().some((provider) => provider.id === 'auto'))
    const { chunks } = await run(llm)
    assert.equal(chunks[0].reason.failure.code, 'NO_ADAPTER')
  })
})
