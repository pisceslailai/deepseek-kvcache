# deepseek-kvcache

DeepSeek KV Cache 优化扩展（Pi coding agent）。

Pi 的 compaction 默认会把旧消息重新序列化后再请求摘要，格式与正常主对话的 wire messages 不同，因此很难复用 DeepSeek 已经建立的自动前缀缓存。本扩展改为复用主对话已经发送过的 wire prefix，在末尾追加摘要指令，使 compaction 的大部分输入可以继续命中 DeepSeek prefix cache。

更重要的是，扩展现在严格遵循 Pi 自己计算出的 compaction 边界：只摘要 `messagesToSummarize + turnPrefixMessages`，不会把 `firstKeptEntryId` 之后仍会原样保留的 recent context 再摘要一遍。

## 核心行为

- `before_provider_request`：缓存 DeepSeek 主对话请求的完整 wire payload（system/messages/tools 等保持原样）。
- `session_before_compact`：读取 Pi 的 `preparation.messagesToSummarize` 和 `turnPrefixMessages`，通过官方 `convertToLlm()` 计算实际需要摘要的 LLM message 数量。
- 对齐校验：同时检查 provider/model/baseUrl 和消息 role 序列。只有 Pi 的待摘要区间能与缓存 wire prefix 安全对齐时才接管 compaction。
- 精确回放：摘要请求只包含 `system/developer + 待摘要消息`，随后追加摘要指令；recent kept messages 不进入摘要请求。
- 安全回退：如果上一次 provider request 尚未包含完整待摘要区域，或者 wire role 映射无法确认，扩展直接返回，让 Pi 使用默认 compaction。正确性优先于缓存命中率。
- split turn：支持 Pi 的 `turnPrefixMessages`；摘要指令会明确说明边界位于超长 turn 内，保留 suffix 会在摘要后继续存在。
- `/dshkv`：显示主对话和 compaction 的 cache hit/miss token 统计；不再硬编码美元节省金额，因为模型价格会变化。
- 状态显示：`dshkv ↑输入 R缓存命中 命中率 | cmp 压缩命中率`，同步写入 footer status 和编辑器下方 widget。
- 仅对 DeepSeek 路由生效（`provider === "deepseek"` 或模型 id 含 `deepseek`）；自定义兼容端点使用 `ctx.model.baseUrl`。

## 为什么不能直接摘要整段主对话

Pi compaction 的正常结构类似：

```text
旧消息 A B C D E F | recent G H I J
        ↓ summarize       ↓ keep verbatim
summary(A..F)       +     G H I J
```

如果为了最大化 cache hit，直接把 A..J 全部发送给摘要模型，最后会变成：

```text
summary(A..J) + G H I J
```

这样 recent context 被表达两次，summary 与原文还可能产生细微冲突。本扩展现在只回放 A..F 对应的原始 wire prefix，因此既保留缓存复用，又保持 Pi compaction 的语义边界。

## 安装

### 方式一：git 包

```sh
git:github.com/pisceslailai/deepseek-kvcache
```

加入 Pi `settings.json` 的 `packages` 数组。

### 方式二：本地 extension

```sh
~/.pi/agent/extensions/deepseek-kvcache.ts
```

加入 `settings.json` 的 `extensions` 数组，或：

```sh
pi --extension ~/.pi/agent/extensions/deepseek-kvcache.ts
```

加载后可使用 `/reload` 热重载。

## 使用

正常使用 Pi + DeepSeek 即可，扩展自动工作。

运行：

```text
/dshkv
```

可以查看：

- 主对话请求数、总输入、cache read tokens、命中率；
- compaction 前缀复用次数、cache hit rate、未命中 token、fallback 次数。

出现 fallback 不一定是错误。如果最新 provider snapshot 无法完整覆盖 Pi 当前准备压缩的消息，回退默认 compaction 是预期的安全行为。

## 测试

默认测试不需要 DeepSeek API key：

```sh
npm test
```

覆盖：

1. compaction 请求只包含 Pi 指定的待摘要区间；
2. `firstKeptEntryId` 后的 recent messages 不会进入 summary request；
3. system + wire conversation prefix 保持原样；
4. 缓存快照不足或无法安全对齐时不发额外 API 请求，直接回退 Pi 默认 compaction。

可选运行真实 DeepSeek API prefix-cache 检查：

```sh
RUN_LIVE=1 DEEPSEEK_API_KEY=your_key npm test
```

真实 API 测试只要求摘要请求至少出现 cache hit；实际命中比例取决于模型、缓存状态和 DeepSeek 服务端策略。

## 设计说明

### 为什么继续复用 wire payload

DeepSeek prefix cache 要求请求前缀一致。Pi 默认 compaction 会重新序列化会话，因此即使语义相同，token 前缀也会变化。直接复用上一次主对话的 wire messages 可以保持已缓存部分逐字一致。

### 如何确定正确的结束位置

扩展不再使用“整个 `cache.payload.messages`”。它将：

1. 合并 `preparation.messagesToSummarize` 与 `turnPrefixMessages`；
2. 使用 Pi 官方 `convertToLlm()` 处理 custom/bash/compaction summary 等消息并过滤 `excludeFromContext`；
3. 计算对应 conversation message 数量；
4. 将 `toolResult` 映射为 DeepSeek wire role `tool`，逐项验证角色序列；
5. 只截取验证通过的 wire prefix。

如果任何一步无法证明边界安全，则不接管 compaction。

### thinking

当前摘要请求使用 `thinking: disabled`，目的是避免为结构化 compaction summary 额外生成推理内容。Prefix cache 的核心复用对象仍是此前相同的消息前缀。建议在模型或 DeepSeek API 行为发生变化时，通过可选 live test 重新验证命中情况。

## License

MIT
