/**
 * `lib/ordering.js` 的覆盖(0.8.0 新增的纯模块,**零真实网络**)。
 *
 * 这里钉住的规则与设计档 §3 逐条对应:
 *  1. **三桶排序** —— 已知月度重置时刻的订阅按升序、未知档按配置顺序、按量兜底永远最后,
 *     桶内保持配置顺序(稳定),且**不改 `routes` 配置本身**;
 *  2. **冷却** —— provider 粒度、终点取被耗尽窗口里最晚的重置时刻、到点自动解除(无定时器)、
 *     全冷却时兜底忽略冷却、失败判定是 fail-open;
 *  3. **模式** —— `manual` 完全回到 0.7.0 行为(不排序、不跳过、不冷却);
 *  4. **边界** —— 额度形状坏/缺字段/坏时钟都不抛。
 *
 * 时钟、额度快照、冷却表全部**注入**,所以本文件不连网、不读环境变量、不碰凭据。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CREDITS_WINDOW_ID,
  DEFAULT_ORDERING_CONFIG,
  DEFAULT_ORDERING_RETRY_MS,
  DEFAULT_ORDERING_TTL_MS,
  ORDERING_MODE,
  ORDER_BUCKETS,
  WINDOW_IDS,
  buildOrder,
  cooldownUntilOf,
  createCooldown,
  createOrderRefresh,
  earliestResetOf,
  effectiveEntry,
  exhaustedUntil,
  exhaustedWindowIds,
  exhaustedWindows,
  isCreditsExhausted,
  isExhausted,
  isExhaustedWindow,
  isSourceOk,
  monthlyResetOf,
  normalizeMode,
  normalizeOrdering,
  providerKind,
  quotaSourceOf,
  reasonOf,
  timestampOf,
} from '../lib/ordering.js'

const T = (iso) => Date.parse(iso)

/** Command Code 的形状(2026-10-05 实测口径的子集):美元余额 + 两档窗口 + 套餐周期末。 */
const CC = {
  provider: 'commandcode',
  status: 'ok',
  credits: { total: 49.57, monthly: 49.57, purchased: 0, free: 0, belowThreshold: false },
  windows: { fiveHour: { used: 1, cap: 14, exceeded: false, resetAt: T('2026-10-07T10:00:00Z') } },
  plan: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-11-04T14:00:31.000Z' },
}
/** OpenCode Go 的形状:三档百分比窗口,月度档 `rate-limited`(= 已耗尽)。 */
const GO = {
  provider: 'opencode-go',
  status: 'ok',
  windows: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-07T12:41:30.831Z' },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-24T00:00:44.000Z' },
  },
}
/** 按量兜底那一家的形状:认识它、但没有任何窗口概念(永不过期)。 */
const OFFICIAL = { provider: 'deepseek-official', status: 'ok', windows: {} }
const QUOTA = { state: 'fresh', checkedAt: '2026-10-07T08:00:00.000Z', sources: [CC, GO, OFFICIAL] }

const ROUTES = [
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  { provider: 'deepseek-official', model: 'deepseek-flash', keepThinking: true, breakToolLoop: true },
]
const NOW = T('2026-10-07T08:00:00Z')

describe('ordering:normalizeOrdering(坏值只 warn 并回落 auto)', () => {
  it('缺省 ⇒ 全默认(auto)', () => {
    for (const raw of [undefined, null]) {
      const { config, warnings } = normalizeOrdering(raw)
      assert.deepEqual(config, { ...DEFAULT_ORDERING_CONFIG })
      assert.equal(config.mode, ORDERING_MODE.AUTO)
      assert.deepEqual(warnings, [])
    }
  })

  it('mode: auto / manual 都认', () => {
    assert.equal(normalizeOrdering({ mode: 'auto' }).config.mode, 'auto')
    assert.equal(normalizeOrdering({ mode: 'manual' }).config.mode, 'manual')
    assert.deepEqual(normalizeOrdering({ mode: 'manual' }).warnings, [])
  })

  it('坏值只 warn 并回落 auto(绝不让整行插件加载失败)', () => {
    for (const raw of ['nope', 42, true, [], { mode: 'AUTO' }, { mode: 1 }, { mode: null }]) {
      const { config, warnings } = normalizeOrdering(raw)
      assert.equal(config.mode, 'auto', `${JSON.stringify(raw)} ⇒ 回落 auto`)
      if (raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw) && (raw.mode === null)) {
        assert.deepEqual(warnings, [], 'mode 为 null 视为"没给",不算坏值')
      } else {
        assert.equal(warnings.length, 1, `${JSON.stringify(raw)} 应给一条 warn`)
      }
    }
    assert.match(normalizeOrdering({ mode: 'AUTO' }).warnings[0], /ordering\.mode/u)
  })

  it('normalizeMode:不认识的都当 auto', () => {
    assert.equal(normalizeMode('manual'), 'manual')
    for (const value of ['auto', undefined, null, 'MANUAL', 7]) assert.equal(normalizeMode(value), 'auto')
    assert.deepEqual(ORDER_BUCKETS, ['monthly-reset-asc', 'unknown', 'never-expires'])
  })
})

describe('ordering:纯函数(时间戳 / 快照取用 / 桶归属)', () => {
  it('timestampOf:数字原样、ISO 串解析、坏值给 null(两种口径都要吃)', () => {
    assert.equal(timestampOf(1791202779495), 1791202779495)
    assert.equal(timestampOf('2026-10-24T00:00:44.000Z'), T('2026-10-24T00:00:44.000Z'))
    for (const value of ['', 'nope', null, undefined, {}, Number.NaN, Infinity]) assert.equal(timestampOf(value), null)
  })

  it('quotaSourceOf:只认自己的属性,坏快照不抛', () => {
    assert.equal(quotaSourceOf(QUOTA, 'commandcode'), CC)
    assert.equal(quotaSourceOf(QUOTA, 'nope'), undefined)
    assert.equal(quotaSourceOf(undefined, 'commandcode'), undefined)
    assert.equal(quotaSourceOf({ sources: 'nope' }, 'commandcode'), undefined)
    assert.equal(quotaSourceOf({ sources: [null, 7, 'x'] }, 'commandcode'), undefined)
    // provider 名撞 Object.prototype:直接取属性会拿到函数 ⇒ 必须只认 own property
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      assert.equal(quotaSourceOf(QUOTA, name), undefined, `${name} 不该被当成来源`)
    }
  })

  it('monthlyResetOf:CC 取套餐 currentPeriodEnd、Go 取月度档 resetsAt、别的给 null', () => {
    assert.equal(monthlyResetOf('commandcode', QUOTA), T('2026-11-04T14:00:31.000Z'))
    assert.equal(monthlyResetOf('opencode-go', QUOTA), T('2026-10-24T00:00:44.000Z'))
    assert.equal(monthlyResetOf('deepseek-official', QUOTA), null, '没有月度重置时刻 ⇒ 不编一个')
    assert.equal(monthlyResetOf('nope', QUOTA), null)
    // ⚠ 刻意不看 5h/周窗口(那是速率闸门,按它排会每几小时抖一次):CC 只有 5h 窗时月度仍是 null
    const onlyWindow = { sources: [{ provider: 'commandcode', status: 'ok', windows: { fiveHour: { resetAt: 123 } }, plan: {} }] }
    assert.equal(monthlyResetOf('commandcode', onlyWindow), null)
  })

  it('providerKind:订阅 / 按量兜底 / 未知 三态', () => {
    assert.equal(providerKind('commandcode', QUOTA), 'subscription')
    assert.equal(providerKind('opencode-go', QUOTA), 'subscription')
    assert.equal(providerKind('deepseek-official', QUOTA), 'never-expires')
    assert.equal(providerKind('nope', QUOTA), 'unknown', '快照里没有这一家 ⇒ 不猜(猜成按量会排错,猜成订阅会编一个重置时刻)')
    assert.equal(providerKind('commandcode', undefined), 'unknown')
    // 不可查的来源也算"查不到",不能当成"按量"
    const unavailable = { sources: [{ provider: 'opencode-go', status: 'unavailable', reason: 'network' }] }
    assert.equal(providerKind('opencode-go', unavailable), 'unknown')
    assert.equal(reasonOf('opencode-go', unavailable), 'unknown')
    assert.equal(reasonOf('deepseek-official', QUOTA), 'never-expires')
    assert.equal(reasonOf('commandcode', QUOTA), 'monthly-reset-asc')
  })

  it('isExhausted / exhaustedWindows:两家判据各自成立,坏形状不抛', () => {
    assert.equal(isExhausted(quotaSourceOf(QUOTA, 'opencode-go')), true)
    assert.equal(isExhausted(quotaSourceOf(QUOTA, 'commandcode')), false)
    assert.equal(exhaustedWindows(quotaSourceOf(QUOTA, 'opencode-go')).length, 1)
    assert.equal(isExhaustedWindow({ status: 'rate-limited' }), true)
    assert.equal(isExhaustedWindow({ exceeded: true }), true, 'CC 的布尔 exceeded 也算耗尽')
    assert.equal(isExhaustedWindow({ status: 'ok', percent: 100 }), false, '百分比 100 不算:上游语义不明时宁可漏判')
    for (const value of [null, undefined, 5, 'x']) assert.equal(isExhaustedWindow(value), false)
    for (const value of [undefined, null, 5, 'x', { status: 'unavailable' }]) assert.equal(isExhausted(value), false)
  })

  it('CC 的月度余额见底也算一档耗尽(§3.2 决策 4 的第三条臂):冷却到套餐周期末', () => {
    // 5h 窗 / 周窗都**没** exceeded,只有月度余额见底 —— 这条臂以前是缺的(于是 CC 永远不冷却)
    const broke = {
      provider: 'commandcode',
      status: 'ok',
      credits: { monthly: 0, purchased: 0, free: 0, total: 0, belowThreshold: true, threshold: 5 },
      windows: {
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: T('2026-10-07T10:00:00Z') },
        weekly: { used: 0, cap: 35, exceeded: false, resetAt: T('2026-10-12T00:00:00Z') },
      },
      plan: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-11-04T14:00:31.000Z' },
    }
    const quota = { state: 'fresh', sources: [broke] }
    assert.equal(isExhausted(broke), true, '余额见底 ⇒ 算耗尽')
    const windows = exhaustedWindows(broke)
    assert.equal(windows.length, 1, '两档窗口都没 exceeded ⇒ 只剩合成的那一档')
    assert.equal(windows[0].id, CREDITS_WINDOW_ID)
    assert.deepEqual(exhaustedWindowIds(broke), [CREDITS_WINDOW_ID], '端点是固定枚举 id,不是上游字符串')
    assert.equal(cooldownUntilOf('commandcode', quota, NOW), T('2026-11-04T14:00:31.000Z'), '该档没有重置字段 ⇒ 退到套餐 currentPeriodEnd')
    assert.equal(providerKind('commandcode', quota), 'subscription', '见底的订阅不该被当成按量兜底')
    const cooldown = createCooldown()
    cooldown.mark('commandcode', cooldownUntilOf('commandcode', quota, NOW), exhaustedWindowIds(broke))
    const order = buildOrder(ROUTES, { quota, cooldown, now: NOW })
    assert.deepEqual(order.skipped.map((entry) => entry.provider), ['commandcode'], '该家整家被跳过')
    assert.deepEqual(order.skipped[0].windows, [CREDITS_WINDOW_ID], '面板据此说"余额已耗尽"')
  })

  it('余额见底的判据只认"有键的数":字段缺失 / 只有 partial 都不算(undefined 绝不当 0)', () => {
    const shape = (credits) => ({
      provider: 'commandcode',
      status: 'ok',
      credits,
      windows: { fiveHour: { used: 1, cap: 14, exceeded: false } },
      plan: { planId: 'individual-goat', currentPeriodEnd: '2026-11-04T14:00:31.000Z' },
    })
    assert.equal(isCreditsExhausted(shape({})), false, '字段都缺 ⇒ 不知道,不算见底')
    assert.equal(isCreditsExhausted(shape({ monthly: 0 })), false, '只给一个键 ⇒ 不敢判(充值额度可结转)')
    assert.equal(isCreditsExhausted(shape({ monthly: 0, total: 0 })), true, '两个键都在且都 <= 0 ⇒ 见底')
    assert.equal(isCreditsExhausted(shape({ monthly: 0, total: 0.5 })), false, '总额还有钱 ⇒ 不见底')
    assert.equal(isCreditsExhausted(shape({ monthly: 12.5, total: 12.5, belowThreshold: false })), false)
    assert.equal(isCreditsExhausted(shape({ monthly: 0, total: null, belowThreshold: true })), true, 'belowThreshold 是上游自己的结论,单独就够')
    assert.equal(isCreditsExhausted({ provider: 'commandcode', status: 'unavailable', credits: { monthly: 0, total: 0, belowThreshold: true } }), false, '查不到就不猜(fail-open)')
    assert.equal(isCreditsExhausted(null), false)
    assert.equal(isCreditsExhausted('nope'), false)
    assert.equal(cooldownUntilOf('commandcode', { sources: [shape({})] }, NOW), null, '缺字段 ⇒ 不冷却')
  })

  it('余额见底但拿不到任何重置时刻 ⇒ 不冷却(fail-open,别硬编一个终点)', () => {
    const broke = {
      provider: 'commandcode',
      status: 'ok',
      credits: { monthly: 0, purchased: 0, free: 0, total: 0, belowThreshold: true },
      windows: { fiveHour: { used: 1, cap: 14, exceeded: false } },
      plan: null,
    }
    assert.equal(isExhausted(broke), true, '耗尽判定照样成立(它确实用不了了)')
    assert.equal(cooldownUntilOf('commandcode', { sources: [broke] }, NOW), null, '但终点未知 ⇒ 不冷却')
  })

  it('cooldownUntilOf:没耗尽不冷却;耗尽取最晚的重置时刻;终点未知则不冷却(fail-open)', () => {
    assert.equal(cooldownUntilOf('commandcode', QUOTA, NOW), null, 'CC 两档都没耗尽 ⇒ 不冷却')
    assert.equal(cooldownUntilOf('opencode-go', QUOTA, NOW), T('2026-10-24T00:00:44.000Z'))
    assert.equal(cooldownUntilOf('nope', QUOTA, NOW), null)
    assert.equal(cooldownUntilOf('opencode-go', undefined, NOW), null)
    // 多档同时打满 ⇒ 取**最晚**那档(要等最晚那档解开)
    const bothLimited = {
      sources: [{
        provider: 'opencode-go',
        status: 'ok',
        windows: {
          rolling: { status: 'rate-limited', resetsAt: '2026-10-07T12:00:00.000Z' },
          weekly: { status: 'rate-limited', resetsAt: '2026-10-12T00:00:00.000Z' },
          monthly: { status: 'rate-limited', resetsAt: '2026-10-24T00:00:44.000Z' },
        },
      }],
    }
    assert.equal(cooldownUntilOf('opencode-go', bothLimited, NOW), T('2026-10-24T00:00:44.000Z'))
    // CC 用布尔 exceeded
    const ccLimited = { sources: [{ ...CC, windows: { fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: T('2026-10-07T10:00:00Z') } } }] }
    assert.equal(cooldownUntilOf('commandcode', ccLimited, NOW), T('2026-10-07T10:00:00Z'))
    // 耗尽但窗口不给重置时刻 ⇒ 退到月度周期末;连月度都没有 ⇒ 不冷却
    const noResetAt = {
      sources: [{
        provider: 'commandcode',
        status: 'ok',
        windows: { fiveHour: { exceeded: true } },
        plan: { currentPeriodEnd: '2026-11-04T14:00:31.000Z' },
      }],
    }
    assert.equal(cooldownUntilOf('commandcode', noResetAt, NOW), T('2026-11-04T14:00:31.000Z'), '退到套餐周期末')
    const noPlan = { sources: [{ provider: 'commandcode', status: 'ok', windows: { fiveHour: { exceeded: true } }, plan: {} }] }
    assert.equal(cooldownUntilOf('commandcode', noPlan, NOW), null, '连月度都没有 ⇒ 不冷却')
    const nothing = { sources: [{ provider: 'opencode-go', status: 'ok', windows: { monthly: { status: 'rate-limited' } } }] }
    assert.equal(cooldownUntilOf('opencode-go', nothing, NOW), null, '终点未知 ⇒ 不冷却(不用"现在+兜底"编一个)')
    // exhaustedUntil 只回答"冷却到几点",不负责判定是否耗尽(合成判据是 cooldownUntilOf)
    assert.equal(exhaustedUntil('commandcode', QUOTA, NOW), T('2026-11-04T14:00:31.000Z'))
  })

  it('earliestResetOf:该家已知重置点里最早的那个(月度周期末 + 各档窗口)', () => {
    assert.equal(earliestResetOf('commandcode', QUOTA), T('2026-10-07T10:00:00Z'))
    assert.equal(earliestResetOf('opencode-go', QUOTA), T('2026-10-07T12:41:30.831Z'))
    assert.equal(earliestResetOf('deepseek-official', QUOTA), null)
    assert.equal(earliestResetOf('nope', QUOTA), null)
    assert.equal(earliestResetOf('opencode-go', undefined), null)
  })
})

describe('ordering:三桶排序(§3.1)', () => {
  it('订阅按月度重置升序,未知档夹在中间,按量兜底永远最后', () => {
    const routes = [
      { provider: 'deepseek-official', model: 'a' },
      { provider: 'mystery', model: 'b' },
      { provider: 'commandcode', model: 'c' },
      { provider: 'another-unknown', model: 'd' },
      { provider: 'opencode-go', model: 'e' },
    ]
    const order = buildOrder(routes, { quota: QUOTA, now: NOW })
    assert.deepEqual(order.order, ['opencode-go', 'commandcode', 'mystery', 'another-unknown', 'deepseek-official'])
    assert.deepEqual(order.entries.map((entry) => entry.reason), [
      'monthly-reset-asc', 'monthly-reset-asc', 'unknown', 'unknown', 'never-expires',
    ])
    assert.equal(order.entries[0].label, 'opencode-go/e')
    assert.equal(order.entries[0].until, undefined, '不在冷却中就不带 until')
    assert.equal(order.entries[0].cooling, undefined)
    assert.equal(order.ignoredCooldown, false)
  })

  it('桶内保持配置顺序(稳定排序):同桶多条不按 provider 名重排', () => {
    const routes = [
      { provider: 'opencode-go', model: 'first' },
      { provider: 'opencode-go', model: 'second' },
      { provider: 'zzz-unknown', model: 'u1' },
      { provider: 'aaa-unknown', model: 'u2' },
    ]
    const order = buildOrder(routes, { quota: QUOTA, now: NOW })
    assert.deepEqual(order.entries.map((entry) => entry.label), [
      'opencode-go/first', 'opencode-go/second', 'zzz-unknown/u1', 'aaa-unknown/u2',
    ])
  })

  it('同 provider 的多条**各自独立**排序(不按来源聚组)', () => {
    const routes = [
      { provider: 'commandcode', model: 'x' },
      { provider: 'opencode-go', model: 'y' },
      { provider: 'commandcode', model: 'z' },
    ]
    const order = buildOrder(routes, { quota: QUOTA, now: NOW })
    assert.deepEqual(order.entries.map((entry) => entry.label), [
      'opencode-go/y', 'commandcode/x', 'commandcode/z',
    ], 'CC 两条按配置顺序相邻,排在 Go 之后(CC 的月度重置更晚)')
  })

  it('额度查不到 ⇒ 全部落未知档、退化成配置顺序(不猜、不抛)', () => {
    const order = buildOrder(ROUTES, { quota: undefined, now: NOW })
    assert.deepEqual(order.order, ['commandcode', 'opencode-go', 'deepseek-official'])
    assert.deepEqual(order.entries.map((entry) => entry.reason), ['unknown', 'unknown', 'unknown'])
    const halfUnknown = buildOrder(ROUTES, { quota: { sources: [GO] }, now: NOW })
    assert.deepEqual(halfUnknown.order, ['opencode-go', 'commandcode', 'deepseek-official'], 'CC 与官方都落未知档,按配置顺序')
    assert.deepEqual(halfUnknown.entries.map((entry) => entry.reason), ['monthly-reset-asc', 'unknown', 'unknown'])
  })

  it('entries 是**可用的路由**(带 model / 逐条开关),不只是展示用的标签', () => {
    const order = buildOrder(ROUTES, { quota: QUOTA, now: NOW })
    const official = order.entries.find((entry) => entry.provider === 'deepseek-official')
    assert.equal(official.model, 'deepseek-flash', '少了 model,适配器会拿 undefined 去发请求')
    assert.equal(official.keepThinking, true)
    assert.equal(official.breakToolLoop, true)
    assert.equal(official.label, 'deepseek-official/deepseek-flash')
  })

  it('不改入参:排序只发生在现场副本上(「不修改 routes 配置本身」)', () => {
    const routes = [
      { provider: 'deepseek-official', model: 'a' },
      { provider: 'commandcode', model: 'b' },
    ]
    const snapshot = JSON.stringify(routes)
    const order = buildOrder(routes, { quota: QUOTA, now: NOW })
    assert.equal(JSON.stringify(routes), snapshot)
    assert.equal(order.entries[0].model, 'b', '返回的是新对象,顺序与配置不同')
    assert.notEqual(order.entries[0], routes[1], '条目是新对象,不是原数组里的引用')
  })

  it('坏输入不抛:非数组链 / 非对象快照 / 坏冷却 / 坏时钟', () => {
    assert.doesNotThrow(() => buildOrder(null, {}))
    assert.doesNotThrow(() => buildOrder('nope', {}))
    assert.deepEqual(buildOrder(undefined, {}).entries, [])
    assert.deepEqual(buildOrder([], {}).order, [])
    const messy = buildOrder(ROUTES, {
      quota: { sources: [null, 7, 'x', { provider: 'commandcode', status: 'ok', windows: { fiveHour: 'nope' }, plan: 5 }] },
      cooldown: { until: () => Infinity },
      now: Number.NaN,
    })
    assert.equal(messy.entries.length, 3)
    assert.ok(messy.entries.every((entry) => entry.until === undefined), '坏冷却终点不该写成坏 ISO')
  })

  it('坏时钟(NaN / Infinity / 缺省):任一入口条都必须出现在 entries 或 skipped 里(绝不少试一跳)', () => {
    const expected = ROUTES.map((route) => `${route.provider}/${route.model}`).sort()
    // 用 Set 去重:全冷却兜底时同一条会同时出现在 entries(被放行)与 skipped(照实报告)里
    const placed = (order) => [...new Set([...order.entries, ...order.skipped].map((entry) => entry.label))].sort()
    const cooldown = createCooldown()
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'))
    for (const now of [Number.NaN, Infinity, -Infinity, undefined]) {
      const order = buildOrder(ROUTES, { quota: QUOTA, cooldown, now })
      assert.deepEqual(placed(order), expected, `now=${String(now)} 时每一条都得有归宿`)
    }
    // 冷却终点本身是坏值时也一样:该条要么被放行、要么进 skipped,不能凭空消失
    const bogus = buildOrder(ROUTES, { quota: QUOTA, cooldown: { until: () => Infinity }, now: Number.NaN })
    assert.deepEqual(placed(bogus), expected)
    // 时钟规范化:坏 now 被换成真时钟 ⇒ 冷却照旧生效(而不是 cooldown.until(…, NaN) 恒 false 把它丢掉)
    const far = createCooldown()
    far.mark('opencode-go', T('2099-01-01T00:00:00.000Z'))
    const normalized = buildOrder(ROUTES, { quota: QUOTA, cooldown: far, now: Number.NaN })
    assert.deepEqual(normalized.skipped.map((entry) => entry.provider), ['opencode-go'])
    assert.deepEqual(placed(normalized), expected)
  })

  it('effectiveEntry:冷却中的条目带 cooling + ISO 的 until,坏终点当作没有终点', () => {
    const route = { provider: 'commandcode', model: 'm' }
    const plain = effectiveEntry(route, 'monthly-reset-asc', null)
    assert.deepEqual(Object.keys(plain).sort(), ['label', 'model', 'provider', 'reason'])
    const cooled = effectiveEntry(route, 'monthly-reset-asc', T('2026-10-24T00:00:44.000Z'))
    assert.equal(cooled.cooling, true)
    assert.equal(cooled.until, '2026-10-24T00:00:44.000Z')
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const entry = effectiveEntry(route, 'unknown', bad)
      assert.equal(entry.cooling, undefined, `${bad} 不该变成坏 ISO`)
      assert.equal(entry.until, undefined)
    }
  })
})

describe('ordering:冷却(§3.2)', () => {
  it('冷却中的 provider 整家被滤掉,条目落进 skipped 并带上解除时刻', () => {
    const cooldown = createCooldown()
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'))
    const order = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW })
    assert.deepEqual(order.order, ['commandcode', 'deepseek-official'], 'Go 的两条都已不在实际顺序里(这里只有一条)')
    assert.deepEqual(order.skipped.map((entry) => entry.provider), ['opencode-go'])
    assert.equal(order.skipped[0].until, '2026-10-24T00:00:44.000Z')
    assert.equal(order.skipped[0].cooling, true)
    assert.equal(order.ignoredCooldown, false)
    // buckets 是**不过滤冷却**的完整归属:解释"为什么这么排"时要用它
    assert.deepEqual(order.buckets['monthly-reset-asc'].map((item) => item.provider), ['opencode-go', 'commandcode'])
  })

  it('冷却粒度是 provider:同一家所有条目一起冷', () => {
    const routes = [
      { provider: 'opencode-go', model: 'a' },
      { provider: 'opencode-go', model: 'b' },
      { provider: 'commandcode', model: 'c' },
    ]
    const cooldown = createCooldown()
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'))
    const order = buildOrder(routes, { quota: QUOTA, cooldown, now: NOW })
    assert.deepEqual(order.order, ['commandcode'])
    assert.equal(order.skipped.length, 2)
  })

  it('到点自动解除,不需要定时器;时钟回退不冻死也不误解除', () => {
    const cooldown = createCooldown()
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'))
    assert.equal(cooldown.has('opencode-go', T('2026-10-23T00:00:00Z')), true)
    assert.equal(cooldown.has('opencode-go', T('2026-10-24T00:00:43Z')), true)
    assert.equal(cooldown.has('opencode-go', T('2026-10-24T00:00:44Z')), false, '到点即解除(now >= until)')
    assert.equal(cooldown.has('opencode-go', T('2026-10-25T00:00:00Z')), false)
    // 时钟回退(NTP 校正/虚拟机恢复):判据是绝对时刻的比较 ⇒ 仍在冷却,不会被冻住
    assert.equal(cooldown.has('opencode-go', T('2026-09-01T00:00:00Z')), true)
    const back = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: T('2026-10-01T00:00:00Z') })
    assert.deepEqual(back.order, ['commandcode', 'deepseek-official'])
    const after = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: T('2026-10-25T00:00:00Z') })
    assert.deepEqual(after.order, ['opencode-go', 'commandcode', 'deepseek-official'], '到点后自动回到最前')
  })

  it('冷却表记下"是哪一档打满"(固定枚举;认不出的 id 一律丢掉)', () => {
    assert.deepEqual([...WINDOW_IDS], ['rolling', 'fiveHour', 'weekly', 'monthly', 'credits'], '固定枚举就是这几个')
    const cooldown = createCooldown()
    assert.deepEqual(cooldown.windowsOf('nobody', NOW), [], '没冷却过 ⇒ 空数组')
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'), ['monthly'])
    assert.deepEqual(cooldown.windowsOf('opencode-go', NOW), ['monthly'])
    assert.deepEqual(cooldown.snapshot(NOW), [{ provider: 'opencode-go', until: T('2026-10-24T00:00:44.000Z'), windows: ['monthly'] }])
    const order = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW })
    assert.deepEqual(order.skipped[0].windows, ['monthly'], '端点条目带上它(面板据此说"月度已耗尽")')
    assert.equal(order.skipped[0].cooling, true)
    assert.equal(order.entries[0].windows, undefined, '不冷却的条目不带这个键')
    // 白名单之外(上游原始键名 / 坏值)一律丢掉;同一档重复只算一次
    const messy = createCooldown()
    messy.mark('commandcode', T('2026-11-04T14:00:31.000Z'), ['RateLimit', 'monthly', 'monthly', 7, null, 'monthly-ish', 'credits'])
    assert.deepEqual(messy.windowsOf('commandcode', NOW), ['monthly', 'credits'])
    // 更晚的终点覆盖时连窗口一起换;更早的终点不覆盖(窗口也就不动)
    const moving = createCooldown()
    moving.mark('opencode-go', T('2026-10-24T00:00:44.000Z'), ['monthly'])
    moving.mark('opencode-go', T('2026-10-30T00:00:00.000Z'), ['rolling'])
    assert.deepEqual(moving.windowsOf('opencode-go', NOW), ['rolling'], '终点换新 ⇒ 窗口也换新')
    assert.equal(moving.mark('opencode-go', T('2026-10-10T00:00:00.000Z'), ['weekly']), true)
    assert.deepEqual(moving.windowsOf('opencode-go', NOW), ['rolling'], '更早的终点被忽略 ⇒ 窗口保持原样')
    assert.deepEqual(moving.windowsOf('opencode-go', T('2026-12-01T00:00:00.000Z')), [], '到点 ⇒ 空数组')
    assert.deepEqual(moving.windowsOf('opencode-go', Number.NaN), [], '坏时钟 ⇒ 当作不在冷却')
    // 端点形状:没人给过窗口时是空数组(老调用方口径不变)
    const bare = createCooldown()
    bare.mark('x', 100)
    assert.deepEqual(bare.snapshot(60), [{ provider: 'x', until: 100, windows: [] }])
  })

  it('冷却表:坏终点忽略、更晚的终点覆盖更早的、snapshot 只给还生效的', () => {
    const cooldown = createCooldown()
    assert.equal(cooldown.mark('x', null), false)
    assert.equal(cooldown.mark('x', 'nope'), false)
    assert.equal(cooldown.mark('', 100), false)
    assert.equal(cooldown.mark('x', 100), true)
    assert.equal(cooldown.mark('x', 50), true, '更早的终点不覆盖(不缩短冷却)')
    assert.equal(cooldown.until('x', 60), 100)
    assert.equal(cooldown.until('x', 100), null)
    assert.equal(cooldown.mark('y', 500), true)
    assert.deepEqual(cooldown.snapshot(60), [{ provider: 'x', until: 100, windows: [] }, { provider: 'y', until: 500, windows: [] }].sort((l, r) => (l.provider < r.provider ? -1 : 1)))
    assert.deepEqual(cooldown.snapshot(600), [], '都到点了 ⇒ 空表')
    assert.deepEqual(cooldown.snapshot(Number.NaN), [], '坏时钟 ⇒ 不假装有冷却')
    assert.equal(cooldown.clear('x'), true)
    assert.equal(cooldown.clear('x'), false)
  })

  it('全冷却 ⇒ 忽略冷却兜底(绝不产生假故障「链已用尽」)', () => {
    const cooldown = createCooldown()
    for (const route of ROUTES) cooldown.mark(route.provider, T('2026-11-04T14:00:31.000Z'))
    const order = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW })
    assert.equal(order.ignoredCooldown, true)
    assert.deepEqual(order.order, ['opencode-go', 'commandcode', 'deepseek-official'], '兜底时仍按排序结果')
    assert.equal(order.skipped.length, 3, 'skipped 照实报告(面板要能解释发生了什么)')
    assert.ok(order.entries.every((entry) => entry.cooling === undefined), '兜底放行的条目不标冷却')
  })

  it('fail-open:额度查不到时 cooling 判据为假 ⇒ 不冷却(宁可下次白撞)', () => {
    const cooldown = createCooldown()
    // 上游断网 ⇒ 快照里那一条也不见了/变成 unavailable
    const offline = { state: 'stale', sources: [{ provider: 'opencode-go', status: 'unavailable', reason: 'network', message: '网络请求失败' }] }
    assert.equal(cooldownUntilOf('opencode-go', offline, NOW), null)
    assert.equal(buildOrder(ROUTES, { quota: offline, cooldown, now: NOW }).order[0], 'commandcode', 'Go 落未知档,排在 CC 之后')
  })
})

describe('ordering:模式(§3.3)', () => {
  it('manual:严格按配置顺序,不排序、不跳过、不冷却', () => {
    const cooldown = createCooldown()
    cooldown.mark('commandcode', T('2026-11-04T14:00:31.000Z'))
    const order = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW, mode: 'manual' })
    assert.equal(order.mode, 'manual')
    assert.deepEqual(order.order, ['commandcode', 'opencode-go', 'deepseek-official'], '顺序与配置逐字一致')
    assert.deepEqual(order.skipped, [], 'manual 不跳过任何一跳')
    assert.ok(order.entries.every((entry) => entry.cooling === undefined))
  })

  it('manual 下 reason 仍照实给出(面板可以只显示"手动"而不渲染它)', () => {
    const order = buildOrder(ROUTES, { quota: QUOTA, now: NOW, mode: 'manual' })
    assert.deepEqual(order.entries.map((entry) => entry.reason), ['monthly-reset-asc', 'monthly-reset-asc', 'never-expires'])
  })

  it('模式不认识的当 auto(与 normalizeOrdering 同口径)', () => {
    const order = buildOrder(ROUTES, { quota: QUOTA, now: NOW, mode: 'AUTO' })
    assert.equal(order.mode, 'auto')
    assert.deepEqual(order.order, ['opencode-go', 'commandcode', 'deepseek-official'])
  })

  it('切回 auto 时冷却表立刻重新生效(模式只是过滤开关,表不被清掉)', () => {
    const cooldown = createCooldown()
    cooldown.mark('opencode-go', T('2026-10-24T00:00:44.000Z'))
    const manual = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW, mode: 'manual' })
    assert.equal(manual.skipped.length, 0)
    const auto = buildOrder(ROUTES, { quota: QUOTA, cooldown, now: NOW, mode: 'auto' })
    assert.deepEqual(auto.skipped.map((entry) => entry.provider), ['opencode-go'])
  })
})

describe('ordering:路由侧额度缓存(§4)', () => {
  /** 可推进的假钟。 */
  function makeClock(start = NOW) {
    const clock = { at: start }
    return { clock, now: () => clock.at, advance: (ms) => { clock.at += ms } }
  }

  it('默认常量:上界 6 小时、失败重试 10 分钟', () => {
    assert.equal(DEFAULT_ORDERING_TTL_MS, 6 * 60 * 60 * 1000)
    assert.equal(DEFAULT_ORDERING_RETRY_MS, 10 * 60 * 1000)
  })

  it('有效期跟着"已知重置时刻里最早的那个"走:到点即重查,没到点不重查', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, ['commandcode', 'opencode-go'], '从没查过 ⇒ 都该查')
    refresh.markChecked(['commandcode', 'opencode-go'], QUOTA, true)
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, [], '刚查过 ⇒ 不重复查')
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).fresh, ['commandcode', 'opencode-go'])
    // CC 的最早重置点是 5h 窗(10:00Z),Go 是 rolling(12:41Z)
    advance(T('2026-10-07T10:00:01Z') - NOW)
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, ['commandcode'], 'CC 到点了、Go 还没')
    refresh.markChecked(['commandcode'], QUOTA, true)
    advance(T('2026-10-07T12:41:31Z') - T('2026-10-07T10:00:01Z'))
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, ['opencode-go'])
  })

  it('没有任何重置时刻可等时挂上界(默认 6 小时),不会永不过期', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    refresh.markChecked(['deepseek-official'], QUOTA, true)
    advance(DEFAULT_ORDERING_TTL_MS - 1000)
    assert.deepEqual(refresh.plan(['deepseek-official']).due, [], '差一秒还不查')
    advance(2000)
    assert.deepEqual(refresh.plan(['deepseek-official']).due, ['deepseek-official'], '过上界 ⇒ 重查')
  })

  it('markFromQuota:只有本轮真的 status === "ok" 才算查到,查不到只占 10 分钟短闸门', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    const failed = { state: 'stale', sources: [{ provider: 'commandcode', status: 'unavailable', reason: 'network', message: '网络请求失败' }] }
    assert.equal(isSourceOk(QUOTA, 'commandcode'), true)
    assert.equal(isSourceOk(QUOTA, 'deepseek-official'), true, '这一家在快照里且 ok(按量兜底那家)')
    assert.equal(isSourceOk(QUOTA, 'nope'), false, '快照里没这一家 ⇒ 不算查到')
    assert.equal(isSourceOk(failed, 'commandcode'), false)
    // ① 全失败:短闸门(10 分钟),绝不是 6 小时
    refresh.markFromQuota(['commandcode', 'opencode-go'], failed)
    advance(DEFAULT_ORDERING_RETRY_MS - 1000)
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, [], '短闸门内不重试')
    advance(2000)
    assert.deepEqual(refresh.plan(['commandcode', 'opencode-go']).due, ['commandcode', 'opencode-go'], '过 10 分钟就重试')
    // ② 同一轮里逐家判:一家 ok ⇒ 换成长闸门(跟着它的重置时刻),另一家没查到 ⇒ 仍是短闸门
    const half = { state: 'fresh', sources: [GO] }
    refresh.markFromQuota(['commandcode', 'opencode-go'], half)
    const afterHalf = NOW + DEFAULT_ORDERING_RETRY_MS + 1000
    assert.deepEqual(refresh.plan(['opencode-go']).due, [], '查到的按重置时刻占长闸门(rolling 那档还没到)')
    assert.deepEqual(refresh.plan(['commandcode']).due, [], '刚记过 ⇒ 短闸门内也不重试')
    advance(T('2026-10-07T08:21:00Z') - afterHalf)
    assert.deepEqual(refresh.plan(['commandcode']).due, ['commandcode'], '没查到的那家 10 分钟后重试')
    assert.deepEqual(refresh.plan(['opencode-go']).due, [], '查到的那家还在长闸门里(12:41 才到点)')
    assert.deepEqual(refresh.markFromQuota(['deepseek-official'], QUOTA), [{ provider: 'deepseek-official', validUntil: T('2026-10-07T14:21:00Z') }], '查到了但没有重置时刻可等 ⇒ 6 小时上界')
    assert.deepEqual(refresh.markFromQuota(['nobody'], QUOTA), [{ provider: 'nobody', validUntil: T('2026-10-07T08:31:00Z') }], '快照里没有的 provider 只占短闸门')
  })

  it('失败只占短 TTL(默认 10 分钟)后重试', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    refresh.markChecked(['commandcode'], QUOTA, false)
    advance(DEFAULT_ORDERING_RETRY_MS - 1000)
    assert.deepEqual(refresh.plan(['commandcode']).due, [], '失败后 10 分钟内不重试')
    advance(2000)
    assert.deepEqual(refresh.plan(['commandcode']).due, ['commandcode'], '过 10 分钟重试')
  })

  it('上界与重试间隔可覆盖;provider 名去重、坏值忽略', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    refresh.markChecked(['commandcode', 'commandcode', '', null, 7], QUOTA, true, { ttlMs: 1000, retryMs: 500 })
    advance(1001)
    assert.deepEqual(refresh.plan(['commandcode']).due, ['commandcode'])
    assert.deepEqual(refresh.plan(['commandcode', 'commandcode']).due, ['commandcode'], '重复名只算一次')
    assert.deepEqual(refresh.plan([]).due, [])
    assert.deepEqual(refresh.plan(undefined).due, [])
  })

  it('时钟回退:有效期是绝对时刻 ⇒ 回退后仍算"已查过"(不会被冻住也不会乱查)', () => {
    const { now, advance } = makeClock()
    const refresh = createOrderRefresh({ now })
    refresh.markChecked(['commandcode'], QUOTA, true)
    advance(-60 * 60 * 1000)
    assert.deepEqual(refresh.plan(['commandcode']).due, [], '回到一小时前:有效期还没到 ⇒ 不重查')
  })

  it('markChecked 返回每家的有效期(便于端点/日志复核)', () => {
    const { now } = makeClock()
    const refresh = createOrderRefresh({ now })
    const out = refresh.markChecked(['commandcode'], QUOTA, true)
    assert.equal(out.length, 1)
    assert.equal(out[0].provider, 'commandcode')
    assert.equal(out[0].validUntil, T('2026-10-07T10:00:00Z'), '取该家最早的重置点')
  })
})
