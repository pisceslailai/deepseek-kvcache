# deepseek-kvcache

DeepSeek KV Cache 优化扩展（Pi coding agent）。

pi 的压缩（compaction）默认把旧消息序列化成 `[User]: ...` 文本再请求摘要——格式与主对话的 wire 消息不同，DeepSeek 自动前缀缓存必然 miss，每次压缩都按全价付输入费。本扩展复刻 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 compaction-basic 策略：**摘要请求 = 主对话前缀（逐字不变）+ 尾部追加摘要指令**，公共前缀整体命中 DeepSeek 自动缓存（命中价约为全价 1/50）。

实测（deepseek-v4-flash，真实 API 三方对照）：

| 请求 | 命中率 |
|---|---|
| 主对话（建立缓存） | 98.4% |
| 扩展摘要（前缀复用） | 96.3% |
| pi 默认（序列化文本） | 11.5%（仅 system 部分） |

## 功能

- `before_provider_request`：缓存主对话请求的完整 wire payload（system + messages + tools 逐字保留）
- `session_before_compact`：接管压缩——摘要请求 = 主对话前缀 + 尾部指令，`stream: false`、`max_tokens: 8192`、`thinking: disabled`
- `/dshkv`：缓存命中统计（主对话命中率、压缩前缀复用命中率、累计节省金额）
- 状态显示：`dshkv ↑输入 R缓存命中 命中率 | cmp 压缩命中率`，随每次请求实时更新。同时写 footer 状态行（`setStatus`）和编辑器下方 widget（`setWidget`，与 footer 组件解耦，任何主题/自定义 footer 下都可见）
- 仅对 DeepSeek 路由生效（`provider === "deepseek"` 或模型 id 含 `deepseek`）；自定义网关自动使用 `ctx.model.baseUrl`
- 任何失败静默回退 pi 默认压缩，不影响功能

## 安装

```sh
# 方式一：git 包（推荐，settings.json 的 packages 数组加入）
git:github.com/pisceslailai/deepseek-kvcache
```

```sh
# 方式二：本地路径（settings.json 的 extensions 数组加入）
C:/Users/pisce/.pi/agent/extensions/deepseek-kvcache.ts
```

```sh
# 方式三：命令行加载
pi --extension ~/.pi/agent/extensions/deepseek-kvcache.ts
```

加载后 `/reload` 热重载生效。

## 使用

- 正常使用 pi + DeepSeek 即可，扩展自动工作
- `/dshkv` 查看命中统计；真实会话触发压缩后，重点观察"压缩：N 次前缀复用，命中 X%"应接近 100%

## 测试

需要可用的 DeepSeek API key（读取 `~/.pi/agent/auth.json` 的 `deepseek` 条目或 `DEEPSEEK_API_KEY` 环境变量）：

```sh
node --import tsx test/dskv-test.mts
```

测试内容：mock pi 加载扩展验证 hook 注册与请求构造 + 真实 API 三方对照（主对话 / 扩展摘要 / pi 默认序列化）。

## 设计说明

- 摘要请求**全量带消息**而非截断：公共前缀 = 整个主对话，命中率最大化；多带的 kept 消息按缓存命中价计费，几乎免费
- 模型切换保护：`lastPayload.model !== ctx.model?.id` 时丢弃缓存
- 工具 schema 原样带上（`...lastPayload`），前缀才逐字一致
- `thinking: disabled` 位于 body 尾部，不影响 messages 前缀命中

## License

MIT
