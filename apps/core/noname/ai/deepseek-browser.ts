/** Explicit BYOK requests only. This module never reads DOM, storage, or a local gateway. */
import { boundedSnapshot, buildDeepSeekPayload, DeepSeekProtocolError, MAX_DEEPSEEK_RESPONSE_BYTES, readUsage, validateCompletion, type DeepSeekProtocolReply, type DeepSeekSnapshot } from "./deepseek-protocol.mjs";

export const DEEPSEEK_OFFICIAL_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEEPSEEK_BROWSER_MODELS = Object.freeze({ decision: "deepseek-flash", advice: "deepseek-flash", plan: "deepseek-v4-pro" });
export const DEEPSEEK_MODEL_DESCRIPTIONS = Object.freeze([Object.freeze({ id: "deepseek-flash", label: "DeepSeek Flash", purpose: "出牌决策与建议" }), Object.freeze({ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", purpose: "回合规划" })]);

export interface BrowserDeepSeekOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Tests may inject fetch; production callers always use the fixed official endpoint. */
	fetch?: typeof globalThis.fetch;
}

export interface BrowserDeepSeekReply extends DeepSeekProtocolReply {
	requestId: string;
	durationMs: number;
}

async function responseJSON(response: Response): Promise<unknown> {
	if (!response.body) throw new DeepSeekProtocolError(502, "invalid_response", "DeepSeek 未返回有效结果。");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0,
		text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_DEEPSEEK_RESPONSE_BYTES) {
				void reader.cancel().catch(() => {});
				throw new DeepSeekProtocolError(502, "invalid_response", "DeepSeek 返回的结果过大。");
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new DeepSeekProtocolError(502, "invalid_response", "DeepSeek 未返回有效 JSON 结果。");
	}
}

function providerError(status: number) {
	const errors: Record<number, [string, string]> = {
		401: ["authentication_failed", "DeepSeek API Key 认证失败，请检查你填写的 Key。"],
		403: ["authentication_failed", "DeepSeek 拒绝此账号或模型的访问。"],
		402: ["insufficient_balance", "DeepSeek 账号余额不足，请前往官方控制台查看。"],
		429: ["rate_limited", "DeepSeek 请求过于频繁，请稍后手动重试。"],
		503: ["provider_busy", "DeepSeek 服务繁忙，请稍后手动重试。"],
	};
	const [code, message] = errors[status] || ["upstream_error", `DeepSeek 服务未能完成请求（HTTP ${status}）。`];
	return new DeepSeekProtocolError(status, code, message);
}

function hideCredential(reply: DeepSeekProtocolReply, key: string): DeepSeekProtocolReply {
	const redact = (value: string) =>
		value
			.split(key)
			.join("[redacted]")
			.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
			.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
	return { ...reply, advice: redact(reply.advice), ...(reply.plan !== undefined ? { plan: redact(reply.plan) } : {}), ...(reply.memory !== undefined ? { memory: redact(reply.memory) } : {}), ...(reply.identityBeliefs ? { identityBeliefs: reply.identityBeliefs.map(belief => ({ ...belief, reason: redact(belief.reason) })) } : {}) };
}

/** One explicit user-key request; never retries and never keeps the key after it settles. */
export async function getBrowserDecision(apiKey: string, packet: unknown, options: BrowserDeepSeekOptions = {}): Promise<BrowserDeepSeekReply> {
	const startedAt = Date.now();
	const requestId = globalThis.crypto?.randomUUID?.() || `browser-${startedAt.toString(36)}-${Math.random().toString(36).slice(2)}`;
	let model: string | undefined;
	let controller: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	let timedOut = false;
	try {
		if (typeof apiKey !== "string" || !apiKey.trim()) throw new DeepSeekProtocolError(400, "not_configured", "请先填写你自己的 DeepSeek API Key。");
		const key = apiKey.trim();
		if (key.length > 512 || /[^\x21-\x7e]/.test(key)) throw new DeepSeekProtocolError(400, "invalid_api_key", "DeepSeek API Key 格式无效，请重新填写。");
		let wirePacket: unknown;
		try {
			// Match the local gateway's JSON wire: optional object fields disappear,
			// and optional array entries become null before protocol validation.
			const encoded = JSON.stringify(packet);
			if (encoded === undefined) throw new Error("not JSON data");
			wirePacket = JSON.parse(encoded);
		} catch {
			throw new DeepSeekProtocolError(400, "invalid_snapshot", "游戏局面无法转换为有效 JSON，请重新获取当前局面。");
		}
		const snapshot: DeepSeekSnapshot = boundedSnapshot(wirePacket);
		model = DEEPSEEK_BROWSER_MODELS[snapshot.kind];
		const body = JSON.stringify(buildDeepSeekPayload(snapshot, model));
		if (body.includes(key)) throw new DeepSeekProtocolError(400, "credential_in_snapshot", "游戏局面不应包含 API 凭据，请重新获取当前局面。");
		const timeoutMs = options.timeoutMs ?? (snapshot.kind === "advice" ? 45000 : 15000);
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new DeepSeekProtocolError(400, "invalid_timeout", "DeepSeek 请求时限无效。");
		controller = new AbortController();
		onAbort = () => {
			timedOut = options.signal?.reason?.name === "TimeoutError";
			controller!.abort();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			timedOut = true;
			controller!.abort();
		}, timeoutMs);
		if (controller.signal.aborted) throw new Error("aborted");
		const response = await (options.fetch || globalThis.fetch)(DEEPSEEK_OFFICIAL_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body,
			signal: controller.signal,
			redirect: "error",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			cache: "no-store",
		});
		if (controller.signal.aborted) throw new Error("aborted");
		if (!response.ok) {
			const error = providerError(response.status);
			try {
				const completion = (await responseJSON(response)) as { usage?: unknown };
				const usage = readUsage(completion?.usage);
				if (usage) error.usage = usage;
			} catch {
				/* Provider text and body errors never become visible messages. */
			}
			throw error;
		}
		const completion = await responseJSON(response);
		if (controller.signal.aborted) throw new Error("aborted");
		const reply = hideCredential(validateCompletion(completion, snapshot, model), key);
		return { ...reply, requestId, durationMs: Math.max(0, Date.now() - startedAt) };
	} catch (failure) {
		let error: DeepSeekProtocolError;
		if (timedOut) error = new DeepSeekProtocolError(504, "timeout", "DeepSeek 响应超时，请手动重试或使用原版 AI。");
		else if (controller?.signal.aborted) error = new DeepSeekProtocolError(499, "aborted", "本次 DeepSeek 请求已取消。");
		else if (failure instanceof DeepSeekProtocolError) error = failure;
		else error = new DeepSeekProtocolError(502, "upstream_unavailable", "无法连接 DeepSeek 官方服务，请检查网络或稍后手动重试。");
		error.requestId = requestId;
		error.durationMs = Math.max(0, Date.now() - startedAt);
		if (model) error.model = model;
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) options.signal?.removeEventListener("abort", onAbort);
	}
}

export function createBrowserDeepSeekClient(defaults: BrowserDeepSeekOptions = {}) {
	return (apiKey: string, packet: unknown, options: BrowserDeepSeekOptions = {}) => getBrowserDecision(apiKey, packet, { ...defaults, ...options });
}
