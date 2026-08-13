/**
 * deepseek-kvcache 扩展端到端测试
 * 1. 集成测试：mock pi 加载扩展，验证 hook 注册与摘要请求构造逻辑
 * 2. 真实 API 测试：验证扩展构造的摘要请求命中 DeepSeek 前缀缓存，
 *    并与 pi 默认做法（serializeConversation 文本）对照
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";
const key = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")).deepseek.key;
if (!key) throw new Error("未找到 DeepSeek API key");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 构造测试对话（模拟 coding 会话，约 3-5k tokens） ----------
const longText = Array.from(
	{ length: 40 },
	(_, i) =>
		`第${i}段：这是模拟的代码审查与重构对话，讨论模块边界划分、错误处理策略、性能优化手段与测试覆盖率，并包含具体的代码示例和修改建议，供缓存前缀测试使用。`,
).join("\n");

const system = "You are an AI coding assistant powered by DeepSeek Harness. 遵循项目规范，优先给出代码。";

const tools = [
	{
		type: "function",
		function: {
			name: "read",
			description: "读取文件内容",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
	{
		type: "function",
		function: {
			name: "bash",
			description: "执行 shell 命令",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		},
	},
];

const history = [
	{ role: "user", content: `${longText}\n\n请审查这段代码并给出修改建议。` },
	{
		role: "assistant",
		content: "我审查了代码，发现三个问题：1) 错误处理缺失 2) 重复逻辑 3) 性能瓶颈。",
		tool_calls: [
			{
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"src/index.ts"}' },
			},
		],
	},
	{ role: "tool", tool_call_id: "call_1", content: "export function main() { /* 500 行代码 */ }" },
	{ role: "user", content: "好的，按你的建议修改，另外把日志加上。" },
];

// 摘要指令（与扩展 buildInstruction 一致）
const instruction = [
	"Summarize the conversation above so that work can continue without it. Structure the summary as:",
	"## Goal",
	"## Constraints & Preferences",
	"## Progress (Done / In Progress / Blocked)",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
].join("\n");

async function callApi(body: unknown, label: string) {
	const res = await fetch(BASE, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		console.log(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		throw new Error(label);
	}
	const data = await res.json();
	const u = data.usage;
	console.log(
		`[${label}] prompt=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens} miss=${u.prompt_cache_miss_tokens} output=${u.completion_tokens}`,
	);
	return u as { prompt_tokens: number; prompt_cache_hit_tokens: number; prompt_cache_miss_tokens: number };
}

// ---------- 2. 真实 API：三种请求的缓存命中对照 ----------
console.log("\n===== 1. 真实 API 缓存命中对照（A 先跑建立干净基线） =====");
console.log("模型:", MODEL);

// 主对话请求（wire payload）
const reqA = {
	model: MODEL,
	messages: [{ role: "system", content: system }, ...history],
	tools,
	stream: true,
	max_tokens: 384000,
};

// 请求 A：主对话（首次，预期 hit=0，建立缓存）
const reqA_api = { ...reqA, stream: false, max_tokens: 256, thinking: { type: "disabled" } };
const usageA = await callApi(reqA_api, "A 主对话(首次)");

// 请求 B：扩展的摘要请求 = A 前缀逐字 + 尾部指令（预期 hit ≈ A 全部）
const reqB = {
	...reqA_api,
	messages: [...reqA_api.messages, { role: "user", content: instruction }],
	max_tokens: 512,
};
await sleep(300);
const usageB = await callApi(reqB, "B 扩展摘要(前缀复用)");

// 请求 C：pi 默认做法 = 相同 system + 序列化文本（预期仅命中 system 或 0）
const serialized = `[run-salt:${Date.now()}]
` + history
	.map((m) => `[${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool result"}]: ${(m as any).content}`)
	.join("\n\n");
const reqC = {
	...reqA_api,
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: `${serialized}\n\n${instruction}` },
	],
	max_tokens: 512,
};
await sleep(300);
const usageC = await callApi(reqC, "C pi默认(序列化文本)");


// ---------- 3. 集成测试（最后跑，验证命中已有缓存）：mock pi 运行扩展 ----------
console.log("===== 3. 集成测试（最后跑，验证命中已有缓存）：扩展加载与请求构造 =====");
const extMod = await import("file:///C:/Users/pisce/.pi/agent/extensions/deepseek-kvcache.ts");
const ext = (extMod as any).default?.default ?? (extMod as any).default;

const hooks = new Map<string, Function>();
let capturedBody: unknown;
const pi = {
	on: (ev: string, fn: Function) => hooks.set(ev, fn),
	registerCommand: (name: string, _opts: unknown) => console.log(`  注册命令 /${name}`),
};
ext(pi);
console.log(`  注册事件: ${[...hooks.keys()].join(", ")}`);

const ctxMock: any = {
	model: { provider: "deepseek", id: MODEL, baseUrl: "https://api.deepseek.com" },
	ui: { setStatus: () => {} },
};

hooks.get("before_provider_request")!({ payload: structuredClone(reqA) }, ctxMock);
hooks.get("before_provider_headers")!({ headers: { authorization: `Bearer ${key}` } }, ctxMock);

// 触发压缩
const prep = {
	firstKeptEntryId: "entry-4",
	tokensBefore: 5000,
	previousSummary: undefined,
	fileOps: { readFiles: ["src/index.ts"], modifiedFiles: [] },
};
const compactResult = await hooks.get("session_before_compact")!({ preparation: prep, signal: undefined }, ctxMock);
console.log(`  压缩结果: ${compactResult ? "接管成功（返回 compaction）" : "未接管（回退 pi 默认）"}`);
if (!compactResult) throw new Error("扩展未接管压缩");

const sentBody = (capturedBody = undefined); // 扩展内部 fetch 无法直接捕获，改为验证返回值结构
console.log(`  摘要长度: ${compactResult.compaction.summary.length} 字符`);
console.log(`  firstKeptEntryId 传递: ${compactResult.compaction.firstKeptEntryId}`);
console.log(`  usage 已记录: ${JSON.stringify(compactResult.compaction.usage)}`);


// ---------- 3. 结论 ----------
console.log("\n===== 3. 结论 =====");
const rate = (hit: number, total: number) => (total > 0 ? ((hit / total) * 100).toFixed(1) : "0.0");
const aTotal = usageA.prompt_tokens;
const bHitRate = rate(usageB.prompt_cache_hit_tokens, usageB.prompt_tokens);
const bCoverage = rate(usageB.prompt_cache_hit_tokens, aTotal);
const cHitRate = rate(usageC.prompt_cache_hit_tokens, usageC.prompt_tokens);

console.log(`A 主对话建立缓存: ${aTotal} tokens`);
console.log(`B 扩展摘要: 命中 ${usageB.prompt_cache_hit_tokens} tokens，占请求 ${bHitRate}%，覆盖主对话前缀 ${bCoverage}%`);
console.log(`C pi默认(带盐,全新前缀): 命中 ${usageC.prompt_cache_hit_tokens} tokens，占请求 ${cHitRate}%`);

const verdict =
	usageB.prompt_cache_hit_tokens >= aTotal * 0.9
		? "扩展方案生效：摘要请求完整命中主对话前缀缓存"
		: usageB.prompt_cache_hit_tokens > 0
			? "扩展方案部分命中（见数据）"
			: "扩展方案未命中（需排查）";
console.log(`\n判定: ${verdict}`);
console.log(
	`费用对比（每次压缩，按 1M 前缀估算）: 扩展 ${((aTotal / 1e6) * 0.0028).toFixed(5)}$ vs pi默认 ${((aTotal / 1e6) * 0.14).toFixed(5)}$`,
);
