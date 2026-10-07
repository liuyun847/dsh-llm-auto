/**
 * `lib/quota.js` 的覆盖:纯函数 + 查询器(零真实网络 —— fetch / 凭据 / 时钟全部注入)。
 *
 * 这里钉住的三条硬规矩(与模块注释逐条对应):
 *  1. **查不到就说查不到**:`unavailable` 的来源不带任何数字字段(0 在两家都是合法真值,
 *     拿它顶替会把 Go 的 `rate-limited`(已耗尽)显示成 "0%");
 *  2. **永不抛**:凭据缺失、超时、403、坏 JSON……一律变成 unavailable 记录,`touch()` 永不 reject;
 *  3. **不外传凭据值**:响应里只有引用名与来源层,注入的桩 key 绝不出现在序列化结果里。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_QUOTA_CONFIG,
  QUOTA_REASON,
  classifyHttpError,
  createQuotaTracker,
  normalizeQuota,
  sumCredits,
  unavailableSource,
} from '../lib/quota.js'

/** 2026-10-05 实测形状(已脱敏;只留本模块用到的字段)。 */
const CREDITS = {
  credits: { monthlyCredits: 59.9240242796, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.622990592, cap: 14, exceeded: false, resetAt: 1791202779495 },
    weekly: { used: 10.0759757204, cap: 35, exceeded: false, resetAt: 1791727383630 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
}
const SUBSCRIPTIONS = {
  success: true,
  data: {
    planId: 'individual-goat',
    status: 'active',
    currentPeriodStart: '2026-10-04T14:00:31.000Z',
    currentPeriodEnd: '2026-11-04T14:00:31.000Z',
    cancelAtPeriodEnd: false,
    quantity: 1,
    endedAt: null,
  },
}
const GO_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-05T12:41:30.831Z' },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-24T00:00:44.000Z' },
  },
}
/** 只用于"响应里不许出现它"的桩值(不是真 key)。 */
const STUB_KEY = 'sk-TEST-ONLY-0123456789abcdef'

const ALL = ['commandcode', 'opencode-go']

/** 一个可 advance 的假钟(不推进 ⇒ TTL 命中;推进 ⇒ 过期)。 */
function makeClock(start = 1791200000000) {
  let at = start
  return { now: () => at, advance: (ms) => { at += ms } }
}

/** fetch 桩:按 URL 片段分发,记下每次请求的 URL 与头。 */
function makeFetchStub(byFragment) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init === undefined ? {} : init.headers })
    for (const [fragment, handler] of Object.entries(byFragment)) {
      if (String(url).includes(fragment)) return handler(init)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  return { fetchImpl, calls }
}

/** 一次正常的 JSON 响应。 */
const jsonOk = (body, status = 200) => ({ ok: true, status, json: async () => body })
/** 一个非 2xx 响应(带响应体,用于 1010 判定)。 */
const jsonErr = (status, body) => ({ ok: false, status, json: async () => body })

/** 凭据服务桩。 */
const credentialsReturning = (value, source = 'file') => ({ resolve: async () => (value === undefined ? undefined : { value, source }) })

/** 造一个查询器:默认只认两家、时钟可注入、fetch 用桩。 */
function makeTracker(options = {}) {
  const config = normalizeQuota(options.config).config
  const { fetchImpl, calls } = makeFetchStub(options.routes ?? {
    '/alpha/billing/credits': () => jsonOk(CREDITS),
    '/alpha/billing/subscriptions': () => jsonOk(SUBSCRIPTIONS),
    '/zen/go/v1/usage': () => jsonOk(GO_USAGE),
  })
  const clock = options.clock ?? makeClock()
  const logs = []
  const tracker = createQuotaTracker({
    config,
    credentials: options.credentials ?? credentialsReturning(options.key ?? STUB_KEY, options.source),
    fetchImpl: options.fetchImpl ?? fetchImpl,
    now: clock.now,
    logger: { warn: (message) => logs.push(message) },
  })
  return { tracker, calls, clock, logs, config }
}

/** 刷一次并读快照(最常用的一步)。 */
async function refreshed(tracker, providers = ALL) {
  await tracker.touch(providers)
  return tracker.snapshot(providers)
}

describe('quota:normalizeQuota(坏值只 warn 并回落默认)', () => {
  it('缺省 ⇒ 全默认;两家都启用且引用名是 CMD_API_KEY / OPENCODE_API_KEY', () => {
    const { config, warnings } = normalizeQuota(undefined)
    assert.deepEqual(warnings, [])
    assert.equal(config.enabled, true)
    assert.equal(config.ttlMs, DEFAULT_QUOTA_CONFIG.ttlMs)
    assert.equal(config.timeoutMs, DEFAULT_QUOTA_CONFIG.timeoutMs)
    assert.equal(config.sources.commandcode.apiKeyEnv, 'CMD_API_KEY')
    assert.equal(config.sources['opencode-go'].apiKeyEnv, 'OPENCODE_API_KEY')
  })

  it('坏值:类型错/非正整数/非法引用名一律 warn + 回落,不抛', () => {
    const { config, warnings } = normalizeQuota({
      enabled: 'yes',
      ttlMs: 0,
      timeoutMs: -1,
      userAgent: '',
      commandcode: 'nope',
      opencodeGo: { apiKeyEnv: 'not a name' },
    })
    assert.equal(config.enabled, true)
    assert.equal(config.ttlMs, DEFAULT_QUOTA_CONFIG.ttlMs)
    assert.equal(config.timeoutMs, DEFAULT_QUOTA_CONFIG.timeoutMs)
    assert.equal(config.userAgent, DEFAULT_QUOTA_CONFIG.userAgent)
    assert.equal(config.sources['opencode-go'].apiKeyEnv, 'OPENCODE_API_KEY')
    assert.equal(warnings.length, 6)
    for (const warning of warnings) assert.match(warning, /^auto: quota\./u)
  })

  it('`opencode-go:` 与 `opencodeGo:` 两种写法都认;可以单独关掉一家', () => {
    const dashed = normalizeQuota({ 'opencode-go': { apiKeyEnv: 'GO_KEY', enabled: false } }).config
    assert.equal(dashed.sources['opencode-go'].apiKeyEnv, 'GO_KEY')
    assert.equal(dashed.sources['opencode-go'].enabled, false)
    const camel = normalizeQuota({ opencodeGo: { apiKeyEnv: 'GO_KEY' } }).config
    assert.equal(camel.sources['opencode-go'].apiKeyEnv, 'GO_KEY')
  })
})

describe('quota:纯函数(余额 / HTTP 分类 / 不可查记录)', () => {
  it('sumCredits 是三档之和;任一档取不到就给 null(绝不用 0 顶替未知)', () => {
    assert.equal(sumCredits({ monthly: 59.9240242796, purchased: 0, free: 0 }), 59.9240242796)
    assert.equal(sumCredits({ monthly: 1, purchased: 2, free: 3 }), 6)
    assert.equal(sumCredits({ monthly: Number.NaN, purchased: undefined, free: 5 }), null)
    assert.equal(sumCredits({}), null)
  })

  it('classifyHttpError:403+1010 是 blocked(不是 auth),401/403 是 auth,其余是 http', () => {
    assert.equal(classifyHttpError(403, { error_code: 1010 }).quotaReason, QUOTA_REASON.BLOCKED)
    assert.equal(classifyHttpError(403, { error_name: 'browser_signature_banned' }).quotaReason, QUOTA_REASON.BLOCKED)
    assert.equal(classifyHttpError(403, { error: 'nope' }).quotaReason, QUOTA_REASON.AUTH)
    assert.equal(classifyHttpError(401, undefined).quotaReason, QUOTA_REASON.AUTH)
    assert.equal(classifyHttpError(500, undefined).quotaReason, QUOTA_REASON.HTTP)
  })

  it('unavailableSource 只有元数据:没有 credits / windows / plan 键', () => {
    const source = unavailableSource('commandcode', 'CMD_API_KEY', QUOTA_REASON.NO_CREDENTIAL, '没配')
    assert.deepEqual(Object.keys(source).sort(), ['credentialSource', 'fetchedAt', 'message', 'provider', 'reason', 'ref', 'status'])
    assert.equal(source.status, 'unavailable')
    assert.equal(source.fetchedAt, null)
  })
})

describe('quota:快照与刷新(未查 ⇒ pending;查不到 ⇒ unavailable)', () => {
  it('没刷过时 state=pending 且不列来源;关掉时 state=disabled', async () => {
    const { tracker } = makeTracker()
    const before = tracker.snapshot(ALL)
    assert.equal(before.state, 'pending')
    assert.deepEqual(before.sources, [])
    assert.equal(before.checkedAt, null)

    const off = makeTracker({ config: { enabled: false } })
    assert.equal(off.tracker.snapshot(ALL).state, 'disabled')
    assert.deepEqual(off.tracker.snapshot(ALL).sources, [])
    await off.tracker.touch(ALL)
    assert.deepEqual(off.calls, [], '关掉时一个请求都不发')
  })

  it('凭据解析不到 ⇒ no-credential,且一个数字都不给(不碰 fetch)', async () => {
    const { tracker, calls } = makeTracker({ credentials: credentialsReturning(undefined) })
    const report = await refreshed(tracker)
    assert.equal(report.state, 'fresh')
    assert.deepEqual(report.sources.map((source) => source.provider), ['commandcode', 'opencode-go'])
    for (const source of report.sources) {
      assert.equal(source.status, 'unavailable')
      assert.equal(source.reason, QUOTA_REASON.NO_CREDENTIAL)
      assert.equal('credits' in source, false)
      assert.equal('windows' in source, false)
      assert.equal('plan' in source, false)
    }
    assert.deepEqual(calls, [], '凭据都没配,不该发请求')
  })

  it('source 顺序跟随传入的 providers(链顺序),关掉的一家不出现', async () => {
    const config = { opencodeGo: { enabled: false } }
    const { tracker } = makeTracker({ config })
    const report = await refreshed(tracker, ['opencode-go', 'commandcode'])
    assert.deepEqual(report.sources.map((source) => source.provider), ['commandcode'])
  })
})

describe('quota:Command Code(余额 + 两档窗口)', () => {
  it('成功:余额是三档之和、窗口原样、套餐来自次要接口;请求带浏览器 UA', async () => {
    const { tracker, calls } = makeTracker()
    const report = await refreshed(tracker)
    const cc = report.sources[0]
    assert.equal(cc.status, 'ok')
    assert.equal(cc.credits.total, 59.9240242796)
    assert.equal(cc.credits.monthly, 59.9240242796)
    assert.equal(cc.credits.belowThreshold, false)
    assert.deepEqual(cc.windows.fiveHour, { used: 0.622990592, cap: 14, exceeded: false, resetAt: 1791202779495 })
    assert.equal(cc.windows.weekly.cap, 35)
    assert.equal(cc.plan.planId, 'individual-goat')
    assert.equal(cc.ref, 'CMD_API_KEY')
    assert.equal(cc.credentialSource, 'file')
    assert.match(cc.fetchedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(calls.length, 3, 'CC 两个 GET + Go 一个 GET')
    for (const call of calls) assert.match(String(call.headers['user-agent']), /^Mozilla\/5\.0 /u)
    assert.match(String(calls[0].headers.authorization), /^Bearer sk-TEST-ONLY/u)
    assert.ok(!JSON.stringify(report).includes(STUB_KEY), '快照里绝不能出现凭据值')
  })

  it('UA 被 Cloudflare 拦(403 + 1010)⇒ blocked,不是 auth;也不给数字', async () => {
    const { tracker } = makeTracker({
      routes: {
        '/alpha/billing/credits': () => jsonErr(403, { error_code: 1010, error_name: 'browser_signature_banned' }),
        '/alpha/billing/subscriptions': () => jsonErr(403, { error_code: 1010 }),
        '/zen/go/v1/usage': () => jsonOk(GO_USAGE),
      },
    })
    const report = await refreshed(tracker)
    const cc = report.sources[0]
    assert.equal(cc.status, 'unavailable')
    assert.equal(cc.reason, QUOTA_REASON.BLOCKED)
    assert.match(cc.message, /Cloudflare/u)
    assert.equal('credits' in cc, false)
    assert.equal(report.sources[1].status, 'ok', '一家失败不牵连另一家')
  })

  it('401 ⇒ auth;500 ⇒ http;坏 JSON ⇒ parse;次要接口失败只让 plan 为 null', async () => {
    const auth = await refreshed(makeTracker({ routes: { '/alpha/billing/credits': () => jsonErr(401, {}), '/zen/go/v1/usage': () => jsonOk(GO_USAGE) } }).tracker)
    assert.equal(auth.sources[0].reason, QUOTA_REASON.AUTH)

    const http = await refreshed(makeTracker({ routes: { '/alpha/billing/credits': () => jsonErr(503, {}), '/zen/go/v1/usage': () => jsonOk(GO_USAGE) } }).tracker)
    assert.equal(http.sources[0].reason, QUOTA_REASON.HTTP)

    const parse = await refreshed(makeTracker({ routes: { '/alpha/billing/credits': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }), '/zen/go/v1/usage': () => jsonOk(GO_USAGE) } }).tracker)
    assert.equal(parse.sources[0].reason, QUOTA_REASON.PARSE)

    const shape = await refreshed(makeTracker({ routes: { '/alpha/billing/credits': () => jsonOk({ nothing: true }), '/zen/go/v1/usage': () => jsonOk(GO_USAGE) } }).tracker)
    assert.equal(shape.sources[0].reason, QUOTA_REASON.PARSE)

    const planOnly = await refreshed(makeTracker({ routes: {
      '/alpha/billing/credits': () => jsonOk(CREDITS),
      '/alpha/billing/subscriptions': () => jsonErr(500, {}),
      '/zen/go/v1/usage': () => jsonOk(GO_USAGE),
    } }).tracker)
    assert.equal(planOnly.sources[0].status, 'ok', '次要接口失败不影响整源')
    assert.equal(planOnly.sources[0].plan, null)
    assert.equal(planOnly.sources[0].credits.total, 59.9240242796)
  })

  it('超时(AbortController)与网络错误各归各的 reason', async () => {
    const hanging = () => new Promise((_resolve, reject) => {
      // 永不 resolve;只在 signal 触发时 reject —— 与真实 fetch 的 abort 行为同形。
      setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5)
    })
    const timedOut = await refreshed(makeTracker({ config: { timeoutMs: 20 }, fetchImpl: hanging }).tracker)
    for (const source of timedOut.sources) assert.equal(source.reason, QUOTA_REASON.TIMEOUT, 'CC 与 Go 都超时')

    const down = await refreshed(makeTracker({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } }).tracker)
    for (const source of down.sources) assert.equal(source.reason, QUOTA_REASON.NETWORK)
  })
})

describe('quota:OpenCode Go(三档百分比,status 原样)', () => {
  it('成功:三档原样带出,monthly 的 rate-limited/100 表示**已耗尽**,且没有金额字段', async () => {
    const { tracker } = makeTracker()
    const report = await refreshed(tracker)
    const go = report.sources[1]
    assert.equal(go.status, 'ok')
    assert.deepEqual(go.windows.rolling, { status: 'ok', percent: 0, resetsAt: '2026-10-05T12:41:30.831Z' })
    assert.equal(go.windows.weekly.percent, 0)
    assert.deepEqual(go.windows.monthly, { status: 'rate-limited', percent: 100, resetsAt: '2026-10-24T00:00:44.000Z' })
    assert.equal(go.ref, 'OPENCODE_API_KEY')
    assert.equal('credits' in go, false, 'Go 没有金额口径')
    assert.equal('plan' in go, false)
  })

  it('401 ⇒ auth(与"月度已耗尽"是两件事,别混)', async () => {
    const { tracker } = makeTracker({ routes: { '/alpha/billing/credits': () => jsonOk(CREDITS), '/alpha/billing/subscriptions': () => jsonOk(SUBSCRIPTIONS), '/zen/go/v1/usage': () => jsonErr(401, { type: 'error' }) } })
    const report = await refreshed(tracker)
    assert.equal(report.sources[1].status, 'unavailable')
    assert.equal(report.sources[1].reason, QUOTA_REASON.AUTH)
  })

  it('坏形状(没有 usage 对象)⇒ parse', async () => {
    const { tracker } = makeTracker({ routes: { '/alpha/billing/credits': () => jsonOk(CREDITS), '/alpha/billing/subscriptions': () => jsonOk(SUBSCRIPTIONS), '/zen/go/v1/usage': () => jsonOk({ nope: true }) } })
    const report = await refreshed(tracker)
    assert.equal(report.sources[1].reason, QUOTA_REASON.PARSE)
  })
})

describe('quota:缓存 / 去重 / 降级', () => {
  it('TTL 内连查不重复打上游;过期后才再打一轮', async () => {
    const { tracker, calls, clock } = makeTracker({ config: { ttlMs: 60000 } })
    await refreshed(tracker)
    const afterFirst = calls.length
    await refreshed(tracker)
    await refreshed(tracker)
    assert.equal(calls.length, afterFirst, 'TTL 内命中缓存')
    assert.equal(tracker.snapshot(ALL).state, 'fresh')

    clock.advance(60001)
    assert.equal(tracker.snapshot(ALL).state, 'stale', '过期后先如实报 stale')
    await refreshed(tracker)
    assert.equal(calls.length, afterFirst * 2, '过期后才再打一轮')
  })

  it('并发去重:同时 5 次 touch 只打一轮', async () => {
    const { tracker, calls } = makeTracker()
    await Promise.all([tracker.touch(ALL), tracker.touch(ALL), tracker.touch(ALL), tracker.touch(ALL), tracker.touch(ALL)])
    assert.equal(calls.length, 3, 'CC 两个 + Go 一个')
  })

  it('失败也占 TTL(网络坏时不会每次请求都打上游)', async () => {
    let attempts = 0
    const { tracker } = makeTracker({ fetchImpl: async () => { attempts += 1; throw new Error('down') } })
    await refreshed(tracker)
    assert.equal(attempts, 3, 'CC 两个 + Go 一个(两次 CC 请求是并行的,失败也照样发出去)')
    await refreshed(tracker)
    assert.equal(attempts, 3, '紧接着再 touch 不再打:失败也占坑')
  })

  it('两家都拿不到 ⇒ 两条 unavailable,报告可读且不抛', async () => {
    const { tracker } = makeTracker({ credentials: credentialsReturning(undefined) })
    const report = await (async () => { await tracker.touch(ALL); return tracker.snapshot(ALL) })()
    assert.equal(report.state, 'fresh')
    assert.equal(report.sources.length, 2)
    for (const source of report.sources) assert.equal(source.status, 'unavailable')
    assert.equal(typeof report.ageMs, 'number')
    assert.equal(report.ttlMs, 60000)
    assert.equal(report.inFlight, false)
  })

  it('touch 永不 reject:fetch 与凭据服务同时炸也一样', async () => {
    const tracker = createQuotaTracker({
      config: normalizeQuota({}).config,
      credentials: { resolve: async () => { throw new Error('credentials exploded') } },
      fetchImpl: async () => { throw new Error('fetch exploded') },
      now: () => 1,
      logger: { warn: () => {} },
    })
    await tracker.touch(ALL)
    assert.equal(tracker.snapshot(ALL).state, 'fresh')
    for (const source of tracker.snapshot(ALL).sources) assert.equal(source.status, 'unavailable')
  })

  it('引用名非法 ⇒ bad-ref(悬挂的配置不会变成"网络错误")', async () => {
    // 绕开 normalizeQuota(它会先把坏名字修回默认),直接给查询器一份手写配置 ——
    // 这一支是"别的路径把非法引用塞进来"的防线。
    const config = normalizeQuota({}).config
    config.sources.commandcode = { enabled: true, apiKeyEnv: 'bad name' }
    const tracker = createQuotaTracker({
      config,
      credentials: credentialsReturning(STUB_KEY),
      fetchImpl: async (url) => (String(url).includes('/zen/go/v1/usage') ? jsonOk(GO_USAGE) : jsonOk(CREDITS)),
      now: () => 1791200000000,
      logger: { warn: () => {} },
    })
    await tracker.touch(ALL)
    const report = tracker.snapshot(ALL)
    assert.equal(report.sources[0].reason, QUOTA_REASON.BAD_REF)
    assert.equal(report.sources[1].status, 'ok', '另一家不受影响')
  })
})

describe('quota:forceRefresh(绕过 TTL、只刷指定来源;0.8.0 路由侧的冷却补查)', () => {
  it('绕过 TTL:刚 touch 过也一样重查,而且**只**查指定的那一家', async () => {
    const { tracker, calls, clock } = makeTracker({ config: { ttlMs: 60000 } })
    await refreshed(tracker)
    const afterFirst = calls.length
    await tracker.touch(ALL) // TTL 内:命中缓存,不打上游
    assert.equal(calls.length, afterFirst)

    await tracker.forceRefresh(['opencode-go'])
    assert.equal(calls.length, afterFirst + 1, '只多打了一次(Go 的那一个端点)')
    assert.match(calls[calls.length - 1].url, /zen\/go\/v1\/usage/u)

    // ⚠ 强制刷新**不占**面板的 TTL 坑:面板那份的 age 语义不受它影响
    clock.advance(1)
    assert.equal(tracker.snapshot(ALL).state, 'fresh')
  })

  it('只动指定的来源:别家的既有快照原样保留(并入而不是整体替换)', async () => {
    const { tracker } = makeTracker()
    await refreshed(tracker)
    const before = tracker.snapshot(ALL).sources.map((source) => `${source.provider}:${source.status}`)
    await tracker.forceRefresh(['opencode-go'])
    const after = tracker.snapshot(ALL)
    assert.deepEqual(after.sources.map((source) => `${source.provider}:${source.status}`), before)
    assert.equal(after.sources.length, 2, '别家不该从快照里消失')
  })

  it('单飞:同一家的并发强制刷新只打一轮上游', async () => {
    const { tracker, calls } = makeTracker()
    await Promise.all([
      tracker.forceRefresh(['opencode-go']),
      tracker.forceRefresh(['opencode-go']),
      tracker.forceRefresh(['opencode-go']),
    ])
    assert.equal(calls.length, 1, '三次并发 ⇒ 一次上游请求')
    // 跑完之后闸门要放开:再强制刷新还能打
    await tracker.forceRefresh(['opencode-go'])
    assert.equal(calls.length, 2)
  })

  it('失败不污染快照:只把这一家写成 unavailable,别家的数字仍在,且 Promise 不 reject', async () => {
    // 第一次全量查都能成功(拿到基准快照),之后只让 Go 那个端点炸。
    let goBroken = false
    const { fetchImpl, calls } = makeFetchStub({
      '/alpha/billing/credits': () => jsonOk(CREDITS),
      '/alpha/billing/subscriptions': () => jsonOk(SUBSCRIPTIONS),
      '/zen/go/v1/usage': () => {
        if (goBroken) throw new Error('down')
        return jsonOk(GO_USAGE)
      },
    })
    const tracker = createQuotaTracker({
      config: normalizeQuota({}).config,
      credentials: credentialsReturning(STUB_KEY),
      fetchImpl,
      now: () => 1791200000000,
      logger: { warn: () => {} },
    })
    await tracker.touch(ALL)
    assert.equal(tracker.snapshot(ALL).sources.find((source) => source.provider === 'commandcode').status, 'ok')
    const before = calls.length

    goBroken = true
    await tracker.forceRefresh(['opencode-go']) // 不该抛
    assert.equal(calls.length, before + 1, '只重打了 Go 那一个端点')
    const report = tracker.snapshot(ALL)
    const go = report.sources.find((source) => source.provider === 'opencode-go')
    const cc = report.sources.find((source) => source.provider === 'commandcode')
    assert.equal(go.status, 'unavailable')
    assert.equal(go.reason, QUOTA_REASON.NETWORK)
    assert.equal(go.credits, undefined, '不可查就一个数字都不给')
    assert.equal(cc.status, 'ok', '别家不受影响')
  })

  it('不认识的 provider / 空清单 / 关掉时都是安全的空操作', async () => {
    const { tracker, calls } = makeTracker({ config: { enabled: false } })
    await tracker.forceRefresh(ALL)
    assert.equal(calls.length, 0, 'enabled: false ⇒ 一次都不打')
    const enabled = makeTracker()
    await enabled.tracker.forceRefresh(['probe-no-such-provider', '', null, 7])
    assert.equal(enabled.calls.length, 0)
    await enabled.tracker.forceRefresh([])
    await enabled.tracker.forceRefresh(undefined)
    assert.equal(enabled.calls.length, 0)
  })
})

describe('quota:对抗性复核的修复(S1 / D1–D4)', () => {
  it('S1:body 挂住也要按超时落定,且下一次 touch 能重新发起请求', async () => {
    const hanging = { ok: true, status: 200, json: () => new Promise(() => {}) }
    let attempts = 0
    const clock = makeClock()
    const tracker = createQuotaTracker({
      config: normalizeQuota({ timeoutMs: 20, ttlMs: 1 }).config,
      credentials: credentialsReturning(STUB_KEY),
      fetchImpl: async () => { attempts += 1; return hanging },
      now: clock.now,
      logger: { warn: () => {} },
    })
    const guard = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('touch 挂住了:超时没有落定')), 500))
    await Promise.race([tracker.touch(ALL), guard])
    const first = tracker.snapshot(ALL)
    assert.deepEqual(first.sources.map((source) => source.reason), ['timeout', 'timeout'], 'body 挂住 ⇒ timeout,不是永远 pending')
    assert.equal(first.inFlight, false, 'refresh 必须已经落定(refreshing 已清空)')
    assert.equal(attempts, 3)
    clock.advance(5)
    await Promise.race([tracker.touch(ALL), guard])
    assert.equal(attempts, 6, '下一次 touch 必须能**重新发起请求**(不是复用那个永不落定的 promise)')
  })

  it('D1:上游改形状(某档不是数)⇒ 不带该字段,绝不填 0', async () => {
    const broken = {
      credits: { monthlyCredits: '59.9', purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: { fiveHour: { used: null, cap: 14 }, weekly: null },
    }
    const { tracker } = makeTracker({ routes: {
      '/alpha/billing/credits': () => jsonOk(broken),
      '/alpha/billing/subscriptions': () => jsonOk(SUBSCRIPTIONS),
      '/zen/go/v1/usage': () => jsonOk(GO_USAGE),
    } })
    const report = await refreshed(tracker)
    const cc = report.sources[0]
    assert.equal(cc.status, 'ok')
    assert.equal('total' in cc.credits, false, '算不出总额就不带这个键(不是 0)')
    assert.equal('monthly' in cc.credits, false, '不是数的字段不带键')
    assert.equal(cc.credits.purchased, 0, '真值 0 照旧保留(0 是合法真值)')
    assert.equal(cc.windows.fiveHour.cap, 14)
    assert.equal('used' in cc.windows.fiveHour, false, '未知的 used 不带键(不是 0)')
    assert.equal('weekly' in cc.windows, false, '整档坏形状就不给这一档')
  })

  it('D2:时钟回退不冻住刷新', async () => {
    const clock = makeClock(1791200000000)
    const { tracker, calls } = makeTracker({ clock, config: { ttlMs: 60000 } })
    await refreshed(tracker)
    const after = calls.length
    clock.advance(-120000)
    await refreshed(tracker)
    assert.equal(calls.length, after * 2, '回退后仍要能刷(旧写法会永远卡在 TTL 闸门)')
  })

  it('D3:坏时钟下 snapshot() 不抛,且不给假时间戳/假来源', async () => {
    const tracker = createQuotaTracker({
      config: normalizeQuota({}).config,
      credentials: credentialsReturning(STUB_KEY),
      fetchImpl: async (url) => (String(url).includes('/zen/go/v1/usage')
        ? jsonOk(GO_USAGE)
        : jsonOk(String(url).includes('/credits') ? CREDITS : SUBSCRIPTIONS)),
      now: () => Number.NaN,
      logger: { warn: () => {} },
    })
    assert.doesNotThrow(() => tracker.snapshot(ALL))
    await tracker.touch(ALL)
    const report = tracker.snapshot(ALL)
    assert.equal(report.checkedAt, null, '坏时钟不给假时间戳(旧写法会抛 RangeError)')
    assert.equal(report.ageMs, null)
    assert.equal(report.state, 'pending')
    assert.equal(report.sources[0].fetchedAt, null, 'payload 的 fetchedAt 同样走 isoOf 兜底')
    assert.equal(report.sources[0].status, 'ok', '数据本身照样可用')
    assert.equal(report.sources[0].credits.total, 59.9240242796)
  })

  it('D4:provider 名撞 Object.prototype(toString / constructor)不会被当成来源', async () => {
    const { tracker, calls } = makeTracker()
    const report = await refreshed(tracker, ['toString', 'constructor', 'valueOf', 'commandcode'])
    assert.deepEqual(report.sources.map((source) => source.provider), ['commandcode'])
    await tracker.touch(['toString'])
    assert.equal(calls.length, 2, '只给认识的那一家发请求(Command Code 两个 GET),三个假名一个都不发')
  })
})
