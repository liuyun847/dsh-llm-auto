/**
 * 历史回放的 source 改写(`restoreReplaySources`)。
 *
 * 覆盖验收要求的五条:不同 ⇒ 改写、相同 ⇒ 原样、无 replayState ⇒ 原样、
 * 形状不对 ⇒ 原样不抛、`content` 与其它字段逐字未变;
 * 外加逐条独立取值、非助手消息不动、冻结输入不被破坏、以及经 AutoAdapter 的接线。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AutoAdapter, createRing, restoreReplaySources } from '../lib/index.js'

/** 一条"经 auto 产出"的历史助手消息:source 记 auto,replay 状态记真实路由。 */
function autoAssistant(overrides = {}) {
  const { source: sourceOverride, ...rest } = overrides
  return Object.freeze({
    role: 'assistant',
    content: Object.freeze([
      Object.freeze({ type: 'reasoning', text: '先算 17*23 = 391' }),
      Object.freeze({ type: 'text', text: '12121' }),
    ]),
    source: Object.freeze({
      kind: 'model',
      provider: 'auto',
      model: 'auto',
      replayState: Object.freeze({
        response: Object.freeze({
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          stopReason: 'stop',
        }),
        blocks: Object.freeze([Object.freeze({ type: 'reasoning' }), Object.freeze({ type: 'text' })]),
      }),
      ...sourceOverride,
    }),
    ...rest,
  })
}

/** 造一个请求(默认:system + 一条待改写的历史助手消息 + user)。 */
function request(messages) {
  return Object.freeze({
    provider: 'auto',
    model: 'auto',
    messages: Object.freeze(messages ?? [
      Object.freeze({ role: 'system', content: 'sys' }),
      autoAssistant(),
      Object.freeze({ role: 'user', content: '追问' }),
    ]),
  })
}

describe('restoreReplaySources:改写', () => {
  it('replay 路由与 source 不同 ⇒ provider/model 改成 replay 记录的真实路由', () => {
    const options = request()
    const fixed = restoreReplaySources(options)
    assert.notEqual(fixed, options)
    assert.equal(fixed.messages[1].source.provider, 'opencode-go')
    assert.equal(fixed.messages[1].source.model, 'deepseek-v4.1-flash')
    // replayState 原样带着走(下游 forAdapter 要靠它保留)
    assert.equal(fixed.messages[1].source.replayState, options.messages[1].source.replayState)
  })

  it('只改 provider/model,content 与其它字段逐字未变(原消息不被破坏)', () => {
    const options = request()
    const before = options.messages[1]
    const after = restoreReplaySources(options).messages[1]
    assert.equal(after.content, before.content) // content 同一引用 ⇒ 逐字未变
    const strip = (message) => JSON.stringify({ ...message, source: undefined })
    assert.equal(strip(after), strip(before))
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
    assert.deepEqual(Object.keys(after.source).sort(), Object.keys(before.source).sort())
    // 入参(深冻结)保持原值
    assert.equal(before.source.provider, 'auto')
    assert.equal(before.source.model, 'auto')
  })

  it('改出来的消息与 source 都是浅冻结的(与宿主"消息不可变"的约定一致)', () => {
    const after = restoreReplaySources(request()).messages[1]
    assert.equal(Object.isFrozen(after), true)
    assert.equal(Object.isFrozen(after.source), true)
  })

  it('多条历史消息各自按自己的 replay 路由改写(会话中途切过路由)', () => {
    const first = autoAssistant()
    const second = autoAssistant({
      source: {
        provider: 'auto',
        model: 'auto',
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', stopReason: 'stop' },
          blocks: [{ type: 'reasoning' }, { type: 'text' }],
        },
      },
    })
    const fixed = restoreReplaySources(request([first, second]))
    assert.deepEqual(
      fixed.messages.map((m) => `${m.source.provider}/${m.source.model}`),
      ['opencode-go/deepseek-v4.1-flash', 'commandcode/deepseek/deepseek-v4.1-flash'],
    )
  })

  it('数组只在真的需要改时才复制:未改写的消息保持同一引用', () => {
    const untouched = Object.freeze({ role: 'user', content: 'hi' })
    const options = request([untouched, autoAssistant()])
    const fixed = restoreReplaySources(options)
    assert.notEqual(fixed.messages, options.messages)
    assert.equal(fixed.messages[0], untouched) // 不需要改的那条原样进新数组
    assert.notEqual(fixed.messages[1], options.messages[1]) // 需要改的那条是新对象
    assert.equal(fixed.messages[1].content, options.messages[1].content) // 但 content 是同一份
    assert.equal(options.messages[1].source.provider, 'auto') // 入参那条仍是旧 source
  })
})

describe('restoreReplaySources:原样放行', () => {
  it('replay 路由与 source 相同 ⇒ 返回同一个 options 对象(零改动)', () => {
    const message = autoAssistant({
      source: {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'opencode-go', model: 'deepseek-v4.1-flash', stopReason: 'stop' },
          blocks: [{ type: 'reasoning' }, { type: 'text' }],
        },
      },
    })
    const options = request([message])
    const fixed = restoreReplaySources(options)
    assert.equal(fixed, options)
    assert.equal(fixed.messages[0], message)
  })

  it('没有 replayState ⇒ 原样', () => {
    const options = request([Object.freeze({ role: 'assistant', content: [], source: Object.freeze({ kind: 'model', provider: 'auto', model: 'auto' }) })])
    assert.equal(restoreReplaySources(options), options)
  })

  it('非助手消息即使带 replayState 也不动', () => {
    const user = Object.freeze({
      role: 'user',
      content: 'hi',
      source: Object.freeze({ kind: 'model', provider: 'auto', model: 'auto', replayState: Object.freeze({ response: Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) }) }),
    })
    const options = request([user])
    assert.equal(restoreReplaySources(options), options)
  })

  it('replayState 形状不对 ⇒ 原样返回且不抛', () => {
    const cases = [
      undefined,
      null,
      'not-an-object',
      42,
      {},
      { response: null },
      { response: 'nope' },
      { response: [] },
      { response: {} }, // 缺 provider/model
      { response: { provider: 'opencode-go' } }, // 缺 model
      { response: { provider: '', model: 'deepseek-v4.1-flash' } }, // 空串
      { response: { provider: 'opencode-go', model: '' } },
      { response: { provider: 7, model: 'deepseek-v4.1-flash' } },
      { response: { provider: 'opencode-go', model: { id: 'x' } } },
    ]
    for (const replayState of cases) {
      const message = Object.freeze({ role: 'assistant', content: [], source: Object.freeze({ kind: 'model', provider: 'auto', model: 'auto', ...(replayState === undefined ? {} : { replayState }) }) })
      const options = request([message])
      assert.equal(restoreReplaySources(options), options, `replayState=${JSON.stringify(replayState)} 应原样放行`)
    }
  })

  it('messages 不是数组 / options 不是对象 ⇒ 原样返回不抛', () => {
    for (const bad of [undefined, null, 'x', 7, {}, { messages: null }, { messages: 'nope' }, { messages: {} }]) {
      assert.equal(restoreReplaySources(bad), bad)
    }
  })

  it('source 缺失或不是对象 ⇒ 原样', () => {
    for (const source of [undefined, null, 'x', 7]) {
      const options = request([Object.freeze({ role: 'assistant', content: [], ...(source === undefined ? {} : { source }) })])
      assert.equal(restoreReplaySources(options), options)
    }
  })
})

describe('接线:嵌套调用真的拿到了改写后的 source', () => {
  /** 只记录嵌套请求的假 llm(不用 helpers 的通用替身,这里要看 messages)。 */
  function capturingLlm(seen) {
    return {
      async *stream(options) {
        seen.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model, context: { contextWindow: 1000 } }
      },
    }
  }

  it('AutoAdapter.stream() 交给 llm.stream 的历史助手消息已改回真实路由', async () => {
    const seen = []
    const adapter = new AutoAdapter({
      llm: capturingLlm(seen),
      routes: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
      modelName: 'Auto',
      ring: createRing(5),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      resolveContextWindow: async () => 1000,
    })
    const options = request()
    for await (const _chunk of adapter.stream(options)) { /* 只关心嵌套请求长什么样 */ }

    assert.equal(seen.length, 1)
    assert.equal(seen[0].provider, 'opencode-go')
    assert.equal(seen[0].messages[1].source.provider, 'opencode-go')
    assert.equal(seen[0].messages[1].source.model, 'deepseek-v4.1-flash')
    assert.equal(seen[0].messages[1].content, options.messages[1].content) // content 逐字未变
    assert.equal(options.messages[1].source.provider, 'auto') // 外层请求没被改
  })
})
