/**
 * DeepSeek KV Cache 优化扩展
 *
 * 针对 DeepSeek 自动前缀缓存的工程优化：
 *
 * 1. before_provider_request 缓存主对话请求的完整 wire payload
 *    （system + messages + tools 逐字保留）
 * 2. session_before_compact 根据 Pi preparation.messagesToSummarize /
 *    turnPrefixMessages 精确计算需要摘要的消息范围，只回放该 wire 前缀并追加摘要指令
 * 3. 边界无法与 wire payload 安全对齐时，直接回退 Pi 默认 compaction，正确性优先
 * 4. /dshkv 命令查看缓存命中统计
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

interface WireMessage {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

interface WirePayload {
	model?: unknown;
	messages?: WireMessage[];
	tools?: unknown[];
	[key: string]: unknown;
}

interface DeepSeekUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const SUMMARY_MAX_TOKENS = 8192;

export default function deepseekKvCache(pi: ExtensionAPI) {
	const isDeepSeek = (provider?: string, modelId?: string): boolean =>
		provider === "deepseek" || /deepseek/i.test(modelId ?? "");

	let cache:
		| {
				payload: WirePayload;
				provider?: string;
				modelId?: string;
				baseUrl?: string;
				authHeader?: string;
			}
		| undefined;
	let authHeader: string | undefined;

	const stats = {
		requests: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		compactRequests: 0,
		compactCacheRead: 0,
		compactInput: 0,
		fallbacks: 0,
	};

	/** 渲染状态：footer 状态行 + 编辑器下方 widget。 */
	const renderStatus = (ctx: {
		ui?: {
			setStatus?(key: string, text: string | undefined): void;
			setWidget?(key: string, content: string[] | undefined, options?: { placement?: string }): void;
		};
	}): void => {
		const total = stats.inputTokens + stats.cacheReadTokens;
		const hitRate = total > 0 ? `${((stats.cacheReadTokens / total) * 100).toFixed(1)}%` : "-";
		const parts = [`↑${fmtT(stats.inputTokens)}`, `R${fmtT(stats.cacheReadTokens)}`, hitRate];
		if (stats.compactRequests > 0) {
			const cTotal = stats.compactInput + stats.compactCacheRead;
			const cRate = cTotal > 0 ? `${((stats.compactCacheRead / cTotal) * 100).toFixed(1)}%` : "-";
			parts.push(`| cmp ${cRate}`);
		}
		const text = `dshkv ${parts.join(" ")}`;
		ctx.ui?.setStatus?.("dshkv", text);
		ctx.ui?.setWidget?.("dshkv", [text], { placement: "belowEditor" });
	};

	// 1. 缓存主对话请求 wire payload，并绑定 provider/model/baseUrl/key。
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		const payload = event.payload as WirePayload | undefined;
		if (!payload || !Array.isArray(payload.messages) || payload.messages.length < 3) return;
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) return;
		cache = {
			payload: structuredClone(payload),
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			baseUrl: ctx.model?.baseUrl,
			authHeader,
		};
	});

	// 2. 缓存 Authorization 头；若已有快照但缺密钥则补上。
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		const auth = event.headers.authorization ?? event.headers["Authorization"];
		if (typeof auth === "string" && auth.length > 0) {
			authHeader = auth;
			if (cache && !cache.authHeader) cache.authHeader = auth;
		}
	});

	// 3. 压缩：只回放 Pi 真正准备丢弃的消息范围，再追加摘要指令。
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		if (!cache?.payload?.messages?.length || !cache.authHeader) return;
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		if (
			cache.provider !== ctx.model?.provider ||
			cache.modelId !== ctx.model?.id ||
			cache.baseUrl !== ctx.model?.baseUrl
		) {
			return;
		}

		const messagesToSummarize = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const llmMessagesToSummarize = convertToLlm(messagesToSummarize);
		if (llmMessagesToSummarize.length === 0) return;

		const cachedMessages = cache.payload.messages;
		const leadingContextCount = countLeadingContextMessages(cachedMessages);
		const prefixEnd = leadingContextCount + llmMessagesToSummarize.length;

		// last provider request 可能尚未包含最新 assistant 输出。此时宁可回退默认压缩，
		// 也不能生成缺失内容的摘要。
		if (prefixEnd > cachedMessages.length) {
			stats.fallbacks++;
			return;
		}

		const wireConversationPrefix = cachedMessages.slice(leadingContextCount, prefixEnd);
		if (!rolesMatch(llmMessagesToSummarize, wireConversationPrefix)) {
			stats.fallbacks++;
			return;
		}

		const compactPrefix = cachedMessages.slice(0, prefixEnd);
		const payload: WirePayload = {
			...cache.payload,
			messages: [...compactPrefix, { role: "user", content: buildInstruction(preparation) }],
			stream: false,
			max_tokens: SUMMARY_MAX_TOKENS,
			thinking: { type: "disabled" },
		};

		const baseUrl = (ctx.model?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		try {
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: cache.authHeader },
				body: JSON.stringify(payload),
				signal,
			});
			if (!res.ok) {
				stats.fallbacks++;
				return;
			}
			const data = (await res.json()) as {
				choices?: Array<{ message?: { content?: unknown } }>;
				usage?: DeepSeekUsage;
			};
			const summary = data.choices?.[0]?.message?.content;
			if (typeof summary !== "string" || summary.trim().length === 0) {
				stats.fallbacks++;
				return;
			}

			const usage = data.usage;
			const cacheRead = usage?.prompt_cache_hit_tokens ?? 0;
			const input = (usage?.prompt_tokens ?? 0) - cacheRead;
			stats.compactRequests++;
			stats.compactCacheRead += cacheRead;
			stats.compactInput += Math.max(0, input);
			renderStatus(ctx);

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: toPiUsage(usage),
				},
			};
		} catch {
			stats.fallbacks++;
			return;
		}
	});

	// 4. 统计主对话请求缓存命中。
	pi.on("message_end", (event, ctx) => {
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		const usage = event.message?.usage;
		if (!usage) return;
		stats.requests++;
		stats.inputTokens += usage.input ?? 0;
		stats.cacheReadTokens += usage.cacheRead ?? 0;
		renderStatus(ctx);
	});

	// 5. /dshkv 查看命中统计。费用随模型/时期变化，不再硬编码估算金额。
	pi.registerCommand("dshkv", {
		description: "DeepSeek KV Cache 命中统计",
		handler: async (_args, ctx) => {
			const total = stats.inputTokens + stats.cacheReadTokens;
			const hitRate = total > 0 ? ((stats.cacheReadTokens / total) * 100).toFixed(1) : "0.0";
			const cTotal = stats.compactInput + stats.compactCacheRead;
			const cRate = cTotal > 0 ? ((stats.compactCacheRead / cTotal) * 100).toFixed(1) : "0.0";
			ctx.ui.notify(
				[
					`主对话：${stats.requests} 次请求，输入 ${fmt(total)} tokens，缓存命中 ${fmt(stats.cacheReadTokens)} (${hitRate}%)`,
					`压缩：${stats.compactRequests} 次前缀复用，命中 ${fmt(stats.compactCacheRead)} (${cRate}%)，未命中 ${fmt(stats.compactInput)} tokens，回退 ${stats.fallbacks} 次`,
				].join("\n"),
				"info",
			);
		},
	});
}

function countLeadingContextMessages(messages: WireMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "system" && message.role !== "developer") break;
		count++;
	}
	return count;
}

function rolesMatch(llmMessages: Array<{ role: string }>, wireMessages: WireMessage[]): boolean {
	if (llmMessages.length !== wireMessages.length) return false;
	return llmMessages.every((message, index) => normalizeLlmRole(message.role) === wireMessages[index]?.role);
}

function normalizeLlmRole(role: string): string {
	return role === "toolResult" ? "tool" : role;
}

function buildInstruction(preparation: {
	previousSummary?: string;
	isSplitTurn?: boolean;
	fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
}): string {
	const { previousSummary, fileOps, isSplitTurn } = preparation;
	const readFiles = fileOps?.readFiles ?? [];
	const modifiedFiles = fileOps?.modifiedFiles ?? [];
	const parts = [
		"Summarize only the conversation messages above. They end exactly at Pi's compaction boundary; newer messages are retained verbatim and are intentionally not included in this request.",
		"Create a continuation-ready summary with:",
		"## Goal",
		"## Constraints & Preferences",
		"## Progress (Done / In Progress / Blocked)",
		"## Key Decisions",
		"## Next Steps",
		"## Critical Context",
	];
	if (isSplitTurn) {
		parts.push(
			"The boundary is inside an oversized turn. Capture the in-progress turn prefix precisely so the retained suffix can continue without duplicating or inventing recent work.",
		);
	}
	if (previousSummary) {
		parts.push(`Previous summary (preserve relevant content):\n${previousSummary}`);
	}
	if (readFiles.length > 0 || modifiedFiles.length > 0) {
		parts.push(
			`<read-files>\n${readFiles.join("\n")}\n</read-files>`,
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	return parts.join("\n\n");
}

/** DeepSeek usage → pi-ai Usage 结构（供会话 totals 记录） */
function toPiUsage(usage?: DeepSeekUsage) {
	const cacheRead = usage?.prompt_cache_hit_tokens ?? 0;
	const prompt = usage?.prompt_tokens ?? 0;
	const output = usage?.completion_tokens ?? 0;
	const input = Math.max(0, prompt - cacheRead);
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function fmtT(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}
