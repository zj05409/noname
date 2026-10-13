import assert from "node:assert/strict";
import http from "node:http";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import test from "node:test";
import { createDeepSeekServer, loadDeepSeekConfiguration, runCli } from "./deepseek-server.mjs";

const { fetch } = globalThis;

const TEST_KEY = "test-only-key";
const snapshot = {
	kind: "decision",
	event: "chooseToUse",
	player: { name: "刘备", hp: 3, hand: [{ name: "杀" }] },
	state: { phase: "出牌阶段", players: [{ name: "曹操", hp: 2, identity: "未知" }] },
	candidates: [
		{ id: "use-sha-1", label: "对曹操使用杀", score: 5 },
		{ id: "pass", label: "结束出牌", score: 0 },
	],
};

async function listen(t, server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(
		() =>
			new Promise(resolve => {
				server.close(resolve);
				server.closeAllConnections();
			})
	);
	return `http://127.0.0.1:${server.address().port}`;
}

async function gameRoot(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "noname-deepseek-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "game");
	await mkdir(path.join(root, "extension"), { recursive: true });
	await writeFile(path.join(root, "index.html"), "<!doctype html><title>Noname test</title>");
	await writeFile(path.join(root, "noname.js"), "export const game = true;");
	await writeFile(path.join(root, ".env"), "TEST_PRIVATE_VALUE=never-expose");
	await writeFile(path.join(directory, "private.json"), JSON.stringify({ apiKey: TEST_KEY }));
	await symlink(path.join(directory, "private.json"), path.join(root, "outside.json"));
	await symlink(path.join(root, ".env"), path.join(root, "hidden-alias.txt"));
	return { root, directory };
}

async function gateway(t, options = {}) {
	const { root, directory } = await gameRoot(t);
	const server = createDeepSeekServer({ root, apiKey: TEST_KEY, model: "deepseek-flash", ...options });
	return { url: await listen(t, server), server, root, directory };
}

async function mockProvider(t, respond) {
	const requests = [];
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
		await respond(req, res, requests.at(-1));
	});
	return { url: await listen(t, server), requests };
}

function completion(res, answer, finishReason = "stop") {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(answer) } }] }));
}

function post(url, body = snapshot, headers = {}) {
	return fetch(`${url}/api/deepseek/decision`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function rawRequest(url, requestPath, { headers = {}, method = "GET", body } = {}) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = http.request({ hostname: target.hostname, port: target.port, path: requestPath, method, headers }, response => {
			const chunks = [];
			response.on("data", chunk => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
		});
		request.on("error", reject);
		request.end(body);
	});
}

test("legal decisions use JSON mode, disabled thinking, and Chinese advice", async t => {
	const provider = await mockProvider(t, (_req, res) => completion(res, { choice: "use-sha-1", advice: "对曹操使用杀，争取造成伤害。" }));
	const { url } = await gateway(t, { baseUrl: `${provider.url}/v1` });
	const response = await post(url);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { choice: "use-sha-1", advice: "对曹操使用杀，争取造成伤害。", source: "deepseek", model: "deepseek-flash" });
	assert.equal(provider.requests.length, 1);
	assert.equal(provider.requests[0].path, "/v1/chat/completions");
	assert.equal(provider.requests[0].authorization, `Bearer ${TEST_KEY}`);
	assert.deepEqual(provider.requests[0].body.response_format, { type: "json_object" });
	assert.deepEqual(provider.requests[0].body.thinking, { type: "disabled" });
	assert.ok(provider.requests[0].body.max_tokens >= 1000);
	assert.deepEqual(JSON.parse(provider.requests[0].body.messages[1].content), snapshot);
	assert.match(provider.requests[0].body.messages[0].content, /不得假设知道对手手牌/);
});

test("advice accepts an empty legal candidate list", async t => {
	const provider = await mockProvider(t, (_req, res) => completion(res, { choice: null, advice: "保留闪，观察下一名玩家的行动。" }));
	const { url } = await gateway(t, { baseUrl: provider.url });
	const response = await post(url, { ...snapshot, kind: "advice", candidates: [] });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).choice, null);
});

test("turn plans retain bounded memory and identity inference for known players", async t => {
	const answer = {
		choice: null,
		advice: "先压低疑似反贼血量；保留桃救援主公。",
		plan: "先观察队友的行动。若敌人仍有防御牌，先用锦囊消耗；AOE 可能伤害友军时暂缓。",
		memory: "曹操上回合攻击主公，反贼可能性提高，仍待确认。",
		identityBeliefs: [{ id: "opponent", role: "fan", confidence: 0.7, reason: "公开行动为攻击主公，仅作为身份推断。" }],
	};
	const provider = await mockProvider(t, (_req, res) => completion(res, answer));
	const { url } = await gateway(t, { baseUrl: provider.url });
	const body = { ...snapshot, kind: "plan", candidates: [], state: { ...snapshot.state, players: [{ id: "opponent", name: "曹操" }], knowledgeMode: "omniscient", turn: { number: 3 }, memory: "此前身份未知。" } };
	const response = await post(url, body);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ...answer, source: "deepseek", model: "deepseek-flash" });
	assert.deepEqual(JSON.parse(provider.requests[0].body.messages[1].content), body);
	for (const concept of ["omniscient", "无懈可击", "内奸", "AOE", "推断"]) assert.ok(provider.requests[0].body.messages[0].content.includes(concept));
});

test("plan requests use the stronger configured model and larger output budget", async t => {
	const provider = await mockProvider(t, (_req, res, request) => {
		const kind = JSON.parse(request.body.messages[1].content).kind;
		completion(res, { choice: kind === "plan" ? null : "pass", advice: "保留资源，按后续局面调整战术。" });
	});
	const { url } = await gateway(t, { baseUrl: provider.url, planModel: "deepseek-v4-pro" });
	const health = await fetch(`${url}/api/deepseek/health`);
	assert.deepEqual(await health.json(), { configured: true, model: "deepseek-flash", planModel: "deepseek-v4-pro" });
	for (const kind of ["plan", "decision", "advice"]) {
		const response = await post(url, { ...snapshot, kind, ...(kind === "plan" ? { candidates: [] } : {}) });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).model, kind === "plan" ? "deepseek-v4-pro" : "deepseek-flash");
		const request = provider.requests.at(-1);
		assert.equal(request.body.model, kind === "plan" ? "deepseek-v4-pro" : "deepseek-flash");
		assert.equal(request.body.max_tokens, kind === "plan" ? 3072 : 1536);
		assert.deepEqual(request.body.thinking, { type: "disabled" });
	}
});

test("turn plans cannot commit a legal action", async t => {
	const provider = await mockProvider(t, (_req, res) => completion(res, { choice: "pass", advice: "结束出牌。", plan: "本回合保留资源。" }));
	const { url } = await gateway(t, { baseUrl: provider.url });
	const response = await post(url, { ...snapshot, kind: "plan" });
	assert.equal(response.status, 502);
	assert.equal((await response.json()).error, "invalid_choice");
});

test("identity inference rejects unknown IDs, invalid roles, and out-of-range confidence", async t => {
	for (const belief of [
		{ id: "nonexistent", role: "fan", confidence: 0.5, reason: "未知玩家" },
		{ id: "opponent", role: "admin", confidence: 0.5, reason: "无效身份" },
		{ id: "opponent", role: "fan", confidence: 1.1, reason: "无效置信度" },
		{ id: "opponent", role: "fan", confidence: -0.1, reason: "无效置信度" },
		{ id: "opponent", role: "fan", confidence: "0.5", reason: "无效置信度类型" },
	]) {
		const provider = await mockProvider(t, (_req, res) => completion(res, { choice: "pass", advice: "结束出牌。", identityBeliefs: [belief] }));
		const { url } = await gateway(t, { baseUrl: provider.url });
		const response = await post(url, { ...snapshot, state: { ...snapshot.state, players: [{ id: "opponent", name: "曹操" }] } });
		assert.equal(response.status, 502);
		assert.equal((await response.json()).error, "invalid_identity_beliefs");
	}
});

test("malformed or oversized strategy memory is rejected", async t => {
	for (const strategy of [{ memory: "x".repeat(2049) }, { memory: { secret: "invalid" } }, { plan: "x".repeat(4097) }]) {
		const provider = await mockProvider(t, (_req, res) => completion(res, { choice: "pass", advice: "结束出牌。", ...strategy }));
		const { url } = await gateway(t, { baseUrl: provider.url });
		const response = await post(url);
		assert.equal(response.status, 502);
		assert.equal((await response.json()).error, "invalid_response");
	}
});

test("an invented candidate ID or missing decision is rejected", async t => {
	for (const choice of ["invented-card", null]) {
		const provider = await mockProvider(t, (_req, res) => completion(res, { choice, advice: "使用不存在的操作。" }));
		const { url } = await gateway(t, { baseUrl: provider.url });
		const response = await post(url);
		assert.equal(response.status, 502);
		assert.equal((await response.json()).error, "invalid_choice");
	}
});

test("unconfigured health is readable but decisions do not reach a provider", async t => {
	const { url } = await gateway(t, { apiKey: "" });
	const health = await fetch(`${url}/api/deepseek/health`);
	assert.deepEqual(await health.json(), { configured: false, model: "deepseek-flash", planModel: "deepseek-flash" });
	const response = await post(url);
	assert.equal(response.status, 503);
	assert.equal((await response.json()).error, "not_configured");
});

test("timeouts return a bounded local error", async t => {
	const provider = await mockProvider(t, async (_req, res) => {
		await new Promise(resolve => setTimeout(resolve, 150));
		if (!res.destroyed) completion(res, { choice: "pass", advice: "结束出牌。" });
	});
	const { url } = await gateway(t, { baseUrl: provider.url, timeoutMs: 25 });
	const response = await post(url);
	assert.equal(response.status, 504);
	assert.equal((await response.json()).error, "timeout");
});

test("provider failures and malformed or truncated output never expose raw bodies", async t => {
	const privateValue = "mock-upstream-private-value";
	for (const variant of ["authentication", "malformed", "truncated"]) {
		const provider = await mockProvider(t, (_req, res) => {
			if (variant === "authentication") {
				res.writeHead(401);
				res.end(privateValue);
			} else if (variant === "malformed") {
				res.end(privateValue);
			} else completion(res, { choice: "pass", advice: privateValue }, "length");
		});
		const { url } = await gateway(t, { baseUrl: provider.url });
		const response = await post(url);
		assert.equal(response.status, 502);
		const body = await response.text();
		assert.ok(!body.includes(privateValue));
		assert.ok(!body.includes(TEST_KEY));
	}
});

test("Host, Origin and cross-site request protections reject foreign pages", async t => {
	const { url } = await gateway(t);
	assert.equal((await rawRequest(url, "/api/deepseek/health", { headers: { Host: `evil.example:${new URL(url).port}` } })).status, 403);
	assert.equal((await rawRequest(url, "/api/deepseek/health", { headers: { Origin: "https://evil.example" } })).status, 403);
	assert.equal((await rawRequest(url, "/api/deepseek/health", { headers: { Origin: "null" } })).status, 403);
	assert.equal((await rawRequest(url, "/api/deepseek/health", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
	const allowed = await rawRequest(url, "/api/deepseek/health", { headers: { Origin: url } });
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers["access-control-allow-origin"], undefined);
	assert.ok(!allowed.text.includes(TEST_KEY));
});

test("static files support HEAD while traversal, hidden paths and symlink escapes are denied", async t => {
	const { url } = await gateway(t);
	const index = await fetch(`${url}/`);
	assert.equal(index.status, 200);
	assert.match(await index.text(), /Noname test/);
	const head = await fetch(`${url}/noname.js`, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assert.match(head.headers.get("content-type"), /javascript/);
	for (const requestPath of ["/%2e%2e/private.json", "/.env", "/outside.json", "/hidden-alias.txt", "/%5c..%5cprivate.json"]) {
		const response = await rawRequest(url, requestPath);
		assert.equal(response.status, 403, requestPath);
		assert.ok(!response.text.includes(TEST_KEY));
	}
});

test("preserved .pnpm dependencies remain available to the built game", async t => {
	const { url, root } = await gateway(t);
	const folder = path.join(root, "node_modules", ".pnpm", "package@1.0.0", "node_modules", "package");
	await mkdir(folder, { recursive: true });
	await writeFile(path.join(folder, "index.js"), "export default 42;");
	const filename = "node_modules/.pnpm/package@1.0.0/node_modules/package/index.js";
	const staticResponse = await fetch(`${url}/${filename}`);
	assert.equal(staticResponse.status, 200);
	assert.equal(await staticResponse.text(), "export default 42;");
	const fileResponse = await fetch(`${url}/readFileAsText?fileName=${encodeURIComponent(filename)}`);
	assert.deepEqual(await fileResponse.json(), { success: true, code: 200, data: "export default 42;" });
});

test("read-only filesystem API initializes Noname and excludes secret links", async t => {
	const { url } = await gateway(t);
	for (const [route, data] of [
		["/checkFile?fileName=noname.js", "file"],
		["/checkFile?fileName=missing.js", {}],
		["/checkDir?dir=extension", "directory"],
		["/readFileAsText?fileName=noname.js", "export const game = true;"],
		["/readFile?fileName=noname.js", Array.from(Buffer.from("export const game = true;"))],
		["/getFileList?dir=.", { folders: ["extension"], files: ["index.html", "noname.js"] }],
	]) {
		const response = await fetch(`${url}${route}`);
		assert.equal(response.status, 200, route);
		assert.deepEqual(await response.json(), { success: true, code: 200, data });
	}
	for (const filename of ["../private.json", "outside.json", ".env", "hidden-alias.txt", "/private.json"]) {
		const response = await fetch(`${url}/readFileAsText?fileName=${encodeURIComponent(filename)}`);
		assert.equal(response.status, 403, filename);
		assert.equal((await response.json()).success, false);
	}
	for (const route of ["writeFile", "removeFile", "removeDir", "createDir"]) {
		const response = await fetch(`${url}/${route}`, { method: "POST" });
		assert.equal(response.status, 403, route);
	}
});

test("JSON content type, payload size and snapshot shape are enforced before API calls", async t => {
	const provider = await mockProvider(t, (_req, res) => completion(res, { choice: "pass", advice: "结束出牌。" }));
	const { url } = await gateway(t, { baseUrl: provider.url });
	assert.equal((await post(url, snapshot, { "Content-Type": "text/plain" })).status, 415);
	assert.equal((await post(url, snapshot, { "Content-Encoding": "gzip" })).status, 415);
	assert.equal((await post(url, { ...snapshot, state: { large: "x".repeat(128 * 1024) } })).status, 413);
	for (const body of [
		{ ...snapshot, kind: "evil" },
		{ ...snapshot, candidates: [] },
		{ ...snapshot, candidates: [...snapshot.candidates, snapshot.candidates[0]] },
		{ ...snapshot, state: { a: { b: { c: { d: { e: { f: { g: { h: { i: true } } } } } } } } } },
	]) {
		assert.equal((await post(url, body)).status, 400);
	}
	assert.equal(provider.requests.length, 0);
});

test("parallel requests are limited and the limit is released after completion", async t => {
	const waiting = [];
	let reachedTwo;
	const twoRequests = new Promise(resolve => {
		reachedTwo = resolve;
	});
	const provider = await mockProvider(t, (_req, res) => {
		waiting.push(res);
		if (waiting.length === 2) reachedTwo();
		if (waiting.length > 2) completion(res, { choice: "pass", advice: "结束出牌。" });
	});
	const { url } = await gateway(t, { baseUrl: provider.url });
	const first = post(url);
	const second = post(url);
	await twoRequests;
	const busy = await post(url);
	assert.equal(busy.status, 429);
	assert.equal(busy.headers.get("retry-after"), "1");
	for (const res of waiting) completion(res, { choice: "pass", advice: "结束出牌。" });
	assert.equal((await first).status, 200);
	assert.equal((await second).status, 200);
	assert.equal((await post(url)).status, 200);
});

test("development proxy serves game files without opening write APIs or cross-origin access", async t => {
	let requests = 0;
	const gameServer = http.createServer((_req, res) => {
		requests++;
		res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
		res.end("<title>Noname dev</title>");
	});
	const upstream = await listen(t, gameServer);
	const { url } = await gateway(t, { upstream });
	const response = await fetch(`${url}/index.html`);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Noname dev/);
	assert.equal(response.headers.get("access-control-allow-origin"), null);
	assert.equal((await fetch(`${url}/writeFile`)).status, 403);
	assert.equal((await fetch(`${url}/checkFile?fileName=noname.js`)).status, 200);
	assert.equal(requests, 1);
});

test("external config supports environment overrides and cannot sit in the served root", async t => {
	const { root, directory } = await gameRoot(t);
	const configPath = path.join(directory, "private.json");
	const config = await loadDeepSeekConfiguration(configPath, {});
	assert.equal(config.apiKey, TEST_KEY);
	assert.equal(config.model, "deepseek-flash");
	assert.equal(config.planModel, "deepseek-flash");
	const overridden = await loadDeepSeekConfiguration(configPath, { DEEPSEEK_API_KEY: "override-test-key", DEEPSEEK_MODEL: "deepseek-v4-pro" });
	assert.equal(overridden.apiKey, "override-test-key");
	assert.equal(overridden.model, "deepseek-v4-pro");
	assert.equal(overridden.planModel, "deepseek-v4-pro");
	await writeFile(configPath, JSON.stringify({ apiKey: TEST_KEY, model: "deepseek-flash", planModel: "deepseek-v4-pro" }));
	assert.equal((await loadDeepSeekConfiguration(configPath, {})).planModel, "deepseek-v4-pro");
	const planOverridden = await loadDeepSeekConfiguration(configPath, { DEEPSEEK_PLAN_MODEL: "deepseek-flash" });
	assert.equal(planOverridden.model, "deepseek-flash");
	assert.equal(planOverridden.planModel, "deepseek-flash");
	await writeFile(path.join(root, "config.json"), JSON.stringify({ apiKey: TEST_KEY }));
	await assert.rejects(runCli(["--root", root, "--config", path.join(root, "config.json")]), /目录之外/);
	assert.throws(
		() => createDeepSeekServer({ apiKey: "key\nsecret" }),
		error => !error.message.includes("secret")
	);
	assert.throws(() => createDeepSeekServer({ planModel: "invalid\nmodel" }), /配置格式无效/);
});
