/**
 * 挂载行为:`apply()` 读配置、注册路由、挂 HTTP 端点,以及"配置坏掉时不拖垮宿主"。
 * 用假 ctx(只实现 lib/index.js 真正用到的几个面)驱动,不需要起 harness。
 *
 * v0.6.0 起两处形状变化写进了本文件的断言:
 *  · 端点登记表有**三个**(`/routes`、`/catalog`、`/diag`)⇒ 取处理器一律用 {@link findRoute},
 *    不再假设下标 0 是哪一条;
 *  · `chain` 的每一项从裸字符串变成 `{ label, options? }`(面板要画逐条开关)。
 * v0.7.0 再加一段:`/routes` 顶层多了 `quota`(只读额度快照)与 `user`(profile 覆盖链,
 * 只有确有覆盖时才出现)—— 两者都**不改变** handler 的同步性与状态码。
 */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { CATALOG_PATH, DEFAULT_ORDERING_RETRY_MS, DEFAULT_ORDERING_TTL_MS, DIAG_PATH, Config, apply, ROUTES_PATH } from '../lib/index.js'
import { makeFakeCtx, makeFakeLlm } from './helpers.mjs'

const ROUTES = [
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'ww', model: 'gpt-6-astra' },
]

/** 按路径取端点处理器(登记表里两条,顺序不该被测试依赖)。 */
function findRoute(routes, path) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `端点 ${path} 没登记`)
  return route
}

/** 链响应的每一项 → 它在旧版里就是那个裸字符串(取 label 便于与既有断言对齐)。 */
const chainLabels = (body) => body.chain.map((item) => item.label)

/** cosmokit 的 volatile 引用标记(宿主里 `.volatile()` 字段拿到的就是这种引用)。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 造一个与宿主同形的 volatile 引用,值可原地改。
 * @returns `{ ref, set }` —— `set()` 模拟"设置页写入了新值"。
 */
function mutableVolatile(initial) {
  let current = initial
  return {
    ref: Object.freeze({ get: () => current, [VOLATILE_WRITE]: () => {} }),
    set: (next) => { current = next },
  }
}

/** 造一个最小 req/res,把 handler 的输出收下来。 */
function invoke(handler, url) {
  const captured = { status: undefined, headers: undefined, body: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text ?? ''
    },
  }
  handler({ url }, res)
  return { ...captured, json: captured.body.length > 0 ? JSON.parse(captured.body) : undefined }
}

/** 等端点(异步)把响应写完:`invoke` 是同步的,目录端点要先 await 一拍。 */
async function invokeAsync(handler, url, method = 'GET') {
  const captured = { status: undefined, headers: undefined, body: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text ?? ''
    },
  }
  handler({ method, url }, res)
  for (let tick = 0; tick < 20 && captured.body === ''; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  return { ...captured, json: captured.body.length > 0 ? JSON.parse(captured.body) : undefined }
}

/** 发一条带 JSON 正文的请求(诊断端点用):`invokeAsync` 只发 GET,这里补上写路径。 */
async function postJson(handler, url, payload) {
  return postText(handler, url, JSON.stringify(payload))
}

/** 发一条带任意文本正文的请求(诊断端点用)。 */
async function postText(handler, url, body) {
  const captured = { status: undefined, headers: undefined, body: '' }
  const listeners = new Map()
  const req = {
    method: 'POST',
    url,
    on(event, listener) {
      listeners.set(event, listener)
      return req
    },
  }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text ?? ''
    },
  }
  handler(req, res)
  // 请求体是异步给到的:按实现的读法推一次 data + end
  listeners.get('data')?.(Buffer.from(body, 'utf8'))
  listeners.get('end')?.()
  for (let tick = 0; tick < 20 && captured.body === ''; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  return { ...captured, json: captured.body.length > 0 ? JSON.parse(captured.body) : undefined }
}

/** 把一个 auto 请求的分片流吃完(只为了驱动 ring 写记录;内容无所谓)。全部失败也不抛。 */
async function drainVia(adapter, options = { provider: 'auto', model: 'auto', messages: [] }) {
  try {
    for await (const chunk of adapter.stream(options)) {
      void chunk
    }
  } catch {
    // 全部路由都失败时 adapter 会抛聚合错误:这里只关心副作用(ring / 回调 / 冷却),所以吞掉。
  }
}

describe('apply:注册与配置解析', () => {
  it('正常配置:注册 auto 路由 + 挂三个端点,并打两条 info(注册 + 窗口口径)', () => {
    const { ctx, logs, routes, registered, settings } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0].providers, ['auto'])
    assert.equal(routes.length, 3, '0.6.0 起有三个 exact 端点:/routes、/catalog 与 /diag')
    assert.deepEqual(routes.map((route) => route.path), [ROUTES_PATH, CATALOG_PATH, DIAG_PATH])
    assert.ok(routes.every((route) => route.kind === 'exact'))
    assert.deepEqual(settings.configured, [{ auto: false }], '自带页面 ⇒ 关掉设置页的自动生成表单')
    assert.equal(logs.info.length, 2)
    const [registered1, windowLine] = logs.info
    assert.match(registered1, /已注册路由 auto\/auto/u)
    assert.match(registered1, /commandcode\/deepseek\/deepseek-v4\.1-flash → ww\/gpt-6-astra/u)
    assert.match(registered1, /重试: 每路由最多 5 次/u, 'retry 缺省 ⇒ 官方默认(5 次重试)')
    assert.match(windowLine, /未配置 compactWindow\/contextWindow/u, '直接调用 apply 且没给 compactWindow ⇒ 走逐跳解析口径')
    assert.match(windowLine, /65536/u)
  })

  it('retry 缺省 ⇒ 官方默认策略(每路由 5 次重试,瞬时码白名单,500→10000ms)', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.deepEqual(body.json.retry, {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10000,
      jitterRatio: 0.1,
    })
  })

  it('retry: { maxRetries: 0 } ⇒ 关闭路由内重试(每路由只尝试一次)', () => {
    const { ctx, routes, logs } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, retry: { maxRetries: 0 } })
    assert.equal(logs.warn.length, 0)
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.equal(body.json.retry.maxRetries, 0)
  })

  it('retry 配置坏 ⇒ 只 warn 不拖垮宿主,回落官方默认(插件约定:配置错误不该让宿主起不来)', () => {
    for (const retry of [{ maxRetries: -1 }, { backoff: { initialDelayMs: 99999, maxDelayMs: 1 } }, { mode: 'always' }, 'nope', { attempts: 5 }]) {
      const { ctx, logs, registered, routes } = makeFakeCtx()
      assert.doesNotThrow(() => apply(ctx, { routes: ROUTES, retry }))
      assert.equal(registered.length, 1, `${JSON.stringify(retry)} 不该阻止注册`)
      assert.equal(routes.length, 3)
      assert.equal(logs.error.length, 0, '坏 retry 不该升级成 error')
      assert.ok(logs.warn.length >= 1)
      const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH)
      assert.equal(body.json.retry.maxRetries, 5, `${JSON.stringify(retry)} 应回落官方默认`)
    }
  })

  it('routes 缺失/为空:打一条 error 并**不注册**(不抛错 ⇒ 宿主照常启动)', () => {
    for (const config of [{}, { routes: [] }, { routes: 'nope' }]) {
      const { ctx, logs, registered, routes } = makeFakeCtx()
      assert.doesNotThrow(() => apply(ctx, config))
      assert.equal(registered.length, 0, `${JSON.stringify(config)} 不该注册适配器`)
      assert.equal(routes.length, 0)
      assert.equal(logs.error.length, 1)
      assert.match(logs.error[0], /routes/u)
    }
  })

  it('链里出现 provider: auto ⇒ warn 并跳过该条,其余照常', () => {
    const { ctx, logs, registered } = makeFakeCtx()
    apply(ctx, { routes: [{ provider: 'auto', model: 'auto' }, ...ROUTES] })
    assert.equal(registered.length, 1)
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /跳过第 1 条路由 auto\/auto/u)
    assert.match(logs.warn[0], /自递归/u)
  })

  it('name / contextWindow / logLimit 生效', async () => {
    const { ctx, routes, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, name: '我的聚合模型', contextWindow: 4096, logLimit: 2 })
    const adapter = registered[0].adapter
    const models = await adapter.listModels('auto')
    assert.equal(models[0].name, '我的聚合模型')
    const info = await adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 4096, '配置里的 contextWindow 应覆盖"取首选路由窗口"')

    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.equal(body.json.name, '我的聚合模型')
    assert.equal(body.json.capacity, 2)
    assert.deepEqual(chainLabels(body.json), ['commandcode/deepseek/deepseek-v4.1-flash', 'ww/gpt-6-astra'])
  })

  it('不配 contextWindow 时取第一条可解析路由的窗口', async () => {
    const { ctx, registered } = makeFakeCtx()
    ctx.llm.resolveModelInfo = async (provider, model) => {
      if (provider !== 'ww') throw Object.assign(new Error('未注册'), { code: 'NO_ADAPTER' })
      return { provider, id: model, name: model, context: { contextWindow: 262144 } }
    }
    apply(ctx, { routes: ROUTES })
    const info = await registered[0].adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 262144)
  })

  it('没声明 webServer 的 profile(如 headless):照样注册适配器,只是没有 HTTP 端点', () => {
    const { ctx, registered, routes } = makeFakeCtx()
    const originalInject = ctx.inject
    ctx.inject = (deps, callback) => {
      if (deps.includes('webServer')) return // 模拟服务不存在
      return originalInject(deps, callback)
    }
    apply(ctx, { routes: ROUTES })
    assert.equal(registered.length, 1)
    assert.equal(routes.length, 0)
  })

  it('没声明 settings 的 profile:注入回调不跑,插件本体照常', () => {
    const { ctx, registered, settings } = makeFakeCtx()
    const originalInject = ctx.inject
    ctx.inject = (deps, callback) => {
      if (deps.includes('settings')) return
      return originalInject(deps, callback)
    }
    apply(ctx, { routes: ROUTES })
    assert.equal(registered.length, 1)
    assert.deepEqual(settings.configured, [], 'settings 不在场 ⇒ 一次 configure 都不该发')
  })
})

describe('apply:compactWindow(压缩点 → 声明窗口)', () => {
  it('compactWindow: 500000 ⇒ 声明 625000,挂载日志带上映射结果与假设常量', async () => {
    const { ctx, logs, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, compactWindow: 500000 })
    const info = await registered[0].adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 625000)
    assert.deepEqual(logs.warn, [])
    assert.equal(logs.info.length, 2)
    assert.match(logs.info[1], /^auto: 压缩点 500000 → 声明窗口 625000\(假设 compaction-basic thresholdRatio 0\.8 \/ headroomTokens 65536\)$/u)
  })

  it('宿主形态(真 schema 校验过的配置)⇒ 默认口径就是映射:声明 625000,零 warn', async () => {
    // 这条走的是宿主真实路径:schema 补默认值 500000 + 把 routes/compactWindow 包装成 volatile 引用。
    const resolved = Config['~standard'].validate({ routes: ROUTES }).value
    const { ctx, logs, registered } = makeFakeCtx()
    apply(ctx, resolved)
    const info = await registered[0].adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 625000, '默认从"逐跳解析出的 884000"变成"压缩点反算出的 625000"')
    assert.deepEqual(logs.warn, [])
    assert.match(logs.info[1], /压缩点 500000 → 声明窗口 625000/u)
  })

  it('与 contextWindow 同时给出 ⇒ 用 compactWindow、忽略 contextWindow,并 warn 说明两者', async () => {
    const { ctx, logs, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, compactWindow: 400000, contextWindow: 4096 })
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /同时给出/u)
    assert.match(logs.warn[0], /忽略 contextWindow\(4096\)/u)
    const info = await registered[0].adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 500000, 'compactWindow 400000 ⇒ 500000(不是 4096)')
  })

  it('compactWindow 非法 ⇒ 只 warn 不拖垮宿主,回落默认 500000 ⇒ 声明 625000', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '500000']) {
      const { ctx, logs, registered, routes } = makeFakeCtx()
      assert.doesNotThrow(() => apply(ctx, { routes: ROUTES, compactWindow: bad }))
      assert.equal(registered.length, 1, `${String(bad)} 不该阻止注册`)
      assert.equal(routes.length, 3)
      assert.equal(logs.error.length, 0, '坏 compactWindow 不该升级成 error')
      assert.match(logs.warn[0], /应为正整数/u)
      const info = await registered[0].adapter.resolveModel('auto', 'auto')
      assert.equal(info.context.contextWindow, 625000, `${String(bad)} 应回落默认 500000 的映射`)
    }
  })

  it('compactWindow 过小(< 12484)⇒ 另打一条 warn 点名 TargetPressureConfigError', async () => {
    const { ctx, logs, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, compactWindow: 4096 })
    assert.equal(logs.warn.length, 1)
    assert.match(logs.warn[0], /偏小/u)
    assert.match(logs.warn[0], /TargetPressureConfigError/u)
    const info = await registered[0].adapter.resolveModel('auto', 'auto')
    assert.equal(info.context.contextWindow, 4096 + 65536)
  })

  it('设置页改写 volatile 引用 ⇒ 不用重启重新 apply 就生效(name / compactWindow / logLimit)', async () => {
    const name = mutableVolatile('Auto')
    const compact = mutableVolatile(300000)
    const limit = mutableVolatile(50)
    const { ctx, routes, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES, name: name.ref, compactWindow: compact.ref, logLimit: limit.ref })

    const adapter = registered[0].adapter
    const endpoint = findRoute(routes, ROUTES_PATH).handler
    assert.equal((await adapter.listModels('auto'))[0].name, 'Auto')
    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 375000)
    assert.equal(invoke(endpoint, ROUTES_PATH).json.capacity, 50)

    // 模拟设置页写入:值原地变,引用对象不变(宿主对 volatile-only 改动就是这一条路)
    name.set('我的聚合模型')
    compact.set(500000)
    limit.set(3)

    assert.equal((await adapter.listModels('auto'))[0].name, '我的聚合模型')
    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 625000)
    const body = invoke(endpoint, ROUTES_PATH)
    assert.equal(body.json.capacity, 3)
    assert.equal(body.json.name, '我的聚合模型')
    assert.equal(body.json.compactWindow, 500000)
    assert.equal(body.json.declaredContextWindow, 625000)
  })
})

describe('apply:回退链可在运行中改(v0.6.0)', () => {
  it('routes 引用被原地改写 ⇒ 下一次请求走新链,不用重新 apply/重启', async () => {
    const chain = mutableVolatile(ROUTES)
    const { ctx, logs, routes, registered, settings } = makeFakeCtx()
    apply(ctx, { routes: chain.ref })
    assert.deepEqual(settings.configured, [{ auto: false }])
    assert.deepEqual(logs.error, [])

    const adapter = registered[0].adapter
    const endpoint = findRoute(routes, ROUTES_PATH).handler
    const calls = []
    ctx.llm.stream = async function* (options) {
      calls.push(`${options.provider}/${options.model}`)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    // 改链:把 ww 提到首选,并删掉 commandcode
    chain.set([{ provider: 'ww', model: 'gpt-6-astra' }])
    await drainVia(adapter)
    assert.deepEqual(calls, ['ww/gpt-6-astra'], '新链立刻生效(旧链首条 commandcode 不再被尝试)')
    assert.deepEqual(chainLabels(invoke(endpoint, ROUTES_PATH).json), ['ww/gpt-6-astra'])
    assert.match((await adapter.listModels('auto'))[0].description, /ww\/gpt-6-astra/u, '目录描述也跟着新链')

    // 改回去:两条都回来,顺序也回来
    chain.set([
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      { provider: 'ww', model: 'gpt-6-astra' },
    ])
    calls.length = 0
    ctx.llm.stream = async function* (options) {
      calls.push(`${options.provider}/${options.model}`)
      if (options.provider === 'commandcode') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'boom' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await drainVia(adapter)
    assert.deepEqual(calls, ['commandcode/deepseek/deepseek-v4.1-flash', 'ww/gpt-6-astra'], '顺序恢复')
  })

  it('改链后上下文窗口缓存立刻失效(不然改完还会按旧首选的窗口反算压缩点)', async () => {
    const chain = mutableVolatile([{ provider: 'small', model: 'm' }])
    const { ctx, registered } = makeFakeCtx()
    ctx.llm.resolveModelInfo = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: provider === 'small' ? 100000 : 700000 } })
    apply(ctx, { routes: chain.ref })
    const adapter = registered[0].adapter

    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 100000)
    chain.set([{ provider: 'big', model: 'm' }])
    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 700000, '链签名一变就该重新解析,不能等 TTL 过期')
  })

  it('链里带着打开的单条开关时,/routes 的 chain 会把 options 一并回传', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, {
      routes: [
        { provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true, breakToolLoop: true },
        { provider: 'ww', model: 'gpt-6-astra' },
      ],
    })
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH).json
    assert.deepEqual(body.chain[0], {
      label: 'deepseek-official/deepseek-flash',
      options: { keepThinking: true, breakToolLoop: true },
    })
    assert.deepEqual(body.chain[1], { label: 'ww/gpt-6-astra' }, '没开开关的条目不带 options 键')
  })
})

describe('GET /api/llm-auto/catalog(v0.6.0)', () => {
  it('把 live 注册表投影成"分组 + 模型名",字段是白名单', async () => {
    const scripts = {
      commandcode: () => [],
      'opencode-go': () => [],
      ww: () => [],
    }
    const { llm } = makeFakeLlm(scripts, {}, {}, {
      commandcode: [
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: '自动路由:…', apiKeyEnv: 'CMD_API_KEY' },
        { id: 'deepseek/deepseek-v4.1-flash-fast', name: 'DeepSeek V4.1 Flash Fast' },
      ],
      'opencode-go': [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (OpenCode Go)' }],
      ww: [],
    })
    const { ctx, routes } = makeFakeCtx()
    // 只换"目录面",保留 registerAdapter(apply 要注册适配器,那是假 ctx 的职责)
    ctx.llm.listProviders = llm.listProviders
    ctx.llm.listModels = llm.listModels
    apply(ctx, { routes: ROUTES })
    const body = await invokeAsync(findRoute(routes, CATALOG_PATH).handler, CATALOG_PATH)

    assert.equal(body.status, 200)
    assert.deepEqual(body.json.failures, [])
    assert.deepEqual(body.json.groups.map((group) => group.id), ['commandcode', 'opencode-go', 'ww'])
    assert.equal(body.json.groups[0].models[0].id, 'deepseek/deepseek-v4.1-flash')
    assert.equal(body.json.groups[0].models[0].name, 'DeepSeek V4.1 Flash')
    assert.deepEqual(Object.keys(body.json.groups[0].models[0]).sort(), ['description', 'id', 'name'], '凭据引用之类一律不外传')
    assert.deepEqual(body.json.groups[2].models, [], '空目录的 provider 保留在 groups 里(前端据此显示成"没有模型")')
  })

  it('逐 provider 隔离失败:一个 provider 抛错不拖垮整次读取', async () => {
    const scripts = { good: () => [], bad: () => [] }
    const { llm } = makeFakeLlm(scripts, {}, {}, {
      good: [{ id: 'm1', name: 'M1' }],
      bad: new Error('boom: 目录读取失败'),
    })
    const { ctx, routes } = makeFakeCtx()
    ctx.llm.listProviders = llm.listProviders
    ctx.llm.listModels = llm.listModels
    apply(ctx, { routes: [{ provider: 'good', model: 'm1' }] })
    const body = await invokeAsync(findRoute(routes, CATALOG_PATH).handler, CATALOG_PATH)

    assert.equal(body.status, 200)
    assert.deepEqual(body.json.groups.map((group) => group.id), ['good'])
    assert.deepEqual(body.json.failures.map((failure) => failure.id), ['bad'])
    assert.match(body.json.failures[0].message, /目录读取失败/u)
  })
})

describe('GET /api/llm-auto/routes', () => {
  it('空缓冲时返回链与容量', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, `${ROUTES_PATH}?limit=10`)
    assert.equal(body.status, 200)
    assert.match(body.headers['content-type'], /application\/json/u)
    assert.equal(body.json.provider, 'auto')
    assert.equal(body.json.model, 'auto')
    assert.equal(body.json.total, 0)
    assert.deepEqual(body.json.routes, [])
  })

  it('writable 字段:活着算 —— 设置服务不可写时如实报 false(面板据此退回只读)', () => {
    const writable = makeFakeCtx()
    apply(writable.ctx, { routes: ROUTES })
    const body = invoke(findRoute(writable.routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.equal(body.json.writable, true)

    const readOnly = makeFakeCtx()
    readOnly.settings.writableRows = false
    apply(readOnly.ctx, { routes: ROUTES })
    const readOnlyBody = invoke(findRoute(readOnly.routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.equal(readOnlyBody.json.writable, false, '…false 时面板不显示保存按钮')

    const noSettings = makeFakeCtx()
    const originalInject = noSettings.ctx.inject
    noSettings.ctx.inject = (deps, callback) => {
      if (deps.includes('settings')) return
      return originalInject(deps, callback)
    }
    noSettings.ctx.settings = undefined
    apply(noSettings.ctx, { routes: ROUTES })
    const noSettingsBody = invoke(findRoute(noSettings.routes, ROUTES_PATH).handler, ROUTES_PATH)
    assert.equal(noSettingsBody.json.writable, false, '拿不到设置服务 ⇒ 只能看不能改')
  })

  it('非法 limit 不报错(退化为不限)', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, `${ROUTES_PATH}?limit=abc`)
    assert.equal(body.status, 200)
    assert.deepEqual(body.json.routes, [])
  })

  it('复核字段:compactWindow 与 declaredContextWindow', async () => {
    // 配了压缩点:两个字段都是确定值
    const mapped = makeFakeCtx()
    apply(mapped.ctx, { routes: ROUTES, compactWindow: 400000 })
    const mappedBody = invoke(findRoute(mapped.routes, ROUTES_PATH).handler, ROUTES_PATH).json
    assert.equal(mappedBody.compactWindow, 400000)
    assert.equal(mappedBody.declaredContextWindow, 500000)

    // 没配压缩点(直接调用 apply 的场合):compactWindow 为 null;声明窗口要等第一次目录解析
    const { ctx, routes, registered } = makeFakeCtx()
    ctx.llm.resolveModelInfo = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 884000 } })
    apply(ctx, { routes: ROUTES })
    const endpoint = findRoute(routes, ROUTES_PATH).handler
    const before = invoke(endpoint, ROUTES_PATH).json
    assert.equal(before.compactWindow, null)
    assert.equal(before.declaredContextWindow, null, '还没解析过目录 ⇒ null(而不是编一个数)')
    await registered[0].adapter.resolveModel('auto', 'auto')
    const after = invoke(endpoint, ROUTES_PATH).json
    assert.equal(after.declaredContextWindow, 884000)
  })

  it('/diag:GET 读回报告表,POST 收一条(页面侧自诊断通道)', async () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const endpoint = findRoute(routes, DIAG_PATH).handler

    // 空缓冲:形状固定,前端据此判断"有没有东西"
    const empty = await invokeAsync(endpoint, DIAG_PATH)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.reports, [])
    assert.ok(empty.json.limit > 0)

    // 收一条合法的
    const posted = await postJson(endpoint, DIAG_PATH, { where: 'apply', message: 'boom', stack: 'at x' })
    assert.equal(posted.status, 200)
    assert.equal(posted.json.ok, true)

    // 再收一条**不是合法 JSON** 的:原样留原文(排查时比"解析失败"有用)
    const raw = await postText(endpoint, DIAG_PATH, 'not json at all')
    assert.equal(raw.status, 200)

    const body = await invokeAsync(endpoint, DIAG_PATH)
    assert.equal(body.json.reports.length, 2)
    assert.equal(body.json.reports[0].where, 'apply')
    assert.equal(body.json.reports[0].message, 'boom')
    assert.equal(typeof body.json.reports[0].at, 'string', '每条都盖时间戳')
    assert.equal(body.json.reports[1].raw, 'not json at all')

    // 只收 GET/POST
    const rejected = await invokeAsync(endpoint, DIAG_PATH, 'DELETE')
    assert.equal(rejected.status, 405)
  })

  it('calls 字段:按一次请求分组,与平铺 routes 同源(0.5.0 插件页面板读它)', async () => {
    const { ctx, routes, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const adapter = registered[0].adapter
    // 假上游:第一次请求首条以**非瞬时**错误失败(不进重试白名单 ⇒ 不退避,直接切下一条),
    // 第二次请求首条直接成功。这样两个请求的 ring 记录分别是 2 条与 1 条。
    let hit = 0
    ctx.llm.stream = async function* (options) {
      hit += 1
      if (options.provider === 'commandcode' && hit === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'boom' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await drainVia(adapter)
    await drainVia(adapter)

    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH).json
    assert.ok(Array.isArray(body.calls))
    assert.equal(body.calls.length, 2, '两次请求各一组')
    assert.deepEqual(body.calls.map((call) => call.call), [2, 1], 'desc:最近一次在前')
    assert.equal(body.calls[0].outcome, 'ok')
    assert.equal(body.calls[1].outcome, 'ok')
    assert.equal(body.calls[1].routes.length, 2, '第一次请求回退了一次 ⇒ 两行')
    assert.equal(body.calls[1].routes[0].switched, true)
    assert.equal(body.calls[1].routes[0].code, 'NO_ADAPTER')
    assert.equal(body.calls[1].routes[0].switchedTo, 'ww/gpt-6-astra')
    assert.equal(body.calls[1].routes[1].ok, true)
    assert.equal(body.calls[0].routes.length, 1, '第二次请求首条即成功 ⇒ 一行')
    // 平铺 routes 与 calls 数据同源
    assert.equal(body.routes.length, 3)
    assert.equal(body.total, 3)
  })
})

describe('quota 与 user 字段(v0.7.0)', () => {
  /** 2026-10-05 实测形状(已脱敏;只留 quota 用到的字段)。 */
  const CREDITS = {
    credits: { monthlyCredits: 59.9240242796, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0.622990592, cap: 14, exceeded: false, resetAt: 1791202779495 },
      weekly: { used: 10.0759757204, cap: 35, exceeded: false, resetAt: 1791727383630 },
    },
  }
  const SUBSCRIPTIONS = { success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-11-04T14:00:31.000Z', cancelAtPeriodEnd: false, endedAt: null } }
  const GO_USAGE = {
    usage: {
      rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-05T12:41:30.831Z' },
      weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-24T00:00:44.000Z' },
    },
  }
  /** 只用于"响应里不许出现它"的桩值(不是真 key)。 */
  const STUB_KEY = 'sk-TEST-ONLY-0123456789abcdef'

  /** 额度查询只看**链上出现**的 provider ⇒ 这一组用例用一条带 `opencode-go` 的链。 */
  const QUOTA_ROUTES = [
    { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  ]

  /** 让 handler 里那次 fire-and-forget 的刷新跑完(handler 自己是同步的)。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('无凭据:端点仍 200,且不可查的来源一个数字都不给', async () => {
    const credentials = { resolve: async () => undefined }
    const { ctx, routes } = makeFakeCtx({ credentials })
    apply(ctx, { routes: QUOTA_ROUTES })
    const endpoint = findRoute(routes, ROUTES_PATH).handler

    const first = invoke(endpoint, ROUTES_PATH)
    assert.equal(first.status, 200)
    assert.equal(first.json.quota.state, 'pending', '还没刷过 ⇒ pending')
    assert.deepEqual(first.json.quota.sources, [], 'pending 时不列来源(面板只显示"查询中")')

    await settle()
    const body = invoke(endpoint, ROUTES_PATH).json
    assert.equal(body.quota.state, 'fresh')
    assert.deepEqual(body.quota.sources.map((source) => source.provider), ['commandcode', 'opencode-go'], '顺序跟随链')
    for (const source of body.quota.sources) {
      assert.equal(source.status, 'unavailable')
      assert.equal(source.reason, 'no-credential')
      assert.equal('credits' in source, false, '不可查就不给数字(不是 0、不是 null)')
      assert.equal('windows' in source, false)
      assert.equal('plan' in source, false)
    }
  })

  it('注入凭据与 fetch 桩:两源 ok,且响应里绝不出现凭据值', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init === undefined ? {} : init.headers })
      const body = String(url).includes('/alpha/billing/credits')
        ? CREDITS
        : String(url).includes('/alpha/billing/subscriptions')
          ? SUBSCRIPTIONS
          : GO_USAGE
      return { ok: true, status: 200, json: async () => body }
    }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      const { ctx, routes } = makeFakeCtx({ credentials })
      apply(ctx, { routes: QUOTA_ROUTES })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()

      const body = invoke(endpoint, ROUTES_PATH).json
      assert.equal(body.quota.state, 'fresh')
      assert.equal(body.quota.sources.length, 2)
      const [cc, go] = body.quota.sources
      assert.equal(cc.status, 'ok')
      assert.equal(cc.credits.total, 59.9240242796, '余额 = monthly + purchased + free')
      assert.equal(cc.windows.fiveHour.cap, 14)
      assert.equal(cc.plan.planId, 'individual-goat')
      assert.equal(cc.ref, 'CMD_API_KEY', '只回引用名')
      assert.equal(go.status, 'ok')
      assert.equal(go.windows.monthly.status, 'rate-limited', 'status 原样带出(面板据此显示"已耗尽")')
      assert.equal(go.windows.monthly.percent, 100)
      assert.equal('credits' in go, false, 'Go 没有金额口径')
      assert.equal(go.ref, 'OPENCODE_API_KEY')
      assert.ok(!JSON.stringify(body).includes(STUB_KEY), '响应里绝不能出现凭据值')
      for (const call of calls) assert.match(String(call.headers['user-agent']), /^Mozilla\/5\.0 /u)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('查询整体失败:只体现在 quota 里 —— 端点仍 200,链与记录一字不变', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'env' }) }
      const { ctx, routes } = makeFakeCtx({ credentials })
      apply(ctx, { routes: QUOTA_ROUTES })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()

      const response = invoke(endpoint, ROUTES_PATH)
      assert.equal(response.status, 200)
      assert.deepEqual(response.json.quota.sources.map((source) => source.reason), ['network', 'network'])
      assert.deepEqual(chainLabels(response.json), ['commandcode/deepseek/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash'])
      assert.deepEqual(response.json.routes, [])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('user 字段:只有 profile 层确实覆盖了 routes 才出现(「恢复包内默认链」的判据)', () => {
    const covered = makeFakeCtx()
    // ⚠ 假 ctx 的 `get('settings')` 返回的是 `ctx.settings` 那个字面量(不是 makeFakeCtx 另导出的
    // 状态对象)⇒ 覆盖 describe 必须打在 `ctx.settings` 上,否则不生效。
    covered.ctx.settings.describe = () => [{ ns: 'llm-auto', revision: 1, writable: true, user: { routes: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] } }]
    apply(covered.ctx, { routes: QUOTA_ROUTES })
    const body = invoke(findRoute(covered.routes, ROUTES_PATH).handler, ROUTES_PATH).json
    assert.deepEqual(body.user, { routes: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] })
    assert.equal(body.writable, true, 'user 不影响可写判定')

    const cases = [
      ['没有覆盖(空 user)', {}],
      ['只覆盖了 compactWindow', { compactWindow: 400000 }],
      ['覆盖里 routes 是坏形状', { routes: 'nope' }],
    ]
    for (const [label, user] of cases) {
      const { ctx, routes } = makeFakeCtx()
      ctx.settings.describe = () => [{ ns: 'llm-auto', revision: 0, writable: true, user }]
      apply(ctx, { routes: QUOTA_ROUTES })
      const plain = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH).json
      assert.equal('user' in plain, false, `${label} ⇒ 整个键缺席(面板不画那个按钮)`)
    }
  })
})

describe('ordering 字段:额度感知排序 + 冷却(v0.8.0)', () => {
  /** 链上两家都认识的一个"订阅 + 按量"组合(`deepseek-official` 不在额度来源里 ⇒ 落未知档)。 */
  const ORDER_ROUTES = [
    { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', keepThinking: true },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  ]
  const STUB_KEY = 'sk-TEST-ONLY-0123456789abcdef'
  /** 让 handler 里那次 fire-and-forget 的刷新跑完(handler 自己是同步的)。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  /**
   * 造一份 fetch 桩并装到全局(调用方负责恢复)。
   *
   * ⚠ 重置时刻**相对当前时刻**生成:写死日期会让"CC 的月度周期末在 Go 之后"这个前提
   * 随日历过期(而那正是排序结论所依赖的唯一事实)。
   * @param goExhausted - Go 的月度档是否报 `rate-limited`。
   * @returns `{ restore, goResetAt }`。
   */
  function installFetch(goExhausted) {
    const original = globalThis.fetch
    const now = Date.now()
    const goResetAt = new Date(now + 30 * 24 * 3600 * 1000).toISOString()
    const ccPeriodEnd = new Date(now + 360 * 24 * 3600 * 1000).toISOString()
    const credits = {
      credits: { monthlyCredits: 49.57, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: { fiveHour: { used: 1, cap: 14, exceeded: false, resetAt: now + 3600 * 1000 } },
    }
    const subscriptions = { success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: ccPeriodEnd, cancelAtPeriodEnd: false, endedAt: null } }
    const goUsage = {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: new Date(now + 4 * 3600 * 1000).toISOString() },
        weekly: { status: 'ok', percent: 0, resetsAt: new Date(now + 5 * 24 * 3600 * 1000).toISOString() },
        monthly: { status: goExhausted ? 'rate-limited' : 'ok', percent: goExhausted ? 100 : 0, resetsAt: goResetAt },
      },
    }
    const body = (url) => (String(url).includes('/alpha/billing/credits') ? credits : String(url).includes('/alpha/billing/subscriptions') ? subscriptions : goUsage)
    globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => body(url) })
    return { restore: () => { globalThis.fetch = original }, goResetAt }
  }

  it('字段形状:chain 仍是配置顺序;effective 是实际顺序(带 reason);cooldown 是只读表', async () => {
    const { restore, goResetAt } = installFetch(true)
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      const { ctx, routes } = makeFakeCtx({ credentials })
      apply(ctx, { routes: ORDER_ROUTES })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()
      const response = invoke(endpoint, ROUTES_PATH)
      assert.equal(response.status, 200)
      const body = response.json

      // ① 编辑契约不动:chain 仍逐字是配置顺序
      assert.deepEqual(chainLabels(body), [
        'commandcode/deepseek/deepseek-v4.1-flash',
        'opencode-go/deepseek-v4.1-flash',
        'deepseek-official/deepseek-flash',
      ])
      assert.equal(body.chain[1].options.keepThinking, true, 'chain 的 options 一字不变')

      // ② effective:CC 的月度周期末晚于 Go 的月度重置 ⇒ Go 在前;官方不在额度来源里 ⇒ 未知档
      assert.deepEqual(body.ordering.mode, 'auto', '缺省就是 auto')
      assert.equal(body.ordering.ignoredCooldown, false)
      assert.deepEqual(body.ordering.effective.map((item) => item.label), [
        'opencode-go/deepseek-v4.1-flash',
        'commandcode/deepseek/deepseek-v4.1-flash',
        'deepseek-official/deepseek-flash',
      ])
      assert.deepEqual(body.ordering.effective.map((item) => item.reason), ['monthly-reset-asc', 'monthly-reset-asc', 'unknown'])
      const go = body.ordering.effective[0]
      assert.equal(go.provider, 'opencode-go')
      assert.equal(go.model, 'deepseek-v4.1-flash', 'effective 是可用的路由形状(适配器直接拿它当链)')
      assert.equal(go.keepThinking, true)
      assert.equal(go.cooling, undefined, '还没报过 QUOTA ⇒ 不冷却')

      // ③ cooldown:0.8.0 起端点恒有这个只读字段(即使一次都没冷却过)
      assert.deepEqual(body.ordering.cooldown, [])

      // ④ 其它既有字段一字未改
      assert.equal(body.provider, 'auto')
      assert.equal(body.model, 'auto')
      assert.equal(body.quota.sources.length, 2, '只有认识的两家出现在额度快照里')
    } finally {
      restore()
    }
  })

  it('manual ⇒ effective 严格按配置顺序、cooldown 恒空;切回 auto 复原(冷却表不动)', async () => {
    const { restore } = installFetch(true)
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      // 嵌套调用恒以 QUOTA 告吹:用来让宿主侧**真的**走一遍"补查额度 ⇒ 冷却"。
      const quotaFailure = async function* stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'Insufficient credits', status: 400 } } }
      }
      const { ctx, routes, registered, logs } = makeFakeCtx({ credentials, llmStream: quotaFailure })
      const ordering = mutableVolatile({ mode: 'auto' })
      apply(ctx, { routes: ORDER_ROUTES, ordering: ordering.ref })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()
      const auto = invoke(endpoint, ROUTES_PATH).json
      assert.deepEqual(auto.ordering.cooldown, [], '还没发生过 QUOTA 失败 ⇒ 冷却表是空的')
      assert.equal(auto.ordering.effective[0].provider, 'opencode-go', 'auto 下 Go 排最前')

      // 让实际顺序里的第一条(Go)以 QUOTA 告吹一次 ⇒ 宿主补查额度、确认月度耗尽 ⇒ 冷却。
      await drainVia(registered[0].adapter)
      await settle()
      const cooled = invoke(endpoint, ROUTES_PATH).json
      assert.equal(cooled.ordering.cooldown.length, 1, '一次 QUOTA 失败 ⇒ 冷却表里出现一家')
      assert.equal(cooled.ordering.cooldown[0].provider, 'opencode-go')
      assert.ok(Number.isFinite(cooled.ordering.cooldown[0].until), 'until 是毫秒时间戳')
      // ② 冷却行要说清"是哪一档打满":固定枚举的窗口 id(Go 的月度档 rate-limited ⇒ monthly)
      assert.deepEqual(cooled.ordering.cooldown[0].windows, ['monthly'], '冷却表带上被耗尽的窗口 id')
      assert.equal(cooled.ordering.effective[0].provider, 'opencode-go', '冷却中的条目仍列在投影里(带 cooling 标记),只是不会被尝试')
      assert.equal(cooled.ordering.effective[0].cooling, true)
      assert.equal(cooled.ordering.effective[0].windows === undefined, false, '冷却条目带 windows')
      assert.deepEqual(cooled.ordering.effective[0].windows, ['monthly'])
      assert.deepEqual(
        cooled.ordering.effective.filter((item) => item.cooling !== true).map((item) => item.provider),
        ['commandcode', 'deepseek-official'],
        '真正会被尝试的是去掉冷却项之后的那两条',
      )
      assert.ok(logs.warn.some((warning) => /额度耗尽,冷却到/u.test(warning)), '冷却要有日志')

      // 切 manual:顺序回到配置、cooldown **恒空**(§7),effective 不再渲染排序结果
      ordering.set({ mode: 'manual' })
      const manual = invoke(endpoint, ROUTES_PATH).json
      assert.equal(manual.ordering.mode, 'manual')
      assert.deepEqual(chainLabels(manual), [
        'commandcode/deepseek/deepseek-v4.1-flash',
        'opencode-go/deepseek-v4.1-flash',
        'deepseek-official/deepseek-flash',
      ], 'chain 仍是配置顺序')
      assert.deepEqual(manual.ordering.effective.map((item) => item.label), chainLabels(manual), 'manual 严格按配置顺序')
      assert.deepEqual(manual.ordering.cooldown, [], 'manual 下 cooldown 恒空')
      assert.equal(manual.ordering.ignoredCooldown, false)

      // 切回 auto:冷却表还在(模式只是过滤开关),排序复原
      ordering.set({ mode: 'auto' })
      const back = invoke(endpoint, ROUTES_PATH).json
      assert.equal(back.ordering.cooldown.length, 1, '冷却表没有被 manual 清掉')
      assert.equal(back.ordering.effective[0].provider, 'opencode-go', '投影里仍列着它(带 cooling 标记)')
      assert.deepEqual(
        back.ordering.effective.filter((item) => item.cooling !== true).map((item) => item.provider),
        ['commandcode', 'deepseek-official'],
        '真正会被尝试的还是去掉冷却项之后的那两条',
      )
    } finally {
      restore()
    }
  })

  it('ordering 配置坏值:只 warn 不拖垮宿主,回落 auto', () => {
    const { ctx, routes, logs } = makeFakeCtx()
    apply(ctx, { routes: ORDER_ROUTES, ordering: { mode: 'bogus' } })
    assert.ok(logs.warn.some((warning) => /ordering\.mode/u.test(warning)), '坏值要有一条 warn')
    assert.equal(routes.length, 3, '照常挂三个端点')
    const body = invoke(findRoute(routes, ROUTES_PATH).handler, ROUTES_PATH).json
    assert.equal(body.ordering.mode, 'auto', '坏值回落 auto')
  })

  it('ordering 是 volatile ⇒ 引用被原地改写后免重启生效(面板那个开关靠它)', () => {
    const { ctx, routes } = makeFakeCtx()
    const ordering = mutableVolatile({ mode: 'auto' })
    apply(ctx, { routes: ORDER_ROUTES, ordering: ordering.ref })
    const endpoint = findRoute(routes, ROUTES_PATH).handler
    assert.equal(invoke(endpoint, ROUTES_PATH).json.ordering.mode, 'auto')
    ordering.set({ mode: 'manual' })
    assert.equal(invoke(endpoint, ROUTES_PATH).json.ordering.mode, 'manual', '改完下一次请求就是新值')
  })

  it('断网(额度接口不可达)⇒ 不产生冷却、全落未知档、端点仍 200', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'env' }) }
      const { ctx, routes } = makeFakeCtx({ credentials })
      apply(ctx, { routes: ORDER_ROUTES })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()
      const response = invoke(endpoint, ROUTES_PATH)
      assert.equal(response.status, 200)
      assert.deepEqual(response.json.ordering.effective.map((item) => item.reason), ['unknown', 'unknown', 'unknown'], '查不到就按配置顺序')
      assert.deepEqual(response.json.ordering.effective.map((item) => item.label), chainLabels(response.json))
      assert.deepEqual(response.json.ordering.cooldown, [], '补查失败 ⇒ 不冷却(fail-open)')
      assert.deepEqual(response.json.quota.sources.map((source) => source.reason), ['network', 'network'])
    } finally {
      globalThis.fetch = original
    }
  })

  /**
   * 造一个"成功但没有任何重置时刻可等"的 fetch 桩(用来验 6 小时上界那一档)。
   * @returns 造响应体的函数。
   */
  function bodyWithoutResets() {
    return (url) => (String(url).includes('/alpha/billing/credits')
      ? { credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 } }
      : { usage: { monthly: { status: 'ok', percent: 0, resetsAt: null } } })
  }

  it('CC 的月度余额见底:端点冷却行也带上 credits 那一档(0.8.0 补丁轮的第三条臂)', async () => {
    const original = globalThis.fetch
    const now = Date.now()
    const periodEnd = new Date(now + 10 * 24 * 3600 * 1000).toISOString()
    // CC:月度余额见底 ⇒ belowThreshold 真、monthly/purchased/free 全 0;5h 窗与周窗都**没** exceeded
    const brokeCredits = {
      credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0, belowThreshold: true, creditThreshold: 5 },
      windowLimits: {
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: now + 3 * 3600 * 1000 },
        weekly: { used: 0, cap: 35, exceeded: false, resetAt: now + 5 * 24 * 3600 * 1000 },
      },
    }
    const subscriptions = { success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false, endedAt: null } }
    const goUsage = { usage: { monthly: { status: 'ok', percent: 0, resetsAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString() } } }
    globalThis.fetch = async (url) => {
      const target = String(url)
      return {
        ok: true,
        status: 200,
        json: async () => (target.includes('/alpha/billing/credits') ? brokeCredits : target.includes('/alpha/billing/subscriptions') ? subscriptions : goUsage),
      }
    }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      const quotaFailure = async function* stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'Insufficient credits', status: 400 } } }
      }
      const { ctx, routes, registered, logs } = makeFakeCtx({ credentials, llmStream: quotaFailure })
      apply(ctx, { routes: [ORDER_ROUTES[0], ORDER_ROUTES[1]] })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      invoke(endpoint, ROUTES_PATH)
      await settle()
      const before = invoke(endpoint, ROUTES_PATH).json
      assert.deepEqual(before.ordering.cooldown, [], '还没发生 QUOTA 失败')
      assert.equal(before.ordering.effective[0].provider, 'commandcode', 'CC 的周期末(10 天)早于 Go 的月度重置(30 天)⇒ CC 排最前')

      // 第一条(CC)以 QUOTA 告吹一次 ⇒ 补查确认"月度余额见底" ⇒ 冷却到套餐周期末
      await drainVia(registered[0].adapter)
      await settle()
      const cooled = invoke(endpoint, ROUTES_PATH).json
      assert.equal(cooled.ordering.cooldown.length, 1, '余额见底这一档也要冷却(改前 cooldown 恒空 ⇒ 每条消息都白撞 CC)')
      assert.equal(cooled.ordering.cooldown[0].provider, 'commandcode')
      assert.deepEqual(cooled.ordering.cooldown[0].windows, ['credits'], '是哪一档:CC 的月度余额')
      assert.equal(new Date(cooled.ordering.cooldown[0].until).toISOString(), periodEnd, '终点 = 套餐 currentPeriodEnd')
      assert.equal(cooled.ordering.effective[0].provider, 'commandcode', '投影里仍列着它(带 cooling)')
      assert.equal(cooled.ordering.effective[0].cooling, true)
      assert.deepEqual(cooled.ordering.effective[0].windows, ['credits'])
      assert.deepEqual(
        cooled.ordering.effective.filter((item) => item.cooling !== true).map((item) => item.provider),
        ['opencode-go'],
        '真正会被尝试的只剩 Go',
      )
      assert.ok(logs.warn.some((warning) => /额度耗尽,冷却到/u.test(warning)), '冷却要有日志')
    } finally {
      globalThis.fetch = original
    }
  })

  it('路由侧补查的触发点③:headless(一次 /routes 都不读)也按闸门补查 —— 过期才一轮、没过期零请求', async () => {
    const original = globalThis.fetch
    mock.timers.enable({ apis: ['Date'] })
    const calls = []
    const now = Date.now()
    const ccPeriodEnd = new Date(now + 360 * 24 * 3600 * 1000).toISOString()
    const credits = {
      credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: { fiveHour: { used: 1, cap: 14, exceeded: false, resetAt: now + 3600 * 1000 } },
    }
    const subscriptions = { success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: ccPeriodEnd, cancelAtPeriodEnd: false, endedAt: null } }
    const goUsage = {
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: new Date(now + 4 * 3600 * 1000).toISOString() },
        monthly: { status: 'ok', percent: 0, resetsAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString() },
      },
    }
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      const target = String(url)
      return {
        ok: true,
        status: 200,
        json: async () => (target.includes('/alpha/billing/credits') ? credits : target.includes('/alpha/billing/subscriptions') ? subscriptions : goUsage),
      }
    }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      const { ctx, routes, registered } = makeFakeCtx({ credentials })
      apply(ctx, { routes: ORDER_ROUTES })
      const endpoint = findRoute(routes, ROUTES_PATH).handler
      const adapter = registered[0].adapter
      // ⚠ 全程**不读** /routes:补查必须由"每次请求的排序路径"自己触发(headless 形态)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 3, '第一次请求:链上两家订阅各查一轮(CC 两个接口 + Go 一个)')
      void endpoint

      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 3, '缓存没过期 ⇒ 零补查(链上那家查不到的 provider 不该把闸门顶穿)')

      // CC 的闸门是它最近的窗口重置(5h 档 = 1 小时后);Go 是 4 小时;官方那家不属于额度来源
      mock.timers.tick(2 * 3600 * 1000)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 5, '到点才补:只有 CC 过期(它两个接口各一次),Go 还没到点')
      mock.timers.tick(3 * 3600 * 1000)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 6, '再往后 Go 也到点(4 小时)⇒ 补它一次')
    } finally {
      mock.timers.reset()
      globalThis.fetch = original
    }
  })

  it('路由侧补查的闸门长度:查询失败只占 10 分钟(绝不是 6 小时),查到 ok 才占长闸门', async () => {
    const original = globalThis.fetch
    mock.timers.enable({ apis: ['Date'] })
    const calls = []
    let failing = true
    const okBody = bodyWithoutResets()
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (failing) throw new Error('network down')
      return { ok: true, status: 200, json: async () => okBody(url) }
    }
    try {
      const credentials = { resolve: async () => ({ value: STUB_KEY, source: 'file' }) }
      const { ctx, registered } = makeFakeCtx({ credentials })
      // 只留能查的两家:闸门长度是这两家的事
      apply(ctx, { routes: [ORDER_ROUTES[0], ORDER_ROUTES[1]] })
      const adapter = registered[0].adapter
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 3, '第一次请求:两家各查一轮(都失败)')
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 3, '失败后 10 分钟内不重试')

      mock.timers.tick(DEFAULT_ORDERING_RETRY_MS + 1000)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 6, '失败只占 10 分钟短闸门(设计档 §4)—— 改前这里恒为 3(失败被当成"查到了"、占满 6 小时)')

      // 对照:查到 ok ⇒ 换成有效期的长闸门(这里两家都没有重置时刻可等 ⇒ 6 小时上界)
      failing = false
      mock.timers.tick(DEFAULT_ORDERING_RETRY_MS + 1000)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 9, '换成成功:两家都查到了')
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 9, '长闸门内不重查')
      mock.timers.tick(DEFAULT_ORDERING_TTL_MS + 1000)
      await drainVia(adapter)
      await settle()
      assert.equal(calls.length, 12, '过上界(6 小时)才重查')
    } finally {
      mock.timers.reset()
      globalThis.fetch = original
    }
  })
})
