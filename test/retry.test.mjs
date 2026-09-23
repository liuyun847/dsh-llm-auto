/**
 * 重试策略解析:normalizeRetry 的全部分支、退避算法(官方口径)、策略描述。
 * 策略形状/默认值/校验委托官方 resolveRetryPolicy —— 这里钉住的是"包装层"行为:
 * 布尔/坏值/always 的处置,以及没造轮子的那四行退避数学。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeRetryDelay, describeRetryPolicy, normalizeRetry, DEFAULT_RETRY_POLICY, NO_RETRY_POLICY } from '../lib/index.js'

describe('normalizeRetry', () => {
  it('缺省 / null / true ⇒ 官方默认策略,无警告', () => {
    for (const raw of [undefined, null, true]) {
      const { policy, warnings } = normalizeRetry(raw)
      assert.deepEqual(warnings, [])
      assert.equal(policy, DEFAULT_RETRY_POLICY)
      assert.equal(policy.mode, 'normal')
      assert.equal(policy.maxRetries, 5, '官方默认 = 5 次重试(共 6 次尝试)')
      assert.deepEqual([...policy.retryableCodes], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
      assert.equal(policy.initialDelayMs, 500)
      assert.equal(policy.maxDelayMs, 10000)
      assert.equal(policy.jitterRatio, 0.1)
    }
  })

  it('false ⇒ 关闭重试(每路由只尝试一次)', () => {
    const { policy, warnings } = normalizeRetry(false)
    assert.deepEqual(warnings, [])
    assert.equal(policy, NO_RETRY_POLICY)
    assert.equal(policy.maxRetries, 0)
  })

  it('对象 ⇒ 按官方 schema 校验并返回(normal 模式)', () => {
    const { policy, warnings } = normalizeRetry({ maxRetries: 2, retryableCodes: ['SERVER'], backoff: { initialDelayMs: 100, maxDelayMs: 2000, jitterRatio: 0.5 } })
    assert.deepEqual(warnings, [])
    assert.equal(policy.maxRetries, 2)
    assert.deepEqual([...policy.retryableCodes], ['SERVER'])
    assert.equal(policy.initialDelayMs, 100)
    assert.equal(policy.maxDelayMs, 2000)
    assert.equal(policy.jitterRatio, 0.5)
  })

  it('显式 mode: normal 也接受', () => {
    const { policy, warnings } = normalizeRetry({ mode: 'normal', maxRetries: 1 })
    assert.deepEqual(warnings, [])
    assert.equal(policy.maxRetries, 1)
  })

  it('mode: always 拒绝(无上限重试 ⇒ 单请求可能无上限计费),回落官方默认并 warn', () => {
    const { policy, warnings } = normalizeRetry({ mode: 'always' })
    assert.equal(policy, DEFAULT_RETRY_POLICY)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /只支持 "normal"/u)
  })

  it('坏值(负数次数 / 退避倒挂 / 未知键 / 非对象)一律 warn + 回落官方默认,不抛错', () => {
    const cases = [{ maxRetries: -1 }, { backoff: { initialDelayMs: 99999, maxDelayMs: 1 } }, { attempts: 5 }, 'nope', 42, []]
    for (const raw of cases) {
      const { policy, warnings } = normalizeRetry(raw)
      assert.equal(policy, DEFAULT_RETRY_POLICY, `${JSON.stringify(raw)} 应回落官方默认`)
      assert.equal(warnings.length, 1, `${JSON.stringify(raw)} 应有一条 warn`)
    }
  })

  it('策略冻结:返回的 policy 不可变(官方 resolveRetryPolicy 的行为)', () => {
    const { policy } = normalizeRetry({ maxRetries: 1 })
    assert.ok(Object.isFrozen(policy))
  })
})

describe('computeRetryDelay(官方口径:指数 + 对称 jitter,封顶 maxDelayMs)', () => {
  const policy = normalizeRetry({ maxRetries: 10, backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }).policy

  it('random = 0.5 ⇒ jitter 系数恰为 1,序列为 500/1000/2000/4000/8000/10000(封顶)', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((retry) => computeRetryDelay(policy, retry, () => 0.5)), [500, 1000, 2000, 4000, 8000, 10000, 10000])
  })

  it('jitter 边界:random = 0 ⇒ ×(1-jitter);random = 1 ⇒ ×(1+jitter),均不超 maxDelayMs', () => {
    assert.equal(computeRetryDelay(policy, 1, () => 0), 450)
    assert.equal(computeRetryDelay(policy, 1, () => 1), 550)
    // 封顶先生效再乘 jitter 也不会超(官方实现里最后还有一道 min)
    assert.equal(computeRetryDelay(policy, 9, () => 1), 10000)
  })
})

describe('describeRetryPolicy', () => {
  it('关闭时明确说"关闭"', () => {
    assert.match(describeRetryPolicy(NO_RETRY_POLICY), /重试: 关闭/u)
  })

  it('开启时带次数/码集/退避三要素', () => {
    const text = describeRetryPolicy(DEFAULT_RETRY_POLICY)
    assert.match(text, /每路由最多 5 次/u)
    assert.match(text, /EMPTY_RESPONSE\/RATE_LIMIT\/SERVER\/TIMEOUT\/TRANSPORT/u)
    assert.match(text, /500→10000ms jitter 0\.1/u)
  })
})
