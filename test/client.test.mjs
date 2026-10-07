/**
 * 浏览器半侧(lib/client.js)的纯函数覆盖。
 *
 * 这个文件是 `window.__ModuleLoader__.load({ factory })` 形态的浏览器 bundle,不能像
 * ESM 那样 import 后就拿函数。做法:桩掉 `window.__ModuleLoader__` 把 load() 收到的
 * spec 收下来,再**手动调用 factory(require)**,从返回值里拿 `__internals`。
 * 因此本文件只覆盖不依赖 DOM 的部分 —— 渲染本身靠真机(见 README §7 的验证边界)。
 *
 * ⚠ 加载只能做一次:`await import()` 受 ESM 模块缓存约束,第二次 import **不会**再执行
 * 顶层语句 ⇒ `window.__ModuleLoader__.load()` 不再被调。所以这里用顶层 await 取一次,
 * 各 describe 共享同一份导出(不走 before —— 本文件的 before 在 Node 24 的 test runner
 * 下不会先于各 describe 的用例执行,`client` 会是 undefined)。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toRouteChain, toRouteDraft } from '../lib/routes.js'

/** 假的最小翻译函数:键不存在时原样返回键名(便于断言"漏键")。 */
const ZH = {
  retryLine: '每路由最多重试 {max} 次,退避 {initial}ms→{maxDelay}ms',
  retryOff: '路由内重试已关闭:每路由只尝试一次,失败即切下一条。',
  retried: '试了 {n} 次',
  switchedTo: '→ 切换至 {route}',
  loadFailed: '读取失败:{reason}',
  recordCount: '共 {total} 条记录,容量 {capacity}',
}
const t = (key) => (Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key)

/** require 桩:平台种子模块一律给空对象(纯函数路径不碰它们)。 */
function stubRequire(id) {
  if (id === 'react' || id === 'react/jsx-runtime' || id === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`unexpected require: ${id}`)
}

/** 读一次 client.js,返回它的导出(带 __internals)。 */
async function loadClient() {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured.factory = spec.factory
        captured.id = spec.id
      },
    },
  }
  await import('../lib/client.js')
  assert.equal(typeof captured.factory, 'function', 'factory 应被 load() 收下')
  const exports = captured.factory(stubRequire)
  assert.equal(captured.id, 'dsh-llm-auto', 'loader id 必须是包名')
  return exports
}

const client = await loadClient()
const internals = client.__internals

describe('client.js:模块契约', () => {
  it('导出 apply / inject / NS / ROUTES_PATH / __internals', () => {
    assert.equal(client.NS, 'llmAutoSettings')
    assert.equal(client.inject.length, 3)
    assert.deepEqual([...client.inject], ['slots', 'locale', 'configForms'])
    assert.equal(client.ROUTES_PATH, '/api/llm-auto/routes', '必须与宿主 lib/index.js 的 ROUTES_PATH 一致')
    for (const key of ['fill', 'tr', 'formatClock', 'formatDuration', 'retrySummary', 'outcomeState', 'outcomeTone', 'formatMoney', 'formatResetAt', 'formatQuota', 'chainSectionPlan', 'canResetChain', 'resetChainOps']) {
      assert.equal(typeof internals[key], 'function', `__internals.${key} 缺失`)
    }
  })
})

describe('client.js:fill / tr(对 t 的插值实现不敏感)', () => {
  it('fill 替换已知占位、保留未知占位', () => {
    assert.equal(internals.fill('a {x} b', { x: 1 }), 'a 1 b')
    assert.equal(internals.fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}', '没给的占位原样留着,不吞')
    assert.equal(internals.fill('{x}{x}', { x: 'p' }), 'pp', '同一占位出现多次都替换')
  })

  it('tr:当 t 不支持插值(返回仍带 {})时自救填充', () => {
    // 这里的 t 忽略第二个参数 ⇒ 模拟"实现不认 params"的版本
    assert.equal(internals.tr(t, 'retryLine', { max: 5, initial: 500, maxDelay: 10000 }), '每路由最多重试 5 次,退避 500ms→10000ms')
    assert.equal(internals.tr(t, 'retried', { n: 3 }), '试了 3 次')
    assert.equal(internals.tr(t, 'switchedTo', { route: 'ww/gpt-6-astra' }), '→ 切换至 ww/gpt-6-astra')
  })

  it('tr:t 自己就会插值时不必二次替换(不会重复填)', () => {
    const formatted = (key, params) => internals.fill(ZH[key], params ?? {})
    assert.equal(internals.tr(formatted, 'retryLine', { max: 0, initial: 1, maxDelay: 2 }), '每路由最多重试 0 次,退避 1ms→2ms')
  })
})

describe('client.js:retrySummary(面板的重试策略一行)', () => {
  it('开启时给出上限与退避', () => {
    assert.equal(
      internals.retrySummary(t, { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000 }),
      '每路由最多重试 5 次,退避 500ms→10000ms',
    )
  })

  it('maxRetries: 0 ⇒ 重试关闭文案', () => {
    assert.equal(internals.retrySummary(t, { maxRetries: 0 }), ZH.retryOff)
  })

  it('策略缺失/坏值 ⇒ 空串(面板不显示这一行,而不是显示 undefined)', () => {
    assert.equal(internals.retrySummary(t, undefined), '')
    assert.equal(internals.retrySummary(t, null), '')
    assert.equal(internals.retrySummary(t, 'nope'), '')
  })
})

describe('client.js:时钟与时长', () => {
  it('formatClock:ISO → 本地 HH:mm:ss(按本机时区断言,与实现无关)', () => {
    const iso = '2026-09-27T14:03:49.516Z'
    const expected = (() => {
      const date = new Date(iso)
      const pad = (value) => (value < 10 ? `0${value}` : `${value}`)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    })()
    assert.equal(internals.formatClock(iso), expected)
    assert.equal(internals.formatClock(new Date(iso)), expected, 'Date 实例同样接受')
  })

  it('formatClock:坏值给占位时钟', () => {
    assert.equal(internals.formatClock('not-a-date'), '--:--:--')
    assert.equal(internals.formatClock(undefined), '--:--:--')
  })

  it('formatDuration:毫秒/秒/分三档', () => {
    assert.equal(internals.formatDuration(0), '0ms')
    assert.equal(internals.formatDuration(999), '999ms')
    assert.equal(internals.formatDuration(1000), '1.0s')
    assert.equal(internals.formatDuration(1900), '1.9s')
    assert.equal(internals.formatDuration(12000), '12s', '≥10s 后不带小数')
    assert.equal(internals.formatDuration(95000), '1m35s')
  })

  it('formatDuration:坏值给占位符', () => {
    assert.equal(internals.formatDuration(undefined), '—')
    assert.equal(internals.formatDuration(-5), '—')
    assert.equal(internals.formatDuration('abc'), '—')
  })
})

describe('client.js:结局 → 状态点/标签', () => {
  it('三种结局各有可区分的色', () => {
    assert.equal(internals.outcomeState('ok'), 'done')
    assert.equal(internals.outcomeTone('ok'), 'success')
    assert.equal(internals.outcomeState('failed'), 'error')
    assert.equal(internals.outcomeTone('failed'), 'danger')
    assert.equal(internals.outcomeState('aborted'), 'idle')
    assert.equal(internals.outcomeTone('aborted'), 'quiet')
  })
})

describe('client.js:链编辑器纯函数(v0.6.0)', () => {
  it('端点常量与宿主一致,新增的目录端点也带上了', () => {
    assert.equal(client.CATALOG_PATH, '/api/llm-auto/catalog', '必须与宿主 lib/index.js 的 CATALOG_PATH 一致')
    for (const key of ['splitLabel', 'draftToConfig', 'draftToChain', 'sameChain', 'routeFromEndpoint', 'optionSummary', 'matchesQuery', 'filterGroups']) {
      assert.equal(typeof internals[key], 'function', `__internals.${key} 缺失`)
    }
    assert.deepEqual(internals.OPTION_KEYS, ['keepThinking', 'breakToolLoop'])
  })

  it('splitLabel 按**第一个**斜杠拆(model id 自己带斜杠时不能拆错)', () => {
    assert.deepEqual(internals.splitLabel('commandcode/deepseek/deepseek-v4.1-flash'), {
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
    })
    assert.deepEqual(internals.splitLabel('opencode-go/deepseek-v4.1-flash'), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    assert.deepEqual(internals.splitLabel('nohost'), { provider: '', model: 'nohost' })
  })

  it('端点的 chain(对象或裸字符串两种形状)都能还原成草稿', () => {
    assert.deepEqual(
      internals.routeFromEndpoint({ label: 'a/m1', options: { keepThinking: true, breakToolLoop: true } }, 'r1'),
      { key: 'r1', provider: 'a', model: 'm1', keepThinking: true, breakToolLoop: true },
    )
    assert.deepEqual(
      internals.routeFromEndpoint('b/m2', 'r2'),
      { key: 'r2', provider: 'b', model: 'm2', keepThinking: false, breakToolLoop: false },
      '0.5.x 的裸字符串也要认',
    )
  })

  it('草稿 → 配置:只写打开的开关(与宿主 lib/routes.js 同口径,也才与手写 YAML 同形)', () => {
    const off = toRouteDraft({ provider: 'a', model: 'm' }, 'r1')
    assert.deepEqual(internals.draftToConfig(off), { provider: 'a', model: 'm' })
    const on = toRouteDraft({ provider: 'a', model: 'm', keepThinking: true }, 'r2')
    assert.deepEqual(internals.draftToConfig(on), { provider: 'a', model: 'm', keepThinking: true })
    assert.equal(internals.optionSummary(on), 'keepThinking')
    assert.equal(internals.optionSummary(off), '')
  })

  it('客户端与服务端的收敛口径一致:同一份草稿两边得到同一份配置', () => {
    const drafts = [
      toRouteDraft({ provider: 'a', model: 'm1', keepThinking: true }, 'r1'),
      toRouteDraft({ provider: 'b', model: 'm2' }, 'r2'),
    ]
    assert.deepEqual(internals.draftToChain(drafts), toRouteChain(drafts.map((draft) => ({ ...draft }))))
  })

  it('sameChain 是"有没有改动"的判据:顺序、成员、开关任一变化都要能看出来', () => {
    const one = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }]
    assert.ok(internals.sameChain(one, one.map((item) => ({ ...item }))))
    assert.ok(!internals.sameChain(one, [one[1], one[0]]), '换序算改动')
    assert.ok(!internals.sameChain(one, [one[0]]), '少一条算改动')
    assert.ok(!internals.sameChain(one, [{ provider: 'a', model: 'm1', keepThinking: true }, one[1]]), '开关算改动')
  })

  it('搜索:大小写不敏感的有序子序列(与官方 rankByName 同判据)', () => {
    assert.ok(internals.matchesQuery('DeepSeek V4.1 Flash', 'dsf'))
    assert.ok(internals.matchesQuery('gpt-6.1-sol', 'G61'))
    assert.ok(internals.matchesQuery('任意名', ''), '空查询全过')
    assert.ok(!internals.matchesQuery('gpt-6.1-sol', 'sol6'), '顺序不对不算命中')
  })

  it('分组过滤:空组丢掉;命中 provider 名时整组保留', () => {
    const groups = [
      { id: 'commandcode', name: 'Command Code', models: [{ id: 'x', name: 'Alpha' }, { id: 'y', name: 'Beta' }] },
      { id: 'ww', name: 'ww-o', models: [{ id: 'z', name: 'Gamma' }] },
      { id: 'empty', name: 'Empty', models: [] },
    ]
    assert.deepEqual(internals.filterGroups(groups, '').map((group) => group.id), ['commandcode', 'ww', 'empty'], '不过滤时原样返回')
    assert.deepEqual(internals.filterGroups(groups, 'beta').map((group) => group.id), ['commandcode'])
    assert.deepEqual(internals.filterGroups(groups, 'beta')[0].models.map((model) => model.id), ['y'])
    assert.deepEqual(internals.filterGroups(groups, 'ww-o').map((group) => group.id), ['ww'], '命中 provider 名 ⇒ 整组保留')
    assert.deepEqual(internals.filterGroups(groups, 'zzz'), [])
  })
})

describe('client.js:样式与资源纪律', () => {
  it('面板样式只用 la- 前缀 + --dsw-* token,不写死颜色、不引外部资源', async () => {
    const source = await (await import('node:fs/promises')).readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const classes = source.match(/\.[a-zA-Z][\w-]*\{/gu) ?? []
    assert.ok(classes.length > 30, `应当有成规模的样式表,实际只匹配到 ${classes.length} 条`)
    const foreign = classes.filter((item) => !item.startsWith('.la-'))
    assert.deepEqual(foreign, [], `样式里出现了非 la- 前缀的类名:${foreign.join(', ')}`)
    assert.ok(source.includes('var(--dsw-alias-'), '颜色/背景走主题 token')
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/u.test(source), '样式里不该出现写死的十六进制颜色')
    assert.ok(!/https?:\/\//u.test(source), '客户端半侧不该引用任何外部 URL')
  })

  it('字典完整性:代码里 t("…") / tr(t, "…") 用到的每个键,中英两份字典都必须在', async () => {
    // 这条是回归防线:v0.6.0 重写 client.js 时漏掉了 retryLine / retryOff 两个键,
    // 界面上直接显示成裸键名「retryLine」—— 只有真机截图才看得出来。用源码级不变量盯住它。
    const source = await (await import('node:fs/promises')).readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const used = new Set()
    for (const match of source.matchAll(/\bt\("([A-Za-z][\w]*)"\)/gu)) used.add(match[1])
    for (const match of source.matchAll(/\btr\(t, "([A-Za-z][\w]*)"/gu)) used.add(match[1])
    assert.ok(used.size > 30, `引用到的字典键应当有几十个,实际只找到 ${used.size} 个`)

    const zhStart = source.indexOf('var zh = {')
    const enStart = source.indexOf('var en = {')
    const enEnd = source.indexOf('SettingsForm 框架自己渲染的文案')
    assert.ok(zhStart > 0 && enStart > zhStart && enEnd > enStart, '三处定位串必须都找得到')
    const zhBody = source.slice(zhStart, enStart)
    const enBody = source.slice(enStart, enEnd)

    const missingZh = [...used].filter((key) => !zhBody.includes(`${key}:`))
    const missingEn = [...used].filter((key) => !enBody.includes(`${key}:`))
    assert.deepEqual(missingZh, [], `中文字典缺这些键:${missingZh.join(', ')}`)
    assert.deepEqual(missingEn, [], `英文字典缺这些键:${missingEn.join(', ')}`)
  })
})

describe('client.js:额度摘要与「恢复包内默认链」的判据(v0.7.0)', () => {
  /** 额度段用到的字典模板(与 client.js 里 zh 的口径一致)。 */
  const QUOTA_ZH = {
    quotaMeta: '{at} 更新',
    quotaPending: '额度查询中…',
    quotaCmdCode: 'Command Code',
    quotaGo: 'OpenCode Go',
    quotaBalance: '余额 {amount}',
    quotaWindow5h: '5h',
    quotaWindowWeek: '周',
    quotaWindowMonth: '月',
    quotaExhausted: '已耗尽',
    quotaUnavailable: '不可查',
    quotaUnavailableReason: '不可查:{reason}',
    quotaReset: '{at} 重置',
    quotaNoAmount: '无金额口径',
  }
  const qt = (key, params) => internals.fill(Object.prototype.hasOwnProperty.call(QUOTA_ZH, key) ? QUOTA_ZH[key] : key, params ?? {})

  it('formatMoney:两位小数;拿不到数字给 ?(绝不用 0 顶替)', () => {
    assert.equal(internals.formatMoney(59.9240242796), '$59.92')
    assert.equal(internals.formatMoney(0), '$0.00')
    assert.equal(internals.formatMoney(null), '?')
    assert.equal(internals.formatMoney(undefined), '?')
  })

  it('formatResetAt:毫秒数(Command Code)与 ISO 串(OpenCode Go)两种口径都吃;坏值给空串', () => {
    const ms = Date.UTC(2026, 9, 24, 0, 0, 44)
    const expected = (() => {
      const date = new Date(ms)
      const pad = (value) => (value < 10 ? `0${value}` : `${value}`)
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    })()
    assert.equal(internals.formatResetAt(ms), expected, '毫秒时间戳')
    assert.equal(internals.formatResetAt('2026-10-24T00:00:44.000Z'), expected, 'ISO 串')
    assert.equal(internals.formatResetAt('not-a-date'), '')
    assert.equal(internals.formatResetAt(undefined), '')
  })

  it('formatQuota:CC 余额+窗口一行、Go 三档一行;已耗尽的档显示「已耗尽」而不是 0%', () => {
    const view = internals.formatQuota({
      state: 'fresh',
      checkedAt: '2026-10-05T07:40:11.000Z',
      sources: [
        { provider: 'commandcode', status: 'ok', credits: { total: 59.9240242796, belowThreshold: false }, plan: { planId: 'individual-goat' }, windows: { fiveHour: { used: 0.622990592, cap: 14 }, weekly: { used: 10.0759757204, cap: 35 } } },
        { provider: 'opencode-go', status: 'ok', windows: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 0 }, monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-24T00:00:44.000Z' } } },
      ],
    }, qt)
    assert.equal(view.rows.length, 2)
    assert.equal(view.rows[0].label, 'Command Code')
    assert.equal(view.rows[0].main, '余额 $59.92 · 5h $0.62/$14.00 · 周 $10.08/$35.00')
    assert.equal(view.rows[0].detail, 'individual-goat')
    assert.equal(view.rows[1].label, 'OpenCode Go')
    assert.match(view.rows[1].main, /月 已耗尽/u)
    assert.ok(!view.rows[1].main.includes('月 0%'), '已耗尽的档绝不能显示成 0%')
    assert.equal(view.rows[1].tone, 'danger')
    assert.match(view.rows[1].main, /5h 0% · 周 0%/u)
    assert.match(view.rows[1].detail, /重置$/u)
    assert.equal(view.pending, false)
    assert.match(view.meta, /更新$/u)
  })

  it('formatQuota:不可查的来源只给原因,主串为空、整行不含百分比', () => {
    const view = internals.formatQuota({
      state: 'fresh',
      checkedAt: '2026-10-05T07:40:11.000Z',
      sources: [{ provider: 'opencode-go', status: 'unavailable', reason: 'no-credential', message: '凭据 OPENCODE_API_KEY 未配置' }],
    }, qt)
    assert.equal(view.rows[0].main, '')
    assert.match(view.rows[0].detail, /^不可查:/u)
    assert.ok(!view.rows[0].main.includes('%'))
    assert.ok(!view.rows[0].detail.includes('%'))
  })

  it('formatQuota:旧宿主(没有 quota)/关掉/没有来源时整段不画;只有真在查时才给一行提示', () => {
    assert.equal(internals.formatQuota(undefined, qt), null)
    assert.equal(internals.formatQuota(null, qt), null)
    assert.equal(internals.formatQuota('nope', qt), null)
    assert.equal(internals.formatQuota({ state: 'disabled', sources: [] }, qt), null)
    assert.equal(internals.formatQuota({ state: 'fresh', sources: [] }, qt), null)
    // S2:链上没有任何本模块认识的 provider 时宿主永远不会落定 checkedAt ⇒ 只看 state 会画出
    // 一个**永久**的"额度查询中…";判据必须是 inFlight。
    assert.equal(internals.formatQuota({ state: 'pending', sources: [] }, qt), null, '没来源又没在查 ⇒ 整段不画')
    assert.equal(internals.formatQuota({ state: 'pending', inFlight: false, sources: [] }, qt), null)
    const pending = internals.formatQuota({ state: 'pending', inFlight: true, sources: [] }, qt)
    assert.deepEqual(pending.rows, [])
    assert.equal(pending.pending, true)
    assert.equal(pending.meta, '额度查询中…')
  })

  it('canResetChain:只有 user.routes 是非空数组才成立(没有覆盖时不画按钮)', () => {
    assert.equal(internals.canResetChain({ user: { routes: [{ provider: 'a', model: 'm' }] } }), true)
    assert.equal(internals.canResetChain({ user: { routes: [] } }), false, '空数组不算覆盖')
    assert.equal(internals.canResetChain({ user: {} }), false)
    assert.equal(internals.canResetChain({ user: { routes: 'nope' } }), false, '坏形状不误报')
    assert.equal(internals.canResetChain({}), false)
    assert.equal(internals.canResetChain(null), false)
    assert.equal(internals.canResetChain(undefined), false)
  })

  it('resetChainOps:op 形状固定为 unset routes,且每次给新数组', () => {
    assert.deepEqual(internals.resetChainOps(), [{ op: 'unset', path: ['routes'] }])
    const first = internals.resetChainOps()
    const second = internals.resetChainOps()
    assert.notEqual(first, second, '别把同一个数组交给两次写路径')
  })

  it('复核修复:不可查缺 message 时不拼成"不可查:不可查";CC 缺 total 时不画"余额"', () => {
    const view = internals.formatQuota({
      state: 'fresh',
      checkedAt: '2026-10-05T07:40:11.000Z',
      sources: [
        { provider: 'opencode-go', status: 'unavailable', reason: 'timeout' },
        { provider: 'commandcode', status: 'ok', credits: { purchased: 0, free: 0, belowThreshold: false }, windows: { fiveHour: { used: 1, cap: 14 } } },
      ],
    }, qt)
    assert.equal(view.rows[0].detail, '不可查', '没有 message 就给一句光秃秃的"不可查"')
    assert.ok(!view.rows[0].detail.includes(':'), '不要拼成"不可查:不可查"')
    assert.equal(view.rows[1].main.includes('余额'), false, '算不出总额就不画余额那一段')
    assert.equal(view.rows[1].main, '5h $1.00/$14.00')
  })
})

describe('client.js:自动排序段(v0.8.0)', () => {
  /** 排序段用到的字典模板(与 client.js 里 zh 的口径一致)。 */
  const ORDER_ZH = {
    orderingTitle: '自动排序',
    orderingToManual: '当前:自动排序。切到手动',
    orderingToAuto: '当前:手动。切回自动',
    orderingManualNote: '手动:按你排的顺序,不排序也不跳过。',
    orderingUnknown: '额度查不到,按配置顺序',
    orderingCooling: '{at} 恢复',
    orderingCoolingTag: '冷却中',
    orderingWindow5h: '5 小时',
    orderingWindowWeek: '周',
    orderingWindowMonth: '月度',
    orderingWindowCredits: '余额',
    orderingExhaustedWindow: '{window}已耗尽',
    orderingExhausted: '额度已耗尽',
    orderingIgnoredCooling: '全部路由都在冷却期内 —— 本次忽略冷却、仍按排序顺序尝试。',
    orderingSaveFailed: '切换没被接受,已保留原值。',
    orderingModeHint: '自动:按订阅月度重置时刻排序,并跳过额度耗尽的来源(冷却到它重置)。手动:完全按上面这条链的顺序,只失败时切换。它不改变链本身,改完即时生效。',
    // 0.9.0:合段后提示语随模式换(自动模式下"按下面的顺序"那句不成立)
    chainHint: '按下面的顺序依次尝试:第 1 项即首选。某条重试耗尽、或错误码不允许重试时,才静默切下一条。拖动行首的手柄改顺序,改完点「保存」写入配置并即时生效(不用重启)。',
    chainHintAuto: '自动排序生效中:按订阅的重置时刻排序、额度耗尽的来源暂时跳过;下面是本次实际会尝试的顺序。点开下面的「配置顺序」仍可改链,保存后即时生效(不用重启)。',
  }
  const ot = (key, params) => internals.fill(Object.prototype.hasOwnProperty.call(ORDER_ZH, key) ? ORDER_ZH[key] : key, params ?? {})

  it('旧宿主(没有 ordering 键)/ 坏形状 ⇒ 整段不画(面板天然兼容新旧宿主)', () => {
    assert.equal(internals.formatOrdering(undefined, ot), null)
    assert.equal(internals.formatOrdering(null, ot), null)
    assert.equal(internals.formatOrdering('nope', ot), null)
    assert.equal(internals.formatOrdering(7, ot), null)
  })

  it('auto:按实际顺序逐条给出,冷却中的带「冷却中」标签与恢复时刻', () => {
    const view = internals.formatOrdering({
      mode: 'auto',
      effective: [
        { label: 'opencode-go/deepseek-v4.1-flash', provider: 'opencode-go', reason: 'monthly-reset-asc' },
        { label: 'commandcode/deepseek/deepseek-v4.1-flash', provider: 'commandcode', reason: 'monthly-reset-asc', cooling: true, until: '2026-11-04T06:00:31.000Z' },
        { label: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', reason: 'unknown' },
      ],
      cooldown: [{ provider: 'commandcode', until: Date.UTC(2026, 10, 4, 6, 0, 31) }],
      ignoredCooldown: false,
    }, ot)
    assert.equal(view.manual, false)
    assert.equal(view.rows.length, 3)
    assert.equal(view.rows[0].label, 'opencode-go/deepseek-v4.1-flash')
    assert.equal(view.rows[0].cooling, false)
    assert.equal(view.rows[0].detail, '', '订阅档不必每行重复"越早越靠前"')
    assert.equal(view.rows[1].cooling, true)
    assert.equal(view.rows[1].tag, '冷却中')
    assert.match(view.rows[1].detail, /恢复$/u)
    assert.equal(view.rows[2].detail, '额度查不到,按配置顺序', '未知档要有明确说法')
    assert.equal(view.note, '')
  })

  it('冷却终点的两种口径都吃:ISO 串渲染出本地时刻,坏值只给标签不给时刻', () => {
    const iso = internals.formatOrdering({
      mode: 'auto',
      effective: [{ label: 'opencode-go/x', provider: 'opencode-go', cooling: true, until: '2026-10-24T00:00:44.000Z' }],
    }, ot)
    assert.equal(iso.rows[0].detail, `${internals.formatResetAt('2026-10-24T00:00:44.000Z')} 恢复`)
    const bad = internals.formatOrdering({
      mode: 'auto',
      effective: [{ label: 'opencode-go/x', provider: 'opencode-go', cooling: true, until: 'not-a-date' }],
    }, ot)
    assert.equal(bad.rows[0].tag, '冷却中', '时刻解析不了也要标出"冷却中"')
    assert.equal(bad.rows[0].detail, '', '拿不到时刻就不写,而不是写个假的')
  })

  it('冷却行说清"是哪一档打满"(固定枚举 id → 字典;认不出的退回中性说法)', () => {
    const at = internals.formatResetAt('2026-10-24T00:00:44.000Z')
    const detail = (windows) => internals.formatOrdering({
      mode: 'auto',
      effective: [{
        label: 'opencode-go/deepseek-v4.1-flash',
        provider: 'opencode-go',
        reason: 'monthly-reset-asc',
        cooling: true,
        until: '2026-10-24T00:00:44.000Z',
        ...(windows === undefined ? {} : { windows: windows }),
      }],
    }, ot).rows[0].detail
    assert.equal(detail(['monthly']), `月度已耗尽,${at} 恢复`, '设计档 §7 的那句原话')
    assert.equal(detail(['rolling']), `5 小时已耗尽,${at} 恢复`)
    assert.equal(detail(['fiveHour']), `5 小时已耗尽,${at} 恢复`)
    assert.equal(detail(['weekly']), `周已耗尽,${at} 恢复`)
    assert.equal(detail(['credits']), `余额已耗尽,${at} 恢复`, 'CC 的月度余额那一档')
    assert.equal(detail(['monthly', 'credits']), `月度 / 余额已耗尽,${at} 恢复`)
    assert.equal(detail(['monthly', 'monthly']), `月度已耗尽,${at} 恢复`, '重复的 id 去重')
    assert.equal(detail(['RateLimit']), `额度已耗尽,${at} 恢复`, '上游原始键名不认 ⇒ 中性说法,绝不显示裸键名')
    assert.equal(detail([]), `额度已耗尽,${at} 恢复`)
    assert.equal(detail(undefined), `${at} 恢复`, '老宿主没这个键 ⇒ 只写解除时刻')
  })

  it('manual ⇒ 只给一行说明,不渲染 effective(那种模式本来就不排序)', () => {
    const view = internals.formatOrdering({
      mode: 'manual',
      effective: [{ label: 'opencode-go/x', provider: 'opencode-go', reason: 'monthly-reset-asc' }],
      cooldown: [],
      ignoredCooldown: false,
    }, ot)
    assert.equal(view.manual, true)
    assert.deepEqual(view.rows, [], 'manual 下不渲染实际顺序')
    assert.equal(view.hint, '手动:按你排的顺序,不排序也不跳过。')
    assert.equal(view.note, '')
    // 模式坏值一律当 auto(与宿主 normalizeOrdering 同口径)
    assert.equal(internals.formatOrdering({ mode: 'bogus', effective: [] }, ot).manual, false)
  })

  it('全冷却兜底 ⇒ 面板说明一句(避免被当成故障)', () => {
    const view = internals.formatOrdering({
      mode: 'auto',
      effective: [{ label: 'a/b', provider: 'a', reason: 'never-expires' }],
      ignoredCooldown: true,
    }, ot)
    assert.equal(view.note, '全部路由都在冷却期内 —— 本次忽略冷却、仍按排序顺序尝试。')
    assert.equal(view.rows[0].cooling, false, '兜底放行的条目不标冷却')
  })

  it('effective 坏形状/缺字段不抛:空数组、非数组、条目不是对象都安全', () => {
    assert.deepEqual(internals.formatOrdering({ mode: 'auto', effective: [] }, ot).rows, [])
    assert.deepEqual(internals.formatOrdering({ mode: 'auto', effective: 'nope' }, ot).rows, [])
    assert.deepEqual(internals.formatOrdering({ mode: 'auto' }, ot).rows, [])
    const view = internals.formatOrdering({ mode: 'auto', effective: [null, 7, {}, { provider: 'x' }] }, ot)
    assert.equal(view.rows.length, 4)
    assert.equal(view.rows[3].label, 'x', '没有 label 时退回 provider 名')
  })

  it('orderingModeOps:op 形状固定为 set ordering={mode},只写这一个键,且每次给新数组', () => {
    assert.deepEqual(internals.orderingModeOps('manual'), [{ op: 'set', path: ['ordering'], value: { mode: 'manual' } }])
    assert.deepEqual(internals.orderingModeOps('auto'), [{ op: 'set', path: ['ordering'], value: { mode: 'auto' } }])
    assert.deepEqual(internals.orderingModeOps(undefined), [{ op: 'set', path: ['ordering'], value: { mode: 'auto' } }], '坏值回落 auto')
    assert.deepEqual(internals.orderingModeOps('MANUAL'), [{ op: 'set', path: ['ordering'], value: { mode: 'auto' } }])
    const first = internals.orderingModeOps('auto')
    const second = internals.orderingModeOps('auto')
    assert.notEqual(first, second, '别把同一个数组交给两次写路径')
  })

  it('chainSectionPlan:模式决定主视图(auto 折配置链 + 主推生效顺序 / manual 直接给链 / 无 ordering 退回 manual;v0.9.0)', () => {
    const auto = internals.chainSectionPlan({
      mode: 'auto',
      effective: [{ label: 'a/b', provider: 'a', reason: 'monthly-reset-asc' }],
    }, ot)
    assert.equal(auto.manual, false)
    assert.equal(auto.collapsible, true, '自动模式下可编辑的链折进「配置顺序」')
    assert.equal(auto.rows.length, 1, '主视图给的是生效顺序')
    assert.equal(auto.hint, ORDER_ZH.chainHintAuto, '自动模式的提示语不能是"按下面的顺序"那句')

    const allCooling = internals.chainSectionPlan({
      mode: 'auto',
      effective: [{ label: 'a/b', provider: 'a', reason: 'never-expires' }],
      ignoredCooldown: true,
    }, ot)
    assert.match(allCooling.note, /忽略冷却/u, '全冷却兜底那句照旧透给面板')

    const manual = internals.chainSectionPlan({
      mode: 'manual',
      effective: [{ label: 'a/b', provider: 'a', reason: 'monthly-reset-asc' }],
      ignoredCooldown: true,
    }, ot)
    assert.equal(manual.manual, true)
    assert.equal(manual.collapsible, false, '手动模式下链就是主视图,不折叠')
    assert.deepEqual(manual.rows, [], '手动模式不画生效顺序')
    assert.equal(manual.note, '', '手动模式也不画全冷却兜底那句')
    assert.equal(manual.hint, ORDER_ZH.chainHint)

    for (const missing of [undefined, null, 'nope', 7]) {
      const plan = internals.chainSectionPlan(missing, ot)
      assert.equal(plan.view, null)
      assert.equal(plan.manual, true, '旧宿主 / 还没读回来 ⇒ 退回手动形态(链直接可见)')
      assert.equal(plan.collapsible, false)
      assert.deepEqual(plan.rows, [])
      assert.equal(plan.hint, ORDER_ZH.chainHint)
    }
  })
})
