/**
 * dsh-llm-auto —— 历史助手消息的「回放归属修正」「跨路由思考摘除」与「路由切换通知」(纯函数)。
 *
 * ## 缺陷①(2026-09-24 字节级实测):同路由的历史回放被剥掉 replay
 *
 * 经 `auto` 的会话在**回放历史**时,模型自己每一轮的思考会被当成普通正文发给上游,
 * 且思考通道被填成空串;直连同一路由(`opencode-go`)则两个通道严格分离。链路五环:
 *
 * 1. `dsh-agent-loop` 把**当次请求的 provider** 写进 `source.provider`
 *    (`...\dsh-agent-loop\lib\index.js:1121`)⇒ 经 `auto` 产出的每一轮历史里都写着 `auto`,
 *    而它携带的 `replayState` 其实是**嵌套路由的适配器**(如 pi-ai)写下的。
 * 2. `LlmRuntime.forAdapter`(`...\dsh-llm\lib\index.js:2241-2263`,判定在 `:2247`)的规则是
 *    「历史 provider 的适配器 === 本次要用的适配器」才保留 replay 状态,否则只留
 *    `{kind:'model', provider, model}`。嵌套调用里本次适配器是 pi-ai、历史 provider 是 `auto`
 *    (归本插件的 AutoAdapter)⇒ replay 状态被剥掉。
 * 3. `dsh-llm-pi-ai` 的 `toPiAssistant` 见不到 replay ⇒ 退到 `foreignAssistant`,
 *    给消息打上 `provider=auto` / `api="dsh-foreign"` / `model=auto`。
 * 4. pi-ai 的 `transformMessages` 算 `isSameModel`(provider + api + model 三者全等)
 *    ⇒ `auto ≠ opencode-go` ⇒ 假 ⇒ 思考块被降级成普通文本块。
 * 5. pi-ai 的 OpenAI 序列化把所有文本块拼成一个字符串当 `content`;思考通道没人写,
 *    又因 `requiresReasoningContentOnAssistantMessages` 补成 `""`。
 *
 * ## 修法①:把 source 改回它 replay 状态里记着的真实路由
 *
 * 在把请求交给嵌套调用**之前**,把每条历史助手消息的 `source.provider` / `source.model`
 * 换成 `source.replayState.response.provider` / `.model`(嵌套适配器当初真正用的那组值)。
 * 于是环 ② 的判定成立(历史 provider 的适配器就是嵌套适配器)⇒ replay 状态保留 ⇒
 * pi-ai 走 `replayedAssistant`(它正好校验 `response.provider === source.provider`
 * 且 `response.model === source.model`,改写后逐字通过)⇒ 思考回 `reasoning_content`、
 * 正文回 `content`。
 *
 * ## 缺陷②(2026-09-28 字节级实测):跨路由的历史思考被降级成正文
 *
 * 会话中途换过路由时,修法① 只救得回**同路由**的历史;跨路由的历史消息走 pi-ai 的另一条
 * 分支:`transform-messages.js:66-90` 对「历史消息的模型 ≠ 本次请求模型」的助手消息做
 * `return { type: 'text', text: block.thinking }` —— 思考块被**降级成正文**。抓包实测
 * (跨路由臂)那条历史消息出站是 `keys=[role,content]`、`content` 长 145 = 思考 124 + 真答案 21
 * (**零分隔符**)、没有任何独立思考字段;同路由对照臂 `content` 只有真答案 17 字符、
 * 思考 124 字符在 `reasoning_content` 里。后果不是"少一段上下文",而是**模型把内心独白
 * 学成正文格式**,整场会话此后思考全进正文且不可自愈。
 *
 * 判据是 `provider + api + model` **三者全等**(`transform-messages.js:68-70`),而链上 4 条路由的
 * provider 互不相同 ⇒ **任何**中途切换都必然走降级分支;把某条路由移出链只是换个受害者。
 *
 * ## 修法②:跨路由时把 `reasoning` 从 `content` 与 `replayState.blocks` **同步**摘掉
 *
 * ```
 * 跨路由的历史助手消息
 *   content:            [reasoning, text, tool-call]   ─┐ 同位摘掉 reasoning
 *   replayState.blocks: [reasoning, text, tool-call]   ─┘ (两侧必须同步)
 *                      ↓
 *   content:            [text, tool-call]
 *   replayState.blocks: [text, tool-call]      ← dsh-llm-pi-ai 的等长校验仍然通过
 * ```
 *
 * **为什么必须两侧同步摘**:`dsh-llm-pi-ai` 的 `replayedAssistant` 有四条校验
 * (`lib/index.js:185`/`:186`/`:187`/`:192`),其中 `:187` 比的是 `replayState.blocks.length` 与
 * `message.content.length` **逐条等长**、`:192` 比逐条同型。只摘 `content` 一侧 ⇒ `:187` 抛
 * `INVALID_REPLAY_STATE` ⇒ `toPiAssistant`(`:240-252`)把**整条**降级成 `foreignAssistant`,
 * 而那条路径会把残留的 `reasoning` 原样映射成 `thinking`(`:154-158`)、并把 `api` 打成
 * `"dsh-foreign"` ⇒ pi-ai 的 `isSameModel` 必为假 ⇒ 思考**照样**被摊成正文。也就是说
 * **只摘一侧 = 缺陷② 原样复发 + 多一条 degrade 日志**。同位摘 k 项 ⇒ 两侧各减 k ⇒
 * 等长与逐条同型都仍然成立(推导见 FIX-A-DESIGN.md §2.5)。
 *
 * 代价是**有意的取舍**:跨路由的思考从此"看不见"了。现状是"看得见但被误导",改后是"看不见"。
 * 跨路由时思考的签名已经无效(`thoughtSignature` 跨模型即删),保真价值接近零;丢弃只损失
 * 一点上下文,污染会改掉整场会话的格式。这一层与 pi-ai 自己的先例同向:
 * `transform-messages.js:72-77` 对跨模型的 `redacted` 思考就是直接丢弃。
 *
 * 唯一现实的复发路径是上游把 `readReplayState` 加严、或把 `version` 升到 3:那时**同路由**的
 * 消息也会走 `foreignAssistant`,而我们"同路由 ⇒ 保留思考"的判断就成了帮凶。兜底做法是在
 * "保留"分支上加一个自证可用的前置检查(`version === 2 && blocks 与 content 同位同型`)。
 * **本次有意不加**(它把上游校验复制进插件,且现有用例里没有对应失败场景);设计与取舍见
 * FIX-A-DESIGN.md §3 风险① —— 日后升级 DSH/pi-ai 时,先跑该文档 §4.2 的用例 1/2/11 再决定。
 *
 * ## 修法③(0.5.1 起):路由切换通知
 *
 * `auto` 的切换是**静默**的;DSH 自带的那条 `[model changed: …]` 只在用户**手动换模型**时追加
 * (`@deepseek-ai/dsh-agent/lib/index.js:133-147` 的 `modelSwitchNotice`,由 `agent/pre-step`
 * 瀑布注入,且会落进会话记录)。静默切换下,模型在毫无提示的情况下看到一堆"内心独白式正文",
 * 更容易把坏格式学下去 ⇒ 本次请求**真的发生了切换**时,在出站消息序列末尾追加一条同款通知
 * (用户角色、逐字同款措辞与路由标签规则,见 `noticeText` / `routeLabel`)。
 *
 * 三条纪律:
 *  · **只改出站负载**:通知只加在交给嵌套调用的请求副本里,绝不写进会话记录(与修法②
 *    "只改出站、不改落盘"同一口径);会话记录由 DSH 自己的机制管;
 *  · **判定"真的发生了切换"**:本次候选路由 ≠ 上一条助手消息 `replayState.response` 记的路由。
 *    候选路由在 `adapter.js` 的链循环里定,`#nestedOptions(options, route)` 每次尝试都重算 ——
 *    每次尝试都从**原始** options 重新派生,只有真正成功那条的负载会被上游看到,所以
 *    "逐次尝试各自判定"与"链上第一个成功的路由 ≠ 上一条助手消息的路由"等价;
 *  · **不与自带通知重复**:历史里若已有一条 `source.kind === 'model-selection' &&
 *    source.form === 'notice'`、出现在**最后一条助手消息之后**(即它描述的就是我们要标注的
 *    那批回合)、措辞里的来源标签又正好等于本次的来源路由,就不再追加(见 `hasCoveringNotice`)。
 *
 * ## 为什么落点在插件里、而不是包一层 `LlmRuntime.forAdapter`
 *
 * 外层请求的适配器是**本插件的 AutoAdapter**(`options.provider === 'auto'`),
 * 所以外层 `forAdapter` 对 `source.provider === 'auto'` 的消息本来就是**原样保留** replay 的
 * (实测:`AutoAdapter.stream()` 收到的历史助手消息 `source` 键为
 * `['kind','provider','model','replayState']`)。
 * 剥掉 replay 的是**嵌套调用**那一次 `forAdapter`。若在 `forAdapter` 外面统一改写,
 * 外层那一次会变成「历史 provider 是 opencode-go、适配器却是 AutoAdapter」⇒ 反而把 replay 剥掉,
 * 修法失效。所以改写必须发生在**换 provider 的那一刻**,即 `adapter.js` 的 `#nestedOptions`。
 *
 * ## 纪律
 *
 * - **纯函数**:只读入参,返回新对象;绝不改入参(历史消息是深冻结对象);
 * - 只在**跨路由**时摘 `reasoning`、只在**真的切换**时追加通知;同路由的历史**一个字都不动**
 *   —— 那是唯一能让 pi-ai 带签名原样回放的路径(`transform-messages.js:80-81` 要求
 *   `isSameModel && thinkingSignature`),摘了等于把 2026-09-24 的收益还回去;
 * - 逐条取值:会话中途切换过路由时,各条历史消息的 replay 路由本就不同,不能统一成"当前路由";
 * - `replayState` 缺失 / 形状不对 / 与 source 本就一致 ⇒ **原样返回同一个对象**,不抛错;
 * - 只动 `role === 'assistant'` 的消息;`source.provider` 与 replay 路由不一致才改写;
 * - DeepSeek 原生信封没有 provider:按 model 判跨路由,但不伪造 source.provider;
 * - 目标路由 `keepThinking: true` 时不摘思考(DeepSeek thinking 模式要求工具循环完整回传);
 * - 目标路由 `breakToolLoop: true` 且历史里存在"带工具调用却没有思考块"的助手消息时,
 *   把出站消息序列从"以工具结果结尾"改成"以用户消息结尾",绕开同一条工具循环校验 ——
 *   这一回的思考不是被摘掉的、是从来没有,详见 {@link appendToolLoopBreak}。
 *
 * @module dsh-llm-auto/replay
 */

/**
 * `restoreMessageSource` 的第三种返回:这条消息整条从请求里去掉。
 * 用 Symbol 而不是 `undefined` / `null`,是为了和"原样返回入参"区分开(入参本身可能是 null)。
 */
const DROP_MESSAGE = Symbol('dsh-llm-auto/drop-message')

/**
 * 一条历史消息的**回放路由** —— 即 pi-ai 的 `isSameModel` 会拿去比的那组值。
 *
 * `model` 这一项要按 `dsh-llm-pi-ai` 的**重建规则**取值:`api === 'anthropic-messages'` 时
 * pi-ai 消息的 model 用的是 `responseModel`(`lib/index.js:218`)⇒ 即便 `provider` 与 `model`
 * 都和候选路由对上,重建出来的值不同也照样不算同一个模型。
 *
 * 注意这与写回 `source` 的值**不是一回事**:`source.model` 必须是 `response.model`
 * (pi-ai 的 `:186` 校验它),所以 {@link restoreMessageSource} 仍然读原始字段。
 *
 * @param response - `replayState.response`(形状任意)。
 * @returns `{ provider, model }`;provider/model 不是非空字符串时 undefined(无从判定)。
 */
function replayRouteOf(response) {
  if (response === null || typeof response !== 'object') return undefined
  const provider = typeof response.provider === 'string' && response.provider.length > 0 ? response.provider : undefined
  if (response.provider !== undefined && provider === undefined) return undefined
  const rebuilt = response.api === 'anthropic-messages'
    && typeof response.responseModel === 'string'
    && response.responseModel.length > 0
    ? response.responseModel
    : response.model
  if (typeof rebuilt !== 'string' || rebuilt.length === 0) return undefined
  return { provider, model: rebuilt }
}

/**
 * 一条消息的**回放身份**是不是就是本次候选路由 —— 即 pi-ai 的 `isSameModel` 会不会为真。
 *
 * pi-ai 的判据是 `provider + api + model` 三者全等(`transform-messages.js:68-70`),
 * 这里只比两个值,依据是:目录里同一个 provider+model 只有一条 api,
 * 所以"provider 与重建后的 model 都对上"⇒ 三个值必然都对上。
 *
 * @param response - `replayState.response`(已确认是对象)。
 * @param route - 本次候选路由(`{ provider, model }`)。
 * @returns 相同为 true(思考必须原样保留);不同为 false(思考必须摘掉)。
 */
function isSameModelRoute(response, route) {
  const replay = replayRouteOf(response)
  if (replay === undefined || replay.model !== route.model) return false
  return replay.provider === undefined || replay.provider === route.provider
}

/** content 里所有 `reasoning` 块的下标;没有就是空数组。 */
function reasoningIndexes(content) {
  if (!Array.isArray(content)) return []
  const indexes = []
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type === 'reasoning') indexes.push(index)
  }
  return indexes
}

/**
 * 把指定下标的块从 `content` 与 `replayState.blocks` 里**同位**摘掉。
 *
 * 对不齐时(信封缺 `blocks`、长度或类型已经错位)不留半截信封:`blocks` 返回 undefined
 * 表示"整个 replayState 不要了"。这与宿主自己的做法一致 —— `BlockAssembler` 在 blocks
 * 对不上时就是 `replay: undefined`(`@deepseek-ai/dsh-llm/lib/index.js:1060-1063`)。
 *
 * @param content - 助手消息的 content 数组(权威内容)。
 * @param blocks - `replayState.blocks`(形状任意)。
 * @param indexes - 要摘的下标。
 * @returns `{ content, blocks }`;`blocks === undefined` 表示整个信封丢弃。
 */
function stripReasoning(content, blocks, indexes) {
  const dropped = new Set(indexes)
  const kept = content.filter((_, index) => !dropped.has(index))
  const aligned = Array.isArray(blocks)
    && blocks.length === content.length
    && indexes.every((index) => blocks[index]?.type === 'reasoning')
  return {
    content: kept,
    blocks: aligned ? blocks.filter((_, index) => !dropped.has(index)) : undefined,
  }
}

/**
 * 按 replay 状态修正**一条**消息;不需要改时原样返回同一个引用。
 *
 * @param message - 一条请求消息(可能是深冻结的)。
 * @param route - 本次候选路由(`{ provider, model }`);不传 = 不摘思考,只改 source(旧行为)。
 * @param keepThinking - true 时保留跨路由思考。
 * @returns 改写后的新消息(浅冻结)、原消息,或 {@link DROP_MESSAGE}(整条去掉)。
 */
function restoreMessageSource(message, route, keepThinking = false) {
  if (message === null || typeof message !== 'object') return message
  if (message.role !== 'assistant') return message
  const source = message.source
  if (source === null || typeof source !== 'object') return message
  const replayState = source.replayState
  const response = replayState?.response
  if (response === null || typeof response !== 'object') return message
  const provider = response.provider
  const model = response.model
  // model 缺失时无从判断;provider 缺失的 DeepSeek 信封仍按 model 参与摘除判定。
  if (typeof model !== 'string' || model.length === 0) return message
  const validProvider = typeof provider === 'string' && provider.length > 0
  if (!validProvider && response.kind !== 'deepseek-messages') return message

  // 跨路由才摘思考;显式保留开关只由目标路由控制,默认仍照摘。
  const indexes = route !== undefined && keepThinking !== true && !isSameModelRoute(response, route)
    ? reasoningIndexes(message.content)
    : []
  const stripped = indexes.length === 0 ? undefined : stripReasoning(message.content, replayState.blocks, indexes)
  const sameSource = validProvider && provider === source.provider && model === source.model
  if (!validProvider && stripped === undefined) return message
  if (stripped === undefined && sameSource) return message
  // 摘空了(这条消息本来只有思考):整条去掉,不给上游一个空 content 的助手消息
  // (`dsh-llm-deepseek` 的序列化只跳过空 user 消息,空助手消息会原样发出去)。
  if (stripped !== undefined && stripped.content.length === 0) return DROP_MESSAGE
  return Object.freeze({
    ...message,
    ...(stripped === undefined ? {} : { content: Object.freeze(stripped.content) }),
    source: Object.freeze({
      ...source,
      ...(validProvider ? { provider } : {}),
      ...(validProvider ? { model } : {}),
      ...(stripped === undefined
        ? {}
        : stripped.blocks === undefined
          // 信封丢弃:下游 forAdapter(`dsh-llm/lib/index.js:2246`)与 toPiAssistant(`PI:242`)
          // 判的都是 `=== void 0`,键留着值为 undefined 与删掉等价。
          ? { replayState: undefined }
          : { replayState: Object.freeze({ ...replayState, blocks: Object.freeze(stripped.blocks) }) }),
    }),
  })
}

/**
 * 把请求里所有历史助手消息修正到它们 replay 状态记录的真实路由,并摘掉跨路由的思考。
 *
 * @param options - 交给 `ctx.llm.stream()` 的完整请求(`options.messages` 为历史)。
 * @param route - 本次候选路由;见 {@link restoreMessageSource}。
 * @returns 需要改写时是**新**的 options(新 messages 数组);否则原样返回同一个 options。
 */
export function restoreReplaySources(options, route, keepThinking = false) {
  if (options === null || typeof options !== 'object') return options
  const messages = options.messages
  if (!Array.isArray(messages)) return options
  /** 只有真的出现改写时才复制数组(常态是零拷贝:返回入参本身)。 */
  let rewritten
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const fixed = restoreMessageSource(message, route, keepThinking)
    if (fixed === message) continue
    rewritten ??= messages.slice()
    rewritten[index] = fixed
  }
  if (rewritten === undefined) return options
  return {
    ...options,
    messages: rewritten.includes(DROP_MESSAGE)
      ? rewritten.filter((message) => message !== DROP_MESSAGE)
      : rewritten,
  }
}

/**
 * 路由标签规则,逐字复刻自带通知的 `routeLabel`(`dsh-agent/lib/index.js:130-132`):
 * provider 相同就只写 model,未知 provider 也只写 model,否则写 `provider/model`。
 *
 * 两侧各按**对方**判一次(`routeLabel(旧, 新)` / `routeLabel(新, 旧)`),所以 provider 不同时
 * 两个标签都会带 provider 前缀。
 *
 * @param route - 要打标签的路由。
 * @param other - 用来判"provider 是否相同"的另一侧路由。
 * @returns 路由标签。
 */
function routeLabel(route, other) {
  return route.provider === undefined || other.provider === undefined || route.provider === other.provider ? route.model : `${route.provider}/${route.model}`
}

/**
 * 自带通知的措辞,逐字取自 `@deepseek-ai/dsh-agent/lib/index.js:139`。
 * @param from - 来源路由标签。
 * @param to - 目标路由标签。
 * @returns 通知正文。
 */
function noticeText(from, to) {
  return `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`
}

/**
 * 最后一条助手消息的**回放路由**与它的下标。
 *
 * 取不到可用的 `replayState.response` 时返回 `route: undefined` —— 此时**不发通知**:
 * 判断不出"上面那些回合是哪个模型生成的"就不能声称发生了切换(宁可不发,也不发一条每回合都
 * 出现的假通知)。这不是常态:会话里每条经 `auto` 产出的助手消息都带 replay 状态
 * (`dsh-llm-pi-ai` 的 `toPiReplayState` 与 `dsh-llm-deepseek` 的 `replayState()` 都是每次产出必写),
 * 而外层 `forAdapter` 对 `source.provider === 'auto'` 的消息本来就原样保留 replay。
 *
 * @param messages - 请求的历史消息。
 * @returns `{ index, route }`;没有助手消息时 undefined。
 */
function lastAssistantTurn(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'assistant') continue
    const source = message.source
    const response = source !== null && typeof source === 'object' ? source.replayState?.response : undefined
    return { index, route: replayRouteOf(response) }
  }
  return undefined
}

/** 这条消息的文本里有没有 `marker`(通知正文可能是字符串,也可能是 text 块数组)。 */
function textContains(message, marker) {
  const content = message.content
  if (typeof content === 'string') return content.includes(marker)
  if (!Array.isArray(content)) return false
  return content.some((block) => typeof block?.text === 'string' && block.text.includes(marker))
}

/**
 * 历史里是否已经有一条"覆盖本次切换"的自带通知。
 *
 * 自带通知(`dsh-agent/lib/index.js:133-147`)只在用户**手动换模型**时追加,且会落进会话记录;
 * 它同样以用户角色、同样措辞插在"它描述的那批回合"之后。所以只在两个条件**同时**成立时,
 * 才认定"这件事已经被说过一次了":
 *
 *  1. **位置**:它出现在**最后一条助手消息之后**。自带通知里的 "assistant turns above this
 *     point" 是位置相关的 —— 只有紧跟在我们要标注的那批回合之后,它说的才是同一批回合;
 *     更早的那条说的是更早的回合,不能拿它顶账。
 *  2. **来源**:它的措辞里 "generated by <来源标签>;" 这一段与本次要写的来源路由一致 ——
 *     即模型已经被明确告知"上面那些回合是 <来源> 生成的"。
 *
 * 只比这两条、不比目标标签:自带通知的目标写的是**选择**(`auto`),我们写的是**真实路由**,
 * 两者天然不同字;而"上面那些回合是别的模型生成的"这层意思,来源标签就是它的全部信息量。
 * 比前缀而不比整句,是为了对 `boundContextSummary` 的截断(自带那条的 `summary` 会被截到
 * 120 字符)保持稳健 —— 正文本身不截断,但只依赖前缀更不容易被上游改坏。
 *
 * @param messages - 请求的历史消息(自带通知不会被 `restoreReplaySources` 改动)。
 * @param from - 本次通知要写的来源标签。
 * @param lastAssistantIndex - 最后一条助手消息的下标。
 * @returns 已有覆盖本次切换的通知时 true(不再追加)。
 */
function hasCoveringNotice(messages, from, lastAssistantIndex) {
  const marker = `assistant turns above this point were generated by ${from};`
  for (let index = messages.length - 1; index > lastAssistantIndex; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const source = message.source
    if (source === null || typeof source !== 'object') continue
    if (source.kind !== 'model-selection' || source.form !== 'notice') continue
    if (textContains(message, marker)) return true
  }
  return false
}

/**
 * 通知消息本体:用户角色,与自带通知逐字同款的措辞与路由标签规则。
 *
 * `source` 也带同款标记(`kind: 'model-selection'` / `form: 'notice'`),这样
 * {@link hasCoveringNotice} 的扫描口径对"自带的那条"与"我们这条"是同一条 —— 它只存在于这份
 * **出站副本**里(不落盘),所以不会与自带通知互相干扰。
 * 不带 `id`:出站请求消息不需要稳定身份,省略也让出站负载可预测、可测
 * (自带那条由 `createUserMessage` 造,会带一个随机 uuid)。
 *
 * @param from - 来源路由标签。
 * @param to - 目标路由标签。
 * @returns 深冻结的用户消息。
 */
function noticeMessage(from, to) {
  return Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: noticeText(from, to) })]),
    source: Object.freeze({
      kind: 'model-selection',
      form: 'notice',
      summary: `${from} → ${to}`,
    }),
  })
}

/**
 * 本次请求真的发生了路由切换时,在出站消息序列**末尾**追加一条同款通知。
 *
 * 触发条件(三条全中):① 有历史助手消息,且它的 `replayState.response` 给出可用路由;
 * ② 本次候选路由与它不同(`provider` + 重建后的 `model`);③ 历史里没有已覆盖本次切换的通知。
 *
 * 追加在**末尾**而不是插在那批回合之后:通知的措辞是 "assistant turns above this point",
 * 放在末尾时"上面"正好包含全部历史回合,措辞仍然准确;而插进历史中间会让 `messages` 的下标
 * 与其它改写逻辑(以及宿主自己"内容块与 replay 块逐条同位"的不变式)纠缠。
 *
 * @param options - 交给 `ctx.llm.stream()` 的完整请求。
 * @param route - 本次候选路由(`{ provider, model }`);形状不对时原样返回(不知道候选路由就判不了切换)。
 * @returns 需要追加时是**新**的 options(新 messages 数组,末尾多一条通知);否则原样返回同一个 options。
 */
export function appendRouteSwitchNotice(options, route) {
  if (options === null || typeof options !== 'object') return options
  const provider = route?.provider
  const model = route?.model
  if (typeof provider !== 'string' || provider.length === 0) return options
  if (typeof model !== 'string' || model.length === 0) return options
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return options
  const turn = lastAssistantTurn(messages)
  if (turn === undefined || turn.route === undefined) return options
  const previous = turn.route
  const selected = { provider, model }
  if (previous.model === model && (previous.provider === undefined || previous.provider === provider)) return options
  const from = routeLabel(previous, selected)
  if (hasCoveringNotice(messages, from, turn.index)) return options
  return { ...options, messages: [...messages, noticeMessage(from, routeLabel(selected, previous))] }
}


/**
 * 工具循环收尾提示的措辞。
 *
 * 与自带通知同款:方括号、英文、只陈述事实。它要传达的只有一条 ——"上面那些回合的工具调用
 * 没有思考记录,请从上面的工具结果接着做",既不改任务,也不装作用户在提新要求。
 *
 * @returns 通知正文。
 */
function toolLoopBreakText() {
  return '[tool loop notice: some assistant turns above this point carry tool calls without reasoning content; continue from the tool results above]'
}

/**
 * 工具循环收尾提示本体:用户角色,`source` 用专属标记(`kind: 'tool-loop'`)。
 *
 * 为什么必须是用户角色:唯一能把请求从"以工具结果结尾"改成"以用户消息结尾"的合法角色就是
 * user(assistant 会再触发一次思考校验,tool 不改变结尾形态)。不带 `id`:它只存在于这份
 * **出站副本**里(不落盘),省略让出站负载可预测、可测。
 *
 * @returns 深冻结的用户消息。
 */
function toolLoopBreakMessage() {
  return Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: toolLoopBreakText() })]),
    source: Object.freeze({
      kind: 'tool-loop',
      form: 'notice',
      summary: 'tool loop without reasoning content',
    }),
  })
}

/**
 * 把"以工具结果结尾"的请求改成"以用户消息结尾",绕开 DeepSeek thinking 模式的工具循环校验。
 *
 * ## 缺陷③(2026-10-01 真机现场):历史缺思考 ⇒ 工具循环第二轮必 400
 *
 * DeepSeek 的 Messages API 在 thinking 模式下对**工具循环**有硬校验:请求以 `tool` 结果结尾时,
 * 历史里带工具调用的助手消息必须把思考一并回传,否则整条请求被拒:
 * `The content[].thinking in the thinking mode must be passed back to the API`
 * (现场:会话 671c8dfd 第 114 步,三条路由全败 ⇒ `AUTO_ROUTES_EXHAUSTED`)。
 *
 * 与缺陷②不同,这一回的思考**不是被摘掉的、是从来没有** —— 兜底到 DeepSeek 的会话里,历史多来自
 * 别的路由(现场是 opencode-go),那些回合的上游响应里本就没有 reasoning 分片,`keepThinking: true`
 * 无从保留。所以修法不能落在"摘不摘"上,只能落在**请求形态**上。
 *
 * ## 判据(三条全中才追加)
 *
 * 1. 目标路由声明了 `breakToolLoop: true` —— 显式开关,不猜 provider 语义;
 * 2. 出站消息**以工具结果结尾** —— 不处在这个形态就没有校验点;
 * 3. 历史里确实存在"带工具调用却没有思考块"的助手消息 —— 否则纯属打扰。
 *
 * ## 与路由切换通知的关系:互斥
 *
 * {@link appendRouteSwitchNotice} 同样追加在末尾、同样是用户角色。它先落地时末尾已经不是工具结果,
 * 本函数自然不追加 —— 这正好解释了现场"第 113 步侥幸成功、第 114 步才炸"的现象
 * (那一步的切换通知替它挡了一次)。
 *
 * @param options - 交给 `ctx.llm.stream()` 的完整请求。
 * @param route - 本次候选路由(`{ provider, model, breakToolLoop? }`);形状不对时原样返回。
 * @returns 需要追加时是**新**的 options(新 messages 数组,末尾多一条提示);否则原样返回同一个 options。
 */
export function appendToolLoopBreak(options, route) {
  if (options === null || typeof options !== 'object') return options
  if (route === null || typeof route !== 'object' || route.breakToolLoop !== true) return options
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return options
  const last = messages[messages.length - 1]
  if (last === null || typeof last !== 'object' || last.role !== 'tool') return options
  const broken = messages.some((message) => (
    message !== null
    && typeof message === 'object'
    && message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((block) => block?.type === 'tool-call')
    && !message.content.some((block) => block?.type === 'reasoning')
  ))
  if (!broken) return options
  return { ...options, messages: [...messages, toolLoopBreakMessage()] }
}
