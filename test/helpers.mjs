/**
 * 测试用的小工具(不是测试文件本身,不会被 `--test` 收集)。
 *
 * 这里刻意**不 import 真实 harness**:`test/runtime-integration.test.mjs` 才用真的
 * `LlmRuntime`,而本文件提供的是"可编排的假上游",用来精确构造各种失败序列。
 */

/** 造一个分片。 */
export const chunk = {
  blockStart: (index = 0, blockType = 'text') => ({ type: 'block-start', index, blockType }),
  text: (text, index = 0) => ({ type: 'text-delta', index, text }),
  reasoning: (text, index = 0) => ({ type: 'reasoning-delta', index, text }),
  textBlockEnd: (text, index = 0) => ({ type: 'block-end', index, block: { type: 'text', text } }),
  usage: (inputTokens = 1, outputTokens = 1) => ({ type: 'usage', usage: { inputTokens, outputTokens } }),
  finishStop: () => ({ type: 'finish', reason: { kind: 'stop' } }),
  finishError: (code, message, status) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { code, message, ...(status === undefined ? {} : { status }) } },
  }),
  finishAborted: (code = 'ABORTED', message = 'aborted') => ({ type: 'finish', reason: { kind: 'aborted', failure: { code, message } } }),
}

/** 一次成功的最小分片序列。 */
export function successScript(text = 'ok') {
  return [chunk.blockStart(0), chunk.text(text), chunk.textBlockEnd(text), chunk.usage(), chunk.finishStop()]
}

/**
 * 造一个假的 `ctx.llm`。
 *
 * @param scripts - `{ [provider]: (options) => AsyncIterable | {throw: Error} }`;
 *   返回 `{ llm, calls }`,`calls` 记录每次嵌套调用的 provider/model/reasoningEffort。
 * @param windows - `{ [provider]: number }` 供 resolveModelInfo 返回的上下文窗口。
 * @param efforts - `{ [provider]: string[] }` 供 resolveModelInfo 返回的 reasoning 档位(缺省=不声明)。
 * @returns `{ llm, calls }`。
 */
export function makeFakeLlm(scripts, windows = {}, efforts = {}) {
  const calls = []
  const llm = {
    async *stream(options) {
      calls.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
      const script = scripts[options.provider]
      if (script === undefined) {
        yield chunk.finishError('NO_ADAPTER', `no adapter registered for provider "${options.provider}"`)
        return
      }
      const produced = script(options)
      if (produced !== null && typeof produced === 'object' && 'throw' in produced) throw produced.throw
      yield* produced
    },
    async resolveModelInfo(provider, model) {
      const window = windows[provider]
      if (window === undefined) throw Object.assign(new Error(`fake: provider "${provider}" 未注册`), { code: 'NO_ADAPTER' })
      const ids = efforts[provider]
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: window },
        ...(ids === undefined ? {} : { reasoning: { efforts: ids.map((id) => ({ id, name: id })) } }),
      }
    },
    listProviders: () => Object.keys(scripts).map((id) => ({ id, name: id })),
  }
  return { llm, calls }
}

/** 收集一个分片流;抛错时把错误一并捕获。 */
export async function drain(iterable) {
  const chunks = []
  let thrown
  try {
    for await (const item of iterable) chunks.push(item)
  } catch (error) {
    thrown = error
  }
  return { chunks, thrown }
}

/** 造一个假的 cordis Context,只实现 lib/index.js 用到的四个面。 */
export function makeFakeCtx() {
  const logs = { info: [], warn: [], error: [] }
  const disposers = []
  const routes = []
  const registered = []
  const ctx = {
    logger: () => ({
      info: (...args) => logs.info.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
      error: (...args) => logs.error.push(args.join(' ')),
    }),
    llm: {
      registerAdapter(providers, adapter) {
        registered.push({ providers, adapter })
        return () => {}
      },
    },
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return () => dispose?.()
    },
    inject(deps, callback) {
      if (deps.includes('webServer')) callback(ctx)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, logs, routes, registered, disposers }
}
