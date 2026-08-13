/**
 * DeepSeek KV Cache 优化扩展
 *
 * 针对 DeepSeek 自动前缀缓存（context caching，命中价约为全价 1/50）的工程优化：
 *
 * 1. before_provider_request 缓存主对话请求的完整 wire payload
 *    （system + messages + tools 逐字保留）
 * 2. session_before_compact 接管压缩摘要请求：摘要请求 = 主对话前缀
 *    （逐字不变）+ 尾部追加摘要指令 → 公共前缀整体命中缓存
 *    与 dsh 的 compaction-basic 回放前缀策略一致
 * 3. /dshkv 命令查看缓存命中统计，验证优化是否生效
 *
 * 安装：
 *   - 本文件位于 ~/.pi/agent/extensions/，并在 ~/.pi/agent/settings.json
 *     的 "extensions" 数组加入该路径（或 --extension 参数加载）
 *   - /reload 热重载
 *
 * 验证：运行 /dshkv，观察压缩请求的缓存命中率；或对比压缩前后
 * usage 中的 cache_read_tokens / prompt_cache_hit_tokens。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		requests: 0, // 主对话请求数
		inputTokens: 0, // 主对话未命中输入
		cacheReadTokens: 0, // 主对话缓存命中
		compactRequests: 0, // 前缀复用压缩请求数
		compactCacheRead: 0, // 压缩请求缓存命中
		compactInput: 0, // 压缩请求未命中输入
		fallbacks: 0, // 退回 pi 默认压缩的次数
	};

	/** 渲染状态：footer 状态行 + 编辑器下方 widget（与 footer 组件解耦，任何主题/自定义 footer 下都可见） */
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

	// 1. 缓存主对话请求的 wire payload（agent 主请求必有 tools），
	//    连同 provider/modelId/baseUrl/key 绑定为同一份快照，
	//    压缩前精确匹配，避免切换厂商/端点后复用旧 payload 和旧密钥
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

	// 2. 缓存 Authorization 头；若已有快照但缺密钥则补上（同一请求代）
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		const auth = event.headers.authorization ?? event.headers["Authorization"];
		if (typeof auth === "string" && auth.length > 0) {
			authHeader = auth;
			if (cache && !cache.authHeader) cache.authHeader = auth;
		}
	});

	// 3. 压缩：摘要请求 = 主对话前缀（逐字不变）+ 尾部指令 → 前缀整体命中缓存
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		// 无缓存/密钥 → 退回 pi 默认
		if (!cache?.payload?.messages?.length || !cache.authHeader) return;
		// 显式确认当前仍是 DeepSeek 路由
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		// 快照精确匹配：provider + modelId + baseUrl 任一变化都放弃缓存
		if (
			cache.provider !== ctx.model?.provider ||
			cache.modelId !== ctx.model?.id ||
			cache.baseUrl !== ctx.model?.baseUrl
		) {
			return;
		}

		const payload: WirePayload = {
			...cache.payload, // 键序保持：model, messages, tools, ... → 前缀逐字一致
			messages: [...cache.payload.messages, { role: "user", content: buildInstruction(preparation) }],
			stream: false,
			max_tokens: SUMMARY_MAX_TOKENS,
			// thinking 位于 body 尾部，不影响 messages 前缀命中；摘要无需推理
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
			return; // 任何失败退回 pi 默认压缩，不影响功能
		}
	});

	// 4. 统计主对话请求的缓存命中，并实时更新 footer 状态行
	pi.on("message_end", (event, ctx) => {
		if (!isDeepSeek(ctx.model?.provider, ctx.model?.id)) return;
		const usage = event.message?.usage;
		if (!usage) return;
		stats.requests++;
		stats.inputTokens += usage.input ?? 0;
		stats.cacheReadTokens += usage.cacheRead ?? 0;
		renderStatus(ctx);
	});

	// 5. /dshkv 查看命中统计
	pi.registerCommand("dshkv", {
		description: "DeepSeek KV Cache 命中统计",
		handler: async (_args, ctx) => {
			const total = stats.inputTokens + stats.cacheReadTokens;
			const hitRate = total > 0 ? ((stats.cacheReadTokens / total) * 100).toFixed(1) : "0.0";
			const cTotal = stats.compactInput + stats.compactCacheRead;
			const cRate = cTotal > 0 ? ((stats.compactCacheRead / cTotal) * 100).toFixed(1) : "0.0";
			const saved = (stats.compactCacheRead / 1e6) * 0.14; // 命中 vs 全价差约 $0.14/M
			ctx.ui.notify(
				[
					`主对话：${stats.requests} 次请求，输入 ${fmt(total)} tokens，缓存命中 ${fmt(stats.cacheReadTokens)} (${hitRate}%)`,
					`压缩：${stats.compactRequests} 次前缀复用，命中 ${fmt(stats.compactCacheRead)} (${cRate}%)，回退 ${stats.fallbacks} 次`,
					...(stats.compactCacheRead > 0 ? [`压缩累计节省约 $${saved.toFixed(3)}`] : []),
				].join("\n"),
				"info",
			);
		},
	});
}

function buildInstruction(preparation: {
	previousSummary?: string;
	fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
}): string {
	const { previousSummary, fileOps } = preparation;
	const readFiles = fileOps?.readFiles ?? [];
	const modifiedFiles = fileOps?.modifiedFiles ?? [];
	const parts = [
		"Summarize the conversation above so that work can continue without it. Structure the summary as:",
		"## Goal",
		"## Constraints & Preferences",
		"## Progress (Done / In Progress / Blocked)",
		"## Key Decisions",
		"## Next Steps",
		"## Critical Context",
	];
	if (previousSummary) {
		parts.push(`Previous summary (preserve its content):\n${previousSummary}`);
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

/** 与 pi 默认 footer 一致的 token 缩写（1.2k / 45M） */
function fmtT(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}
