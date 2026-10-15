import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserDeepSeekClient, DEEPSEEK_BROWSER_MODELS, DEEPSEEK_OFFICIAL_ENDPOINT, getBrowserDecision } from "./deepseek-browser";
import { boundedSnapshot, DeepSeekProtocolError, readUsage, SYSTEM_PROMPT } from "./deepseek-protocol.mjs";

const KEY = "sk-browser-test-placeholder-only";
const packet = {
	kind: "decision",
	event: "chooseToUse:phase",
	player: { id: "self", role: "忠臣", hand: [{ name: "sha" }] },
	state: {
		players: [
			{ id: "self", role: "忠臣" },
			{ id: "other", role: "未知身份" },
		],
		knowledgeMode: "known",
	},
	candidates: [
		{ id: "play-sha", label: "对其他玩家使用杀" },
		{ id: "cancel", label: "结束出牌阶段" },
	],
};
const providerUsage = { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 };
const usage = { promptTokens: 120, completionTokens: 25, totalTokens: 145, cacheHitTokens: 80, cacheMissTokens: 40 };

function completion(answer: unknown = { choice: "play-sha", advice: "优先压低敌方血量，保留防御资源。" }, extra: Record<string, unknown> = {}) {
	return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }], usage: providerUsage, ...extra }), { headers: { "Content-Type": "application/json" } });
}

function mockFetch(handler: (url: string, options: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; options: RequestInit }[] = [];
	const fetch = (async (url, options) => {
		const call = { url: String(url), options: options || {} };
		calls.push(call);
		return handler(call.url, call.options);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

test("client construction and missing keys never make a network request", async () => {
	const mock = mockFetch(() => assert.fail("No automatic requests"));
	const client = createBrowserDeepSeekClient({ fetch: mock.fetch });
	assert.equal(mock.calls.length, 0);
	await assert.rejects(client("", packet), (error: any) => error.code === "not_configured" && error instanceof DeepSeekProtocolError);
	await assert.rejects(client("  ", null), (error: any) => error.code === "not_configured");
	await assert.rejects(client("key\nprivate", packet), (error: any) => error.code === "invalid_api_key" && !JSON.stringify(error).includes("private"));
	assert.equal(mock.calls.length, 0);
});

test("official requests keep the key exclusively in Authorization and preserve known game data", async () => {
	const mock = mockFetch(() => completion());
	const original = JSON.stringify(packet);
	const reply = await getBrowserDecision(KEY, packet, { fetch: mock.fetch });
	assert.equal(mock.calls.length, 1);
	const { url, options } = mock.calls[0];
	assert.equal(url, DEEPSEEK_OFFICIAL_ENDPOINT);
	assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
	assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${KEY}`);
	assert.equal(options.credentials, "omit");
	assert.equal(options.redirect, "error");
	assert.equal(options.referrerPolicy, "no-referrer");
	const payload = JSON.parse(String(options.body));
	assert.equal(payload.model, "deepseek-flash");
	assert.deepEqual(payload.thinking, { type: "disabled" });
	assert.deepEqual(payload.response_format, { type: "json_object" });
	assert.equal(payload.messages[0].content, SYSTEM_PROMPT);
	assert.deepEqual(JSON.parse(payload.messages[1].content), packet);
	assert.ok(!String(options.body).includes(KEY));
	assert.ok(!JSON.stringify(reply).includes(KEY));
	assert.deepEqual(reply.usage, usage);
	assert.equal(reply.source, "deepseek");
	assert.equal(reply.choice, "play-sha");
	assert.equal(reply.model, DEEPSEEK_BROWSER_MODELS.decision);
	assert.ok(reply.requestId);
	assert.ok(Number.isFinite(reply.durationMs) && reply.durationMs >= 0);
	assert.equal(JSON.stringify(packet), original);
});

test("plans use Pro while advice and decisions use Flash with their existing budgets", async () => {
	const mock = mockFetch((_url, options) => {
		const kind = JSON.parse(JSON.parse(String(options.body)).messages[1].content).kind;
		return completion({ choice: kind === "decision" ? "cancel" : null, advice: "根据后续公开行动调整资源分配。", ...(kind === "plan" ? { plan: "优先保护关键队友，必要时保留桃。", memory: "身份推断仍有不确定性。" } : {}) });
	});
	for (const [kind, model, budget] of [
		["decision", "deepseek-flash", 1536],
		["advice", "deepseek-flash", 2048],
		["plan", "deepseek-v4-pro", 3072],
	] as const) {
		const reply = await getBrowserDecision(KEY, { ...packet, kind, ...(kind !== "decision" ? { candidates: [] } : {}) }, { fetch: mock.fetch });
		const payload = JSON.parse(String(mock.calls.at(-1)!.options.body));
		assert.equal(payload.model, model);
		assert.equal(payload.max_tokens, budget);
		assert.equal(reply.model, model);
	}
});

test("real optional card and player fields follow JSON wire semantics before validation", async () => {
	const input = {
		...packet,
		player: { ...packet.player, group: undefined, hand: [{ name: "sha", nature: undefined }] },
		state: { ...packet.state, players: [{ id: "other", group: undefined, skills: [] }], memory: undefined },
		candidates: [{ ...packet.candidates[0], cards: [{ name: "sha", nature: undefined }] }],
	};
	const mock = mockFetch(() => completion());
	const reply = await getBrowserDecision(KEY, input, { fetch: mock.fetch });
	assert.equal(reply.choice, "play-sha");
	assert.equal(mock.calls.length, 1);
	assert.equal(mock.calls[0].url, DEEPSEEK_OFFICIAL_ENDPOINT);
	const sent = JSON.parse(JSON.parse(String(mock.calls[0].options.body)).messages[1].content);
	assert.deepEqual(sent, JSON.parse(JSON.stringify(input)));
	assert.equal(Object.hasOwn(sent.player, "group"), false);
	assert.equal(Object.hasOwn(sent.player.hand[0], "nature"), false);
	assert.equal(Object.hasOwn(sent.state.players[0], "group"), false);
	assert.equal(Object.hasOwn(sent.candidates[0].cards[0], "nature"), false);
	assert.equal(Object.hasOwn(input.player, "group"), true);
});

test("cyclic and non-JSON packets fail as invalid snapshots before fetch", async () => {
	const cyclic: any = { ...packet, state: { ...packet.state } };
	cyclic.state.cycle = cyclic;
	const mock = mockFetch(() => assert.fail("Invalid JSON wire data must never call fetch"));
	for (const input of [cyclic, { ...packet, state: { unsupported: 1n } }, undefined]) {
		await assert.rejects(getBrowserDecision(KEY, input, { fetch: mock.fetch }), (error: any) => {
			assert.equal(error.code, "invalid_snapshot");
			assert.equal(error.status, 400);
			assert.ok(error.requestId);
			return true;
		});
	}
	assert.equal(mock.calls.length, 0);
});

test("invalid legal candidate IDs preserve paid usage and never return the upstream body", async () => {
	for (const choice of ["illegal-card", null]) {
		const mock = mockFetch(() => completion({ choice, advice: `private response ${KEY}` }));
		await assert.rejects(getBrowserDecision(KEY, packet, { fetch: mock.fetch }), (error: any) => {
			assert.equal(error.code, "invalid_choice");
			assert.equal(error.status, 502);
			assert.deepEqual(error.usage, usage);
			assert.equal(error.model, "deepseek-flash");
			assert.ok(error.requestId && Number.isFinite(error.durationMs));
			assert.ok(!JSON.stringify(error).includes(KEY));
			assert.ok(!error.message.includes("private response"));
			return true;
		});
	}
});

test("truncation, invalid JSON and invalid strategy fields have precise safe errors with usage", async () => {
	const variants = [
		{ response: () => completion({}, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }), code: "response_truncated" },
		{ response: () => completion({}, { choices: [{ finish_reason: "stop", message: { content: `not-json-${KEY}` } }] }), code: "invalid_response" },
		{ response: () => completion({ choice: "cancel", advice: "结束出牌。", memory: "x".repeat(2049) }), code: "invalid_response" },
		{ response: () => completion({ choice: "cancel", advice: "结束出牌。", identityBeliefs: [{ id: "outside-match", role: "fan", confidence: 0.5, reason: "无效玩家" }] }), code: "invalid_identity_beliefs" },
	];
	for (const variant of variants) {
		const mock = mockFetch(variant.response);
		await assert.rejects(getBrowserDecision(KEY, packet, { fetch: mock.fetch }), (error: any) => {
			assert.equal(error.code, variant.code);
			assert.deepEqual(error.usage, usage);
			assert.ok(!JSON.stringify(error).includes(KEY));
			return true;
		});
	}
});

test("bounded identity beliefs are accepted only for known players with valid confidence", async () => {
	const belief = { id: "other", role: "fan", confidence: 0.6, reason: "连续攻击主公，仅为推断。" };
	const mock = mockFetch(() => completion({ choice: "cancel", advice: "保留资源。", identityBeliefs: [belief] }));
	assert.deepEqual((await getBrowserDecision(KEY, packet, { fetch: mock.fetch })).identityBeliefs, [belief]);
	for (const invalid of [
		{ ...belief, confidence: -0.1 },
		{ ...belief, confidence: 1.1 },
		{ ...belief, role: "admin" },
	]) {
		const bad = mockFetch(() => completion({ choice: "cancel", advice: "保留资源。", identityBeliefs: [invalid] }));
		await assert.rejects(getBrowserDecision(KEY, packet, { fetch: bad.fetch }), (error: any) => error.code === "invalid_identity_beliefs");
	}
});

test("provider authentication, balance, rate and availability failures are distinct and never retry", async () => {
	for (const [status, code] of [
		[401, "authentication_failed"],
		[403, "authentication_failed"],
		[402, "insufficient_balance"],
		[429, "rate_limited"],
		[503, "provider_busy"],
		[500, "upstream_error"],
	] as const) {
		const mock = mockFetch(() => new Response(JSON.stringify({ error: { message: `Bearer ${KEY}` }, usage: providerUsage }), { status }));
		await assert.rejects(getBrowserDecision(KEY, packet, { fetch: mock.fetch }), (error: any) => {
			assert.equal(error.code, code);
			assert.equal(error.status, status);
			assert.deepEqual(error.usage, usage);
			assert.ok(!error.message.includes(KEY));
			assert.ok(!JSON.stringify(error).includes(KEY));
			return true;
		});
		assert.equal(mock.calls.length, 1);
	}
});

test("missing token counters remain unknown rather than being reported as zero", async () => {
	const mock = mockFetch(() => completion(undefined, { usage: undefined }));
	const reply = await getBrowserDecision(KEY, packet, { fetch: mock.fetch });
	assert.equal(reply.usage, undefined);
	assert.equal(readUsage(undefined), null);
	assert.deepEqual(readUsage({ prompt_tokens: 0, completion_tokens: -1, total_tokens: "10" }), { promptTokens: 0 });
});

test("external cancellation and timeout abort exactly one request without leaking rejection details", async () => {
	for (const mode of ["cancel", "timeout"] as const) {
		const controller = new AbortController();
		const mock = mockFetch((_url, options) => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error(`private fetch failure ${KEY}`)), { once: true })));
		const request = getBrowserDecision(KEY, packet, { fetch: mock.fetch, signal: controller.signal, timeoutMs: mode === "timeout" ? 5 : 1000 });
		if (mode === "cancel") controller.abort(new Error(`private cancel reason ${KEY}`));
		await assert.rejects(request, (error: any) => {
			assert.equal(error.code, mode === "timeout" ? "timeout" : "aborted");
			assert.ok(!error.message.includes(KEY));
			assert.ok(!JSON.stringify(error).includes(KEY));
			assert.equal(error.usage, undefined);
			return true;
		});
		assert.equal(mock.calls.length, 1);
	}
	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	const mock = mockFetch(() => assert.fail("Pre-aborted signals must not call fetch"));
	await assert.rejects(getBrowserDecision(KEY, packet, { fetch: mock.fetch, signal: alreadyAborted.signal }), (error: any) => error.code === "aborted");
	assert.equal(mock.calls.length, 0);
});

test("network and malformed response errors never expose raw fetch or response text", async () => {
	for (const handler of [
		() => {
			throw new Error(`network message with ${KEY}`);
		},
		() => new Response(`not-json: ${KEY}`),
		() => new Response("x".repeat(128 * 1024 + 1)),
	]) {
		const mock = mockFetch(handler);
		await assert.rejects(getBrowserDecision(KEY, packet, { fetch: mock.fetch }), (error: any) => {
			assert.ok(["upstream_unavailable", "invalid_response"].includes(error.code));
			assert.ok(!error.message.includes(KEY));
			assert.ok(!JSON.stringify(error).includes(KEY));
			return true;
		});
	}
});

test("snapshots are bounded before fetch and may never contain the supplied credential", async () => {
	const mock = mockFetch(() => assert.fail("Invalid snapshots must not leave the browser"));
	for (const [body, code] of [
		[{ ...packet, candidates: [] }, "invalid_snapshot"],
		[{ ...packet, candidates: [packet.candidates[0], packet.candidates[0]] }, "invalid_candidates"],
		[{ ...packet, state: { values: Array.from({ length: 128 }, () => "x".repeat(1024)) } }, "body_too_large"],
		[{ ...packet, state: { accidentalCredential: KEY } }, "credential_in_snapshot"],
	] as const)
		await assert.rejects(getBrowserDecision(KEY, body, { fetch: mock.fetch }), (error: any) => error.code === code);
	assert.equal(mock.calls.length, 0);
	assert.throws(
		() => boundedSnapshot({ ...packet, state: JSON.parse('{"__proto__":{"poisoned":true}}') }),
		(error: any) => error.code === "invalid_snapshot"
	);
});

test("key-like response content is redacted and unexpected provider fields are discarded", async () => {
	const mock = mockFetch(() => completion({ choice: "cancel", advice: `不要暴露 ${KEY}`, plan: `Bearer ${KEY}`, memory: KEY, apiKey: KEY, headers: { authorization: KEY }, identityBeliefs: [{ id: "other", role: "unknown", confidence: 0.2, reason: KEY }] }, { apiKey: KEY, requestId: KEY, model: KEY }));
	const reply = await getBrowserDecision(KEY, packet, { fetch: mock.fetch });
	assert.ok(!JSON.stringify(reply).includes(KEY));
	assert.match(reply.advice, /redacted/);
	assert.equal(reply.model, "deepseek-flash");
	assert.notEqual(reply.requestId, KEY);
	assert.equal((reply as any).apiKey, undefined);
	assert.equal((reply as any).headers, undefined);
});
