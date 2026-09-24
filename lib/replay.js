/**
 * dsh-llm-auto —— 历史助手消息的「回放归属修正」(纯函数,不改 content)。
 *
 * ## 要修的缺陷(2026-09-24 字节级实测)
 *
 * 经 `auto` 的会话在**回放历史**时,模型自己每一轮的思考会被当成普通正文发给上游,
 * 且思考通道被填成空串;直连同一路由(`opencode-go`)则两个通道严格分离。链路五环:
 *
 * 1. `dsh-agent-loop` 把**当次请求的 provider** 写进 `source.provider`
 *    (`...\dsh-agent-loop\lib\index.js:1121`)⇒ 经 `auto` 产出的每一轮历史里都写着 `auto`,
 *    而它携带的 `replayState` 其实是**嵌套路由的适配器**(如 pi-ai)写下的。
 * 2. `LlmRuntime.forAdapter`(`...\dsh-llm\lib\index.js:2151-2172`)的规则是
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
 * ## 修法:把 source 改回它 replay 状态里记着的真实路由
 *
 * 在把请求交给嵌套调用**之前**,把每条历史助手消息的 `source.provider` / `source.model`
 * 换成 `source.replayState.response.provider` / `.model`(嵌套适配器当初真正用的那组值)。
 * 于是环 ② 的判定成立(历史 provider 的适配器就是嵌套适配器)⇒ replay 状态保留 ⇒
 * pi-ai 走 `replayedAssistant`(它正好校验 `response.provider === source.provider`
 * 且 `response.model === source.model`,改写后逐字通过)⇒ 思考回 `reasoning_content`、
 * 正文回 `content`。
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
 * - **纯函数**:只读入参,返回新对象;绝不改 `content`、绝不改入参(历史消息是深冻结对象);
 * - 逐条取值:会话中途切换过路由时,各条历史消息的 replay 路由本就不同,不能统一成"当前路由";
 * - `replayState` 缺失 / 形状不对 / 与 source 本就一致 ⇒ **原样返回同一个对象**,不抛错;
 * - 只动 `role === 'assistant'` 的消息;`source.provider` 与 replay 路由不一致才改写。
 *
 * @module dsh-llm-auto/replay
 */

/**
 * 按 replay 状态修正**一条**消息的 source;不需要改时原样返回同一个引用。
 *
 * @param message - 一条请求消息(可能是深冻结的)。
 * @returns 改写后的新消息(浅冻结),或原消息。
 */
function restoreMessageSource(message) {
  if (message === null || typeof message !== 'object') return message
  if (message.role !== 'assistant') return message
  const source = message.source
  if (source === null || typeof source !== 'object') return message
  const response = source.replayState?.response
  if (response === null || typeof response !== 'object') return message
  const provider = response.provider
  const model = response.model
  // 形状不对就放行:改写只认"非空字符串"的路由值,其余交给下游适配器自己校验/降级。
  if (typeof provider !== 'string' || provider.length === 0) return message
  if (typeof model !== 'string' || model.length === 0) return message
  if (provider === source.provider && model === source.model) return message
  // 消息与 source 一律浅拷贝重建(两者都是深冻结对象,不能就地改);content 等其余字段原样带过去。
  // 浅冻结足够:其余字段(含 content / replayState)本来就来自深冻结的原消息。
  return Object.freeze({
    ...message,
    source: Object.freeze({ ...source, provider, model }),
  })
}

/**
 * 把请求里所有历史助手消息的 source 修正到它们 replay 状态记录的真实路由。
 *
 * @param options - 交给 `ctx.llm.stream()` 的完整请求(`options.messages` 为历史)。
 * @returns 需要改写时是**新**的 options(新 messages 数组);否则原样返回同一个 options。
 */
export function restoreReplaySources(options) {
  if (options === null || typeof options !== 'object') return options
  const messages = options.messages
  if (!Array.isArray(messages)) return options
  /** 只有真的出现改写时才复制数组(常态是零拷贝:返回入参本身)。 */
  let rewritten
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const fixed = restoreMessageSource(message)
    if (fixed === message) continue
    rewritten ??= messages.slice()
    rewritten[index] = fixed
  }
  return rewritten === undefined ? options : { ...options, messages: rewritten }
}
