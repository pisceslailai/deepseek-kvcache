/**
 * deepseek-kvcache 回归测试
 *
 * 默认：纯 mock，不需要 DeepSeek API key。
 * - 精确验证 compaction 只发送 Pi 准备摘要的区间，不包含 kept recent messages
 * - 验证 wire 边界无法安全对齐时回退 Pi 默认 compaction
 *
 * 可选真实 API：
 *   RUN_LIVE=1 DEEPSEEK_API_KEY=... npm test
 */
import assert from "node:assert/strict";
import deepseekKvCache from "../deepseek-kvcache.ts";

const MODEL = "deepseek-v4-flash";
const BASE_URL = "https://api.deepseek.com";

const tools = [
	{
		type: "function",
		function: {
			name: "read",
			description: "读取文件内容",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
];

function makeHarness() {
	const hooks = new Map<string, Function>();
	let commandHandler: Function | undefined;
	const pi = {
		on: (event: string, fn: Function) => hooks.set(event, fn),
		registerCommand: (_name: string, options: { handler: Function }) => {
			commandHandler = options.handler;
		},
	};
	deepseekKvCache(pi as any);
	return { hooks, getCommandHandler: () => commandHandler };
}

const ctxMock: any = {
	model: { provider: "deepseek", id: MODEL, baseUrl: BASE_URL },
	ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
};

async function testExactCompactionRange() {
	console.log("===== 回归测试：只摘要 Pi 指定区间 =====");
	const { hooks } = makeHarness();

	const wireMessages = [
		{ role: "system", content: "You are a coding assistant." },
		{ role: "user", content: "old user 1" },
		{ role: "assistant", content: "old assistant 1" },
		{ role: "tool", tool_call_id: "call-1", content: "old tool result" },
		{ role: "user", content: "split-turn prefix" },
		{ role: "assistant", content: "RECENT ASSISTANT - MUST BE KEPT" },
		{ role: "user", content: "RECENT USER - MUST BE KEPT" },
	];
	const mainPayload = {
		model: MODEL,
		messages: wireMessages,
		tools,
		stream: true,
		max_tokens: 4096,
	};

	hooks.get("before_provider_request")!({ payload: structuredClone(mainPayload) }, ctxMock);
	hooks.get("before_provider_headers")!({ headers: { authorization: "Bearer test-key" } }, ctxMock);

	const preparation = {
		messagesToSummarize: [
			{ role: "user", content: [{ type: "text", text: "old user 1" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "old assistant 1" }],
				provider: "deepseek",
				api: "openai-completions",
				model: MODEL,
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "old tool result" }],
				isError: false,
				timestamp: 3,
			},
		],
		turnPrefixMessages: [
			{ role: "user", content: [{ type: "text", text: "split-turn prefix" }], timestamp: 4 },
		],
		isSplitTurn: true,
		firstKeptEntryId: "entry-recent-assistant",
		tokensBefore: 120000,
		previousSummary: "Earlier compacted context.",
		fileOps: { readFiles: ["src/index.ts"], modifiedFiles: [] },
	};

	const originalFetch = globalThis.fetch;
	let capturedBody: any;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		capturedBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: "## Goal\nContinue the work." } }],
				usage: {
					prompt_tokens: 1100,
					completion_tokens: 50,
					prompt_cache_hit_tokens: 1000,
					prompt_cache_miss_tokens: 100,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;

	try {
		const result = await hooks.get("session_before_compact")!({ preparation, signal: undefined }, ctxMock);
		assert.ok(result?.compaction, "扩展应成功接管 compaction");
		assert.equal(result.compaction.firstKeptEntryId, preparation.firstKeptEntryId);

		// system + 4 个待摘要 conversation messages + 1 个尾部摘要指令
		assert.equal(capturedBody.messages.length, 6);
		assert.deepEqual(capturedBody.messages.slice(0, 5), wireMessages.slice(0, 5));
		assert.equal(capturedBody.messages.at(-1).role, "user");
		assert.match(capturedBody.messages.at(-1).content, /compaction boundary/i);

		const serialized = JSON.stringify(capturedBody.messages);
		assert.ok(!serialized.includes("RECENT ASSISTANT - MUST BE KEPT"));
		assert.ok(!serialized.includes("RECENT USER - MUST BE KEPT"));
		console.log("PASS: kept recent messages 未进入摘要请求，wire 前缀保持原样。\n");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function testUnsafeBoundaryFallsBack() {
	console.log("===== 回归测试：边界不安全时回退 =====");
	const { hooks } = makeHarness();
	const mainPayload = {
		model: MODEL,
		messages: [
			{ role: "system", content: "system" },
			{ role: "user", content: "only cached message" },
			{ role: "assistant", content: "cached assistant" },
		],
		tools,
	};
	// before_provider_request 至少要求 3 条消息，这里满足。
	hooks.get("before_provider_request")!({ payload: structuredClone(mainPayload) }, ctxMock);
	hooks.get("before_provider_headers")!({ headers: { authorization: "Bearer test-key" } }, ctxMock);

	const preparation = {
		messagesToSummarize: [
			{ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "three" }], timestamp: 3 },
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		firstKeptEntryId: "entry-x",
		tokensBefore: 100,
		fileOps: { readFiles: [], modifiedFiles: [] },
	};

	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = (async () => {
		fetchCalled = true;
		throw new Error("不应调用 fetch");
	}) as typeof fetch;
	try {
		const result = await hooks.get("session_before_compact")!({ preparation, signal: undefined }, ctxMock);
		assert.equal(result, undefined);
		assert.equal(fetchCalled, false);
		console.log("PASS: 缓存快照不足以覆盖摘要范围时安全回退 Pi 默认 compaction。\n");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function runLiveCacheCheck() {
	if (process.env.RUN_LIVE !== "1") return;
	const key = process.env.DEEPSEEK_API_KEY;
	if (!key) throw new Error("RUN_LIVE=1 时必须设置 DEEPSEEK_API_KEY");

	console.log("===== 可选真实 API：前缀缓存命中 =====");
	const longText = Array.from(
		{ length: 60 },
		(_, i) => `第${i}段：模拟 coding agent 长上下文，用于 DeepSeek KV Cache 前缀复用测试。`,
	).join("\n");
	const prefixMessages = [
		{ role: "system", content: "You are a coding assistant." },
		{ role: "user", content: longText },
		{ role: "assistant", content: "已分析代码结构并记录关键修改点。" },
		{ role: "user", content: "继续处理测试。" },
	];
	const base = {
		model: MODEL,
		messages: prefixMessages,
		tools,
		stream: false,
		max_tokens: 128,
		thinking: { type: "disabled" },
	};

	async function call(body: unknown) {
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
		});
		assert.equal(res.ok, true, `DeepSeek HTTP ${res.status}`);
		return (await res.json()) as any;
	}

	const first = await call(base);
	const second = await call({
		...base,
		messages: [...prefixMessages, { role: "user", content: "Summarize only the conversation above." }],
		max_tokens: 256,
	});
	const hit = second.usage?.prompt_cache_hit_tokens ?? 0;
	const total = second.usage?.prompt_tokens ?? 0;
	console.log(`首次 prompt=${first.usage?.prompt_tokens ?? 0}`);
	console.log(`摘要请求 prompt=${total}, cache hit=${hit}, hit rate=${total ? ((hit / total) * 100).toFixed(1) : "0.0"}%`);
	assert.ok(hit > 0, "真实 API 摘要请求应至少命中部分前缀缓存");
}

await testExactCompactionRange();
await testUnsafeBoundaryFallsBack();
await runLiveCacheCheck();
console.log("全部测试通过。");
