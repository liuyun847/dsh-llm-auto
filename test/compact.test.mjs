/**
 * 「压缩点 → 声明窗口」的反算式与窗口口径解析(纯函数,不需要 harness)。
 *
 * 最值钱的两条:
 *  1. 把 `@deepseek-ai/dsh-compaction-basic` 的 `resolveCompactSpec` **独立复刻一遍**,
 *     验算"反算出来的窗口真能把压缩阈值钉在 T"——两边算式不一致就说明映射不成立;
 *  2. 用真 schemastery schema 跑一遍 `~standard.validate()`,证明导出 `Config` 之后
 *     宿主那条路径(补默认值 + volatile 引用包装)拿到的值仍能被正确解包。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMPACT_HEADROOM_TOKENS,
  COMPACT_RETAIN_RATIO,
  COMPACT_THRESHOLD_RATIO,
  DEFAULT_COMPACT_WINDOW,
  WINDOW_SOURCE,
  compactRetainFor,
  compactThresholdFor,
  declaredWindowForCompactPoint,
  describeWindowPlan,
  minimumUsableCompactWindow,
  planDeclaredWindow,
  unwrapVolatile,
} from '../lib/compact.js'
import { Config } from '../lib/index.js'
import { DEFAULT_CONTEXT_WINDOW } from '../lib/routes.js'

/** cosmokit 的 volatile 引用标记(与 lib/compact.js 同一口径)。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 造一个与宿主里同形的 volatile 引用。 */
function volatileRef(value) {
  return Object.freeze({ get: () => value, [VOLATILE_WRITE]: () => {} })
}

/**
 * 复刻 `@deepseek-ai/dsh-compaction-basic` 的 `resolveCompactSpec`(该包 lib/index.js:124-147)。
 * 刻意独立于被测代码重写:被测代码算错了,这里不会跟着错。
 * @returns `{ thresholdTokens, retainTokens }` 或 `{ error }`(引擎会抛 TargetPressureConfigError 的分支)。
 */
function engineSpec(contextWindow, reservedCompletionTokens = 0) {
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) return { error: 'no message budget' }
  const pressureBudgetTokens = messageBudgetTokens - COMPACT_HEADROOM_TOKENS
  if (pressureBudgetTokens <= 0) return { error: 'no pressure budget' }
  const thresholdTokens = Math.floor(Math.min(contextWindow * COMPACT_THRESHOLD_RATIO, pressureBudgetTokens))
  const retainTokens = Math.floor(messageBudgetTokens * COMPACT_RETAIN_RATIO)
  if (retainTokens >= thresholdTokens) return { error: `retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}` }
  return { thresholdTokens, retainTokens }
}

describe('declaredWindowForCompactPoint:压缩点 → 声明窗口', () => {
  it('500000 → 625000(0.8 × 625000 = 500000;625000 − 65536 = 559464 > 500000,min 取前者)', () => {
    assert.equal(declaredWindowForCompactPoint(DEFAULT_COMPACT_WINDOW), 625000)
    assert.equal(compactThresholdFor(625000), 500000)
    assert.equal(compactRetainFor(625000), 100000, '保留尾部 100000 < 阈值 500000')
  })

  it('几组边界值:三档都钉得住阈值(headroom 项严格胜出 T≤262140、两项同值 262141~262144、比例项严格胜出 T≥262145)', () => {
    for (const T of [12484, 12485, 100000, 262143, 262144, 262145, 327679, 327680, 500000, 884000, 1000000, 10000000]) {
      const declared = declaredWindowForCompactPoint(T)
      const spec = engineSpec(declared)
      assert.equal(spec.error, undefined, `T=${T}:引擎不该报错(${spec.error})`)
      assert.equal(spec.thresholdTokens, T, `T=${T}:声明 ${declared} 时引擎阈值应为 ${T}`)
      assert.ok(spec.retainTokens < spec.thresholdTokens, `T=${T}:保留尾部要小于阈值`)
      assert.equal(compactThresholdFor(declared), T, `T=${T}:本地复刻的算式也要一致`)
    }
  })

  it('抽样 1..3,000,000(步长 997):阈值处处精确落在 T(±1 就是 500000 与 499999 的差别)', () => {
    for (let T = 12484; T <= 3000000; T += 997) {
      const declared = declaredWindowForCompactPoint(T)
      assert.equal(compactThresholdFor(declared), T, `T=${T}(声明 ${declared})`)
    }
  })

  it('反算用 T×5/4 而不是 T/0.8:两种写法实测等价,但整数路线不把 0.8 的二进制误差带进算式', () => {
    for (const T of [12484, 262144, 500000, 884000, 1000000]) {
      assert.equal(Math.ceil((T * 5) / 4), Math.ceil(T / 0.8), `T=${T} 两种写法应得同一个窗口`)
    }
    assert.equal(declaredWindowForCompactPoint(500000), Math.ceil(500000 / 0.8))
  })

  it('非法入参抛 TypeError(配置层的非法值不会走到这里,由 planDeclaredWindow 兜)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '500000', null, undefined]) {
      assert.throws(() => declaredWindowForCompactPoint(bad), TypeError, `${String(bad)} 应抛 TypeError`)
    }
  })
})

describe('minimumUsableCompactWindow:引擎的硬下界', () => {
  it('下界是算出来的 12484:12483 会被引擎拒,T-1 与 T 的差别就在保留尾部', () => {
    assert.equal(minimumUsableCompactWindow(), 12484)
    // 12483:声明 78019,保留尾部 floor(0.16 × 78019) = 12483 ≥ 阈值 12483 ⇒ 引擎抛 TargetPressureConfigError
    const bad = engineSpec(declaredWindowForCompactPoint(12483))
    assert.match(bad.error, /must be less than threshold tokens/u)
    assert.equal(compactRetainFor(declaredWindowForCompactPoint(12483)), 12483)
    // 12484 起一切正常
    assert.equal(engineSpec(declaredWindowForCompactPoint(12484)).thresholdTokens, 12484)
  })
})

describe('planDeclaredWindow:窗口口径的优先级', () => {
  it('都没配 ⇒ source = routes(由调用方逐跳解析),不打 warn', () => {
    const plan = planDeclaredWindow({})
    assert.deepEqual(plan, { compactPoint: null, declaredContextWindow: null, source: WINDOW_SOURCE.ROUTES, warnings: [] })
  })

  it('只给 compactWindow ⇒ 反算,source = compactWindow,不打 warn', () => {
    const plan = planDeclaredWindow({ compactWindow: 400000 })
    assert.equal(plan.source, WINDOW_SOURCE.COMPACT_WINDOW)
    assert.equal(plan.compactPoint, 400000)
    assert.equal(plan.declaredContextWindow, 500000)
    assert.deepEqual(plan.warnings, [])
  })

  it('compactWindow 与 contextWindow 同时给出 ⇒ 用 compactWindow、忽略 contextWindow,并一条 warn 说明两者', () => {
    const plan = planDeclaredWindow({ compactWindow: 400000, contextWindow: 4096 })
    assert.equal(plan.declaredContextWindow, 500000, 'compactWindow 胜出')
    assert.equal(plan.warnings.length, 1)
    assert.match(plan.warnings[0], /同时给出/u)
    assert.match(plan.warnings[0], /用 compactWindow\(400000 ⇒ 声明窗口 500000\)/u)
    assert.match(plan.warnings[0], /忽略 contextWindow\(4096\)/u)
  })

  it('compactWindow 非法(非正整数)⇒ warn 后回落默认 500000 ⇒ 声明 625000', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '500000', {}, []]) {
      const plan = planDeclaredWindow({ compactWindow: bad })
      assert.equal(plan.source, WINDOW_SOURCE.COMPACT_WINDOW, `${JSON.stringify(bad)} 仍算"给出"`)
      assert.equal(plan.compactPoint, DEFAULT_COMPACT_WINDOW)
      assert.equal(plan.declaredContextWindow, 625000)
      assert.equal(plan.warnings.length, 1)
      assert.match(plan.warnings[0], /应为正整数/u)
      assert.match(plan.warnings[0], /回落默认 500000/u)
    }
  })

  it('compactWindow 非法 + contextWindow 同时给出 ⇒ 两条 warn(非法回落 + 忽略 contextWindow)', () => {
    const plan = planDeclaredWindow({ compactWindow: 0, contextWindow: 4096 })
    assert.equal(plan.warnings.length, 2)
    assert.match(plan.warnings[0], /应为正整数/u)
    assert.match(plan.warnings[1], /忽略 contextWindow\(4096\)/u)
  })

  it('过小值(T < 12484)另打一条 warn,点名 TargetPressureConfigError', () => {
    const plan = planDeclaredWindow({ compactWindow: 4096 })
    assert.equal(plan.declaredContextWindow, 4096 + COMPACT_HEADROOM_TOKENS)
    assert.equal(plan.warnings.length, 1)
    assert.match(plan.warnings[0], /偏小/u)
    assert.match(plan.warnings[0], /TargetPressureConfigError/u)
    assert.match(plan.warnings[0], /12484/u)
  })

  it('只给 contextWindow ⇒ 直接声明(逃生门),不打 warn', () => {
    const plan = planDeclaredWindow({ contextWindow: 884000 })
    assert.equal(plan.source, WINDOW_SOURCE.CONTEXT_WINDOW)
    assert.equal(plan.declaredContextWindow, 884000)
    assert.equal(plan.compactPoint, null)
    assert.deepEqual(plan.warnings, [])
  })

  it('null 视为"没给"(YAML 里写了个空键),坏类型也不算数', () => {
    assert.equal(planDeclaredWindow({ compactWindow: null }).source, WINDOW_SOURCE.ROUTES)
    assert.equal(planDeclaredWindow({ contextWindow: null }).source, WINDOW_SOURCE.ROUTES)
    assert.equal(planDeclaredWindow({ contextWindow: '4096' }).source, WINDOW_SOURCE.ROUTES, '字符串不算正整数')
  })

  it('读得懂宿主里的 volatile 引用(导出 Config 后的真实路径)', () => {
    const plan = planDeclaredWindow({ compactWindow: volatileRef(300000), contextWindow: volatileRef(undefined) })
    assert.equal(plan.compactPoint, 300000)
    assert.equal(plan.declaredContextWindow, 375000)
    assert.deepEqual(plan.warnings, [])
  })
})

describe('unwrapVolatile:cosmokit 引用的解包', () => {
  it('引用解成值;普通值原样返回', () => {
    assert.equal(unwrapVolatile(volatileRef(625000)), 625000)
    assert.equal(unwrapVolatile(volatileRef(undefined)), undefined)
    assert.equal(unwrapVolatile(625000), 625000)
    assert.equal(unwrapVolatile('Auto'), 'Auto')
    assert.equal(unwrapVolatile(undefined), undefined)
    assert.deepEqual(unwrapVolatile([{ provider: 'a', model: 'b' }]), [{ provider: 'a', model: 'b' }])
  })

  it('只有"带 cosmokit 标记且能 get"的对象才算引用(普通 config 对象不被误伤)', () => {
    assert.deepEqual(unwrapVolatile({ get: 'not-a-function' }), { get: 'not-a-function' })
    assert.deepEqual(unwrapVolatile({ routes: [] }), { routes: [] })
  })
})

describe('describeWindowPlan:挂载日志里必须带上所依赖的假设', () => {
  it('映射分支:压缩点 → 声明窗口 + 假设常量', () => {
    const line = describeWindowPlan(planDeclaredWindow({ compactWindow: DEFAULT_COMPACT_WINDOW }), DEFAULT_CONTEXT_WINDOW)
    assert.match(line, /^auto: 压缩点 500000 → 声明窗口 625000\(假设 compaction-basic thresholdRatio 0\.8 \/ headroomTokens 65536\)$/u)
  })

  it('contextWindow 分支:说明没启用映射,并报出实际压缩点', () => {
    const line = describeWindowPlan(planDeclaredWindow({ contextWindow: 884000 }), DEFAULT_CONTEXT_WINDOW)
    assert.match(line, /声明窗口 884000/u)
    assert.match(line, /未启用压缩点映射/u)
    assert.match(line, new RegExp(`压缩点 ${compactThresholdFor(884000)}`, 'u'))
  })

  it('contextWindow 小于 headroom 时点名 pressure budget ≤ 0(引擎会每轮抛错)', () => {
    const line = describeWindowPlan(planDeclaredWindow({ contextWindow: 65536 }), DEFAULT_CONTEXT_WINDOW)
    assert.match(line, /pressure budget ≤ 0/u)
    assert.match(line, /TargetPressureConfigError/u)
  })

  it('逐跳解析分支:说明兜底值', () => {
    const line = describeWindowPlan(planDeclaredWindow({}), DEFAULT_CONTEXT_WINDOW)
    assert.match(line, /未配置 compactWindow\/contextWindow/u)
    assert.match(line, /65536/u)
  })
})

describe('导出的 Config:设置页可编辑性 + 宽松策略', () => {
  /** 取出 schema 的根节点(toJSON 是"引用图",不是嵌套树)。 */
  function schemaRoot() {
    const json = Config.toJSON()
    return { json, root: json.refs[json.uid] }
  }

  it('六个键都在,且每个都带中文 description(设置页唯一的说明来源)', () => {
    const { json, root } = schemaRoot()
    assert.deepEqual(Object.keys(root.dict).sort(), ['compactWindow', 'contextWindow', 'logLimit', 'name', 'retry', 'routes'])
    for (const [key, ref] of Object.entries(root.dict)) {
      const meta = json.refs[ref].meta
      assert.equal(typeof meta.description, 'string', `${key} 缺 description`)
      assert.ok(meta.description.length > 0, `${key} 的 description 为空`)
      assert.match(meta.description, /[\u4e00-\u9fff]/u, `${key} 的 description 应为中文`)
    }
  })

  it('compactWindow 默认 500000 且标了 volatile(不标就不会出现在设置页表单里)', () => {
    const { json, root } = schemaRoot()
    const node = json.refs[root.dict.compactWindow]
    assert.equal(node.type, 'number')
    assert.equal(node.meta.default, DEFAULT_COMPACT_WINDOW)
    assert.equal(node.meta.volatile, true)
    for (const key of ['name', 'contextWindow', 'logLimit']) {
      assert.equal(json.refs[root.dict[key]].meta.volatile, true, `${key} 应为 volatile`)
    }
    for (const key of ['routes', 'retry']) {
      assert.equal(json.refs[root.dict[key]].meta.volatile, undefined, `${key} 是结构性键,不该标 volatile`)
    }
  })

  it('宽松策略:routes/retry 坏值、未知键都不会让校验失败;数值字段的类型错才会', () => {
    const validate = (value) => Config['~standard'].validate(value)
    const loose = validate({ routes: 'not-an-array', retry: 'nope', unknownKey: 1 })
    assert.equal(loose.issues, undefined, 'routes/retry 的坏形状必须留给 normalizeRoutes/normalizeRetry')
    assert.equal(loose.value.routes, 'not-an-array')
    assert.equal(loose.value.unknownKey, 1, '未知键原样保留(不会被剥掉)')
    // 数值字段保持"是数字"这一条(设置页据此渲染数字输入框):类型错会失败,这点写进 README
    assert.ok(validate({ compactWindow: 'abc' }).issues !== undefined)
    assert.equal(validate({ compactWindow: -5 }).issues, undefined, '负数不是 schema 的活,交给 planDeclaredWindow warn + 回落')
  })

  it('经真 schema 走一遍(宿主路径):默认值被补上并包装成 volatile 引用,解包后仍是 500000 ⇒ 声明 625000', () => {
    const resolved = Config['~standard'].validate({ routes: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }] }).value
    assert.equal(typeof resolved.compactWindow, 'object', 'volatile 字段拿到的是引用而不是值')
    assert.equal(unwrapVolatile(resolved.compactWindow), DEFAULT_COMPACT_WINDOW)
    assert.equal(unwrapVolatile(resolved.name), undefined)
    assert.equal(unwrapVolatile(resolved.contextWindow), undefined)
    const plan = planDeclaredWindow(resolved)
    assert.equal(plan.source, WINDOW_SOURCE.COMPACT_WINDOW, '默认口径 = 映射(不是逐跳解析出的 884000)')
    assert.equal(plan.compactPoint, DEFAULT_COMPACT_WINDOW)
    assert.equal(plan.declaredContextWindow, 625000)
    assert.deepEqual(plan.warnings, [])
  })
})
