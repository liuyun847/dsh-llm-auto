/**
 * 挂载行为:`apply()` 读配置、注册路由、挂 HTTP 端点,以及"配置坏掉时不拖垮宿主"。
 * 用假 ctx(只实现 lib/index.js 真正用到的四个面)驱动,不需要起 harness。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config, apply, ROUTES_PATH } from '../lib/index.js'
import { makeFakeCtx } from './helpers.mjs'

const ROUTES = [
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'ww', model: 'gpt-6-astra' },
]

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

describe('apply:注册与配置解析', () => {
  it('正常配置:注册 auto 路由 + 挂 /api/llm-auto/routes,并打两条 info(注册 + 窗口口径)', () => {
    const { ctx, logs, routes, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0].providers, ['auto'])
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, ROUTES_PATH)
    assert.equal(routes[0].kind, 'exact')
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
    const body = invoke(routes[0].handler, ROUTES_PATH)
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
    const body = invoke(routes[0].handler, ROUTES_PATH)
    assert.equal(body.json.retry.maxRetries, 0)
  })

  it('retry 配置坏 ⇒ 只 warn 不拖垮宿主,回落官方默认(插件约定:配置错误不该让宿主起不来)', () => {
    for (const retry of [{ maxRetries: -1 }, { backoff: { initialDelayMs: 99999, maxDelayMs: 1 } }, { mode: 'always' }, 'nope', { attempts: 5 }]) {
      const { ctx, logs, registered, routes } = makeFakeCtx()
      assert.doesNotThrow(() => apply(ctx, { routes: ROUTES, retry }))
      assert.equal(registered.length, 1, `${JSON.stringify(retry)} 不该阻止注册`)
      assert.equal(routes.length, 1)
      assert.equal(logs.error.length, 0, '坏 retry 不该升级成 error')
      assert.ok(logs.warn.length >= 1)
      const body = invoke(routes[0].handler, ROUTES_PATH)
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

    const body = invoke(routes[0].handler, ROUTES_PATH)
    assert.equal(body.json.name, '我的聚合模型')
    assert.equal(body.json.capacity, 2)
    assert.deepEqual(body.json.chain, ['commandcode/deepseek/deepseek-v4.1-flash', 'ww/gpt-6-astra'])
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
    // 这条走的是宿主真实路径:schema 补默认值 500000 + 把它包装成 volatile 引用。
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
      assert.equal(routes.length, 1)
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
    assert.equal((await adapter.listModels('auto'))[0].name, 'Auto')
    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 375000)
    assert.equal(invoke(routes[0].handler, ROUTES_PATH).json.capacity, 50)

    // 模拟设置页写入:值原地变,引用对象不变(宿主对 volatile-only 改动就是这一条路)
    name.set('我的聚合模型')
    compact.set(500000)
    limit.set(3)

    assert.equal((await adapter.listModels('auto'))[0].name, '我的聚合模型')
    assert.equal((await adapter.resolveModel('auto', 'auto')).context.contextWindow, 625000)
    const body = invoke(routes[0].handler, ROUTES_PATH)
    assert.equal(body.json.capacity, 3)
    assert.equal(body.json.name, '我的聚合模型')
    assert.equal(body.json.compactWindow, 500000)
    assert.equal(body.json.declaredContextWindow, 625000)
  })
})

describe('GET /api/llm-auto/routes', () => {
  it('空缓冲时返回链与容量', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const body = invoke(routes[0].handler, `${ROUTES_PATH}?limit=10`)
    assert.equal(body.status, 200)
    assert.match(body.headers['content-type'], /application\/json/u)
    assert.equal(body.json.provider, 'auto')
    assert.equal(body.json.model, 'auto')
    assert.equal(body.json.total, 0)
    assert.deepEqual(body.json.routes, [])
  })

  it('非法 limit 不报错(退化为不限)', () => {
    const { ctx, routes } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    const body = invoke(routes[0].handler, `${ROUTES_PATH}?limit=abc`)
    assert.equal(body.status, 200)
    assert.deepEqual(body.json.routes, [])
  })

  it('复核字段:compactWindow 与 declaredContextWindow', async () => {
    // 配了压缩点:两个字段都是确定值
    const mapped = makeFakeCtx()
    apply(mapped.ctx, { routes: ROUTES, compactWindow: 400000 })
    const mappedBody = invoke(mapped.routes[0].handler, ROUTES_PATH).json
    assert.equal(mappedBody.compactWindow, 400000)
    assert.equal(mappedBody.declaredContextWindow, 500000)

    // 没配压缩点(直接调用 apply 的场合):compactWindow 为 null;声明窗口要等第一次目录解析
    const { ctx, routes, registered } = makeFakeCtx()
    ctx.llm.resolveModelInfo = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 884000 } })
    apply(ctx, { routes: ROUTES })
    const before = invoke(routes[0].handler, ROUTES_PATH).json
    assert.equal(before.compactWindow, null)
    assert.equal(before.declaredContextWindow, null, '还没解析过目录 ⇒ null(而不是编一个数)')
    await registered[0].adapter.resolveModel('auto', 'auto')
    const after = invoke(routes[0].handler, ROUTES_PATH).json
    assert.equal(after.declaredContextWindow, 884000)
  })
})
