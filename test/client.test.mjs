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
    for (const key of ['fill', 'tr', 'formatClock', 'formatDuration', 'retrySummary', 'outcomeState', 'outcomeTone']) {
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
