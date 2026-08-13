## Review

### Correct

- `deepseek-kvcache.ts:65-70`：仅缓存 DeepSeek 且包含完整 `messages/tools` 的请求，并通过 `structuredClone` 避免后续对象变更影响缓存。
- `deepseek-kvcache.ts:97-135`：HTTP 错误、JSON/响应格式错误、网络错误和 abort 都会返回 `undefined`，可回退 Pi 默认压缩。
- `deepseek-kvcache.ts:74-77`：只读取 Pi 提供的 Authorization header，没有日志输出密钥。
- `deepseek-kvcache.ts:204-212`：`prompt_tokens - prompt_cache_hit_tokens`、输出及总 token 的映射逻辑基本正确。
- `package.json:23-30`：`pi.extensions` 声明和 peer dependency 格式合理。

### Major

- `deepseek-kvcache.ts:81-95`：压缩 hook 没有检查当前模型是否仍是 DeepSeek，模型保护仅比较 `payload.model` 和 `ctx.model.id`。例如从 DeepSeek provider 切换到另一个 provider，但保持相同模型 ID 时，会把旧 DeepSeek payload 和 API key 发往新 endpoint；相同 provider/model ID 但切换 `baseUrl` 时也可能复用旧密钥。  
  **建议**：缓存 `provider`、`modelId`、`baseUrl` 和对应 Authorization，并在压缩前全部精确匹配；同时显式执行 `isDeepSeek(...)` 检查，并在 session 切换时清空缓存。

- `test/dskv-test.mts:136-167`：所谓集成测试没有验证扩展实际构造的请求。它导入的是硬编码的 `C:/Users/pisce/.pi/agent/extensions/deepseek-kvcache.ts`，不是当前仓库文件；`capturedBody` 从未被赋值，`sentBody` 始终是 `undefined`。请求 B 是测试手工构造的，不是扩展发出的请求。  
  **建议**：导入仓库相对路径，拦截/包装 `globalThis.fetch`，断言实际请求 body 的 `messages`、`tools`、`stream`、`max_tokens`、`thinking`、endpoint 和 Authorization。

- `test/dskv-test.mts:104-132,175-188`：三方比较并未执行 Pi 的真实 `serializeConversation`；C 只保留各消息的 `content`，还人为加入 `[run-salt]`，不一定等价于 Pi 默认压缩格式。A 使用固定 payload，也无法保证是“首次”请求，可能命中之前运行留下的服务端缓存。最终仅打印判定，不断言 B 命中率或 C 的对照结果。  
  **建议**：调用实际 Pi 序列化逻辑；为每次测试生成唯一但在 A/B 间一致的 payload；对 A/B/C 的预期关系使用断言，而不是仅输出日志。

### Minor

- `deepseek-kvcache.ts:70,86-95`：`structuredClone`、`buildInstruction`、`baseUrl.replace` 和 payload 构造位于 `try` 外。异常 payload、非字符串 `baseUrl` 或异常 preparation 会使 hook reject，违背“任何失败静默回退”。  
  **建议**：将整个压缩 payload 构造和 endpoint 计算纳入 `try/catch`。

- `deepseek-kvcache.ts:204-212`：压缩 usage 的 `cost` 始终为零。token 字段基本正确，但会导致 Pi 的费用统计低报。  
  **建议**：按当前 DeepSeek 价格填充 cost，或在 README 中明确说明扩展压缩请求的费用统计不可用。

- `test/dskv-test.mts:13` 与 `README.md:49`：README 声称支持 `DEEPSEEK_API_KEY`，测试实际只读取 `~/.pi/agent/auth.json`；同时测试导入路径是机器相关的绝对 Windows 路径。  
  **建议**：实现环境变量 fallback，并改用仓库相对路径。

- `package.json:32`：`npm test` 直接执行真实 API、依赖本机密钥和网络，作为默认测试命令不可重复且可能产生费用。  
  **建议**：将真实 API 测试拆为显式 e2e 命令，默认 `test` 使用 mock 测试。

### Nit

- `test/dskv-test.mts:141,167` 的 `capturedBody/sentBody` 是无效死代码，应删除或改为真正的 fetch 捕获逻辑。

## 总体结论

**approve-with-changes**。核心缓存与失败回退路径设计合理，但模型/provider/baseUrl 隔离和测试有效性必须修正后再发布。