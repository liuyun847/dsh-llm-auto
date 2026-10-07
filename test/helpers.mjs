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
  finishError: (code, message, status, providerRetryAfterMs) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { code, message, ...(status === undefined ? {} : { status }), ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }) } },
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
 * @param catalog - `{ [provider]: Array<{id, name, description?}> | Error }`,给 `listModels()` 用
 *   (插件页的模型选择器读的就是它)。缺省时按该 provider 的每条脚本造一条同名模型,
 *   脚本表里没有的 provider 返回空目录;给 `Error` 则让该 provider 抛错,用来验"逐 provider 隔离失败"。
 * @returns `{ llm, calls }`。
 */
export function makeFakeLlm(scripts, windows = {}, efforts = {}, catalog = {}) {
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
    async listModels(provider) {
      const entry = Object.hasOwn(catalog, provider) ? catalog[provider] : undefined
      if (entry instanceof Error) throw entry
      if (Array.isArray(entry)) return entry.map((model) => ({ provider, ...model }))
      if (!Object.hasOwn(scripts, provider)) return []
      return [{ provider, id: `${provider}-model`, name: `${provider} model` }]
    },
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

/**
 * 造一个假的 cordis Context,只实现 lib/index.js 用到的几个面。
 *
 * `inject()` 的语义照宿主:可选依赖在场才回调。本假的里 **webServer 与 settings 都在场**
 * (settings 尤其重要:apply() 会经它声明 `configure({ auto: false })`,并挂两个 exact 端点)。
 * @param options - 可注入面:`credentials`(额度查询要用;缺省 undefined ⇒ 与"服务不存在"同形)、
 *   `llmStream`(嵌套调用入口 `llm.stream(options)` 的替身;缺省恒报 `NO_ADAPTER` ——
 *   宿主的 llm 服务总会在场,给它一个"总是失败"的实现比让它缺席更接近真实,免得
 *   adapter 走到一半才发现 `llm.stream` 不是函数)。
 *   注意假 ctx 的 `get('credentials')` 一旦给出对象,额度就**不再**退环境变量兜底 ——
 *   这与官方凭据服务的优先级一致(服务在场时由它说了算)。
 * @returns `{ ctx, logs, routes, registered, disposers, settings }`;
 *   `routes` 是 webServer 的登记表(按登记顺序),`settings.configured` 是 configure 的实参表。
 */
export function makeFakeCtx(options = {}) {
  const logs = { info: [], warn: [], error: [] }
  const disposers = []
  const routes = []
  const registered = []
  /** 嵌套调用入口:缺省恒报 NO_ADAPTER(见 @param options.llmStream)。 */
  const stream = typeof options.llmStream === 'function'
    ? options.llmStream
    : async function* failEverything(request) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: `no adapter registered for provider "${request?.provider}"` } } }
      }
  const llm = {
    stream,
    registerAdapter(providers, adapter) {
      registered.push({ providers, adapter })
      return () => {}
    },
  }
  // `describe()` 是 /routes 端点的 writable 字段读的那一支(形如 dsh-settings 的描述符表);
  // 各表单都带 writable,非回环页面时是 false。`writableRows` 可改,用来演只读部署。
  const settings = { configured: [], writableRows: true }
  const ctx = {
    logger: () => ({
      info: (...args) => logs.info.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
      error: (...args) => logs.error.push(args.join(' ')),
    }),
    llm,
    settings: {
      configure(presentation) {
        settings.configured.push(presentation)
        return () => {}
      },
      describe() {
        return [{ ns: 'llm-auto', revision: 0, writable: settings.writableRows }]
      },
    },
    /** cordis 的可选服务查询口(1.x 起是可选方法):问不到就返回 undefined。 */
    get(key) {
      if (key === 'settings') return ctx.settings
      if (key === 'llm') return llm
      if (key === 'credentials') return options.credentials
      return undefined
    },
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return () => dispose?.()
    },
    inject(deps, callback) {
      const available = deps.filter((dep) => dep === 'webServer' || dep === 'settings')
      if (available.length === deps.length) callback(ctx)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, logs, routes, registered, disposers, settings }

}
