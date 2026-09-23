/**
 * 挂载行为:`apply()` 读配置、注册路由、挂 HTTP 端点,以及"配置坏掉时不拖垮宿主"。
 * 用假 ctx(只实现 lib/index.js 真正用到的四个面)驱动,不需要起 harness。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, ROUTES_PATH } from '../lib/index.js'
import { makeFakeCtx } from './helpers.mjs'

const ROUTES = [
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'ww', model: 'gpt-6-astra' },
]

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
  it('正常配置:注册 auto 路由 + 挂 /api/llm-auto/routes,并打一条 info', () => {
    const { ctx, logs, routes, registered } = makeFakeCtx()
    apply(ctx, { routes: ROUTES })
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0].providers, ['auto'])
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, ROUTES_PATH)
    assert.equal(routes[0].kind, 'exact')
    assert.equal(logs.info.length, 1)
    assert.match(logs.info[0], /已注册路由 auto\/auto/u)
    assert.match(logs.info[0], /commandcode\/deepseek\/deepseek-v4\.1-flash → ww\/gpt-6-astra/u)
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
})
