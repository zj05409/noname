import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekMatchRecorder, IndexedDBMatchRecordStore, MemoryMatchRecordStore, sanitizeRecordData, summarizeRecordUsage, type MatchRecordStore } from "./deepseek-recorder";

function fixture({ initialized = true, existing = [] as any[] } = {}) {
	let time = 1000;
	let ids = 0;
	const cpu: any = {
		playerid: "cpu",
		name: "曹操",
		dataset: { position: "0" },
		getCards() {
			return [];
		},
	};
	const human: any = {
		playerid: "human",
		name: "刘备",
		dataset: { position: "1" },
		getCards() {
			return [];
		},
	};
	const lib: any = { config: { mode: "identity" }, video: existing, onover: [] };
	const status: any = { video: false, videoInited: initialized, event: { name: "chooseToUse", player: cpu }, currentPhase: cpu };
	const game: any = {
		players: [cpu, human],
		dead: [],
		me: human,
		roundNumber: 1,
		phaseNumber: 2,
		online: false,
		getVideoName() {
			return ["测试牌局", "身份模式"];
		},
		addVideo(type: string, player: any, content: unknown) {
			if (status.video || game.online || (!status.videoInited && type !== "arrangeLib")) return;
			lib.video.push({ type, player: player?.dataset?.position ?? player, content, delay: 10 });
			if (type === "init") game.addVideo("cardtag", null, { sha: "tag" });
		},
	};
	const engine = {
		game,
		lib,
		get: {
			translation(value: any) {
				return String(value);
			},
		},
		status,
	};
	const store = new MemoryMatchRecordStore();
	const recorder = new DeepSeekMatchRecorder(engine, store, { now: () => time, createId: () => `match-${++ids}`, debounceMs: 10000 });
	return {
		engine,
		recorder,
		store,
		cpu,
		human,
		advance(ms = 10) {
			time += ms;
		},
	};
}

test("install captures existing video and recursive init exactly once without a 128-event cap", async () => {
	const { engine, recorder, store } = fixture({ existing: [{ type: "arrangeLib", player: null, content: { card: {} }, delay: 0 }] });
	recorder.install().install();
	assert.equal(engine.lib.onover.length, 1);
	engine.game.addVideo("init", null, [{ name: "caocao", identity: "fan", position: "0" }]);
	for (let index = 0; index < 600; index++) engine.game.addVideo("log", null, `action-${index}`);
	assert.equal(recorder.current()!.video.length, 603);
	assert.deepEqual(
		recorder
			.current()!
			.video.map(event => event.type)
			.slice(0, 3),
		["arrangeLib", "init", "cardtag"]
	);
	assert.equal((recorder.current()!.video[1].content as any)[0].identity, "fan");
	assert.deepEqual(recorder.current()!.players, [
		{ id: "cpu", position: "0", name: "曹操", human: false },
		{ id: "human", position: "1", name: "刘备", human: true },
	]);
	await recorder.flush();
	assert.equal((await store.get(recorder.current()!.id))!.video.length, 603);
});

test("trace timestamps, actor IDs, rounds and native cursor boundaries remain stable", async () => {
	const { engine, recorder, advance } = fixture();
	recorder.install();
	engine.game.addVideo("init", null, []);
	advance(40);
	recorder.append({ type: "ai_request", stage: "start", requestId: "request-1", actorId: "cpu", input: { kind: "decision", player: { id: "cpu" }, state: {}, candidates: [] } });
	const first = recorder.current()!.decisions[0];
	assert.equal(first.sequence, 1);
	assert.equal(first.timestamp, 1040);
	assert.equal(first.elapsedMs, 40);
	assert.equal(first.actor, "cpu");
	assert.equal(first.videoCursor, 2);
	assert.equal(first.videoIndex, 1);
	assert.equal(first.videoTimeMs, 20);
	engine.game.addVideo("log", null, "play sha");
	engine.status.event.player = undefined;
	engine.game.roundNumber = 2;
	advance(30);
	recorder.append({ type: "ai_request", stage: "error", requestId: "request-1", actorId: "human", kind: "advice", error: { code: "timeout", message: "超时" }, durationMs: 30, stale: true, cancelled: true });
	const second = recorder.current()!.decisions[1];
	assert.equal(second.sequence, 2);
	assert.equal(second.actor, "human");
	assert.equal(second.round, 2);
	assert.equal(second.videoCursor, 3);
	assert.equal(first.videoCursor, 2);
	assert.equal(second.stale, true);
	assert.equal(second.cancelled, true);
	assert.equal(second.traceId, `${recorder.current()!.id}:trace-2`);
	await recorder.flush();
});

test("JSON traces redact credentials and omit raw runtime, accessor and circular objects", async () => {
	const { recorder, cpu } = fixture();
	recorder.install();
	const circular: any = { action: "safe" };
	circular.self = circular;
	const input: any = { kind: "advice", player: { id: "human" }, apiKey: "private-api-value", headers: { authorization: "Bearer private-auth-value" }, token: "private-token-value", password: "private-password-value" };
	Object.defineProperty(input, "accessor", {
		enumerable: true,
		get() {
			throw new Error("must not execute");
		},
	});
	recorder.append({ input, actor: cpu, rawPlayer: cpu, rawEvent: { getParent() {}, next: circular }, node: { nodeType: 1, textContent: "private-node-value" }, circular, error: new Error("Bearer credential-value apiKey=another-private-value sk-abcdefgh12345678") });
	const record = await recorder.exportRecord(recorder.current()!.id);
	const text = JSON.stringify(record);
	for (const privateValue of ["private-api-value", "private-auth-value", "private-token-value", "private-password-value", "private-node-value", "credential-value", "another-private-value", "sk-abcdefgh12345678"]) assert.ok(!text.includes(privateValue), privateValue);
	assert.match(text, /redacted/);
	assert.match(text, /runtime object/);
	assert.match(text, /circular reference/);
	assert.equal((record.decisions[0].input as any).player.id, "human");
	assert.equal(record.decisions[0].actor, "cpu");
	assert.equal(JSON.stringify(sanitizeRecordData({ safe: "plain", f() {}, unsafe: undefined })), '{"safe":"plain"}');
	await recorder.flush();
});

test("records persist across recorder instances and loaded/exported arrays are detached", async () => {
	const { recorder, store, engine } = fixture();
	recorder.install();
	engine.game.addVideo("init", null, []);
	recorder.append({ kind: "decision", stage: "complete", result: { choice: "pass", source: "deepseek", model: "deepseek-flash", advice: "结束出牌。" } });
	await recorder.flush();
	const id = recorder.current()!.id;
	const refreshed = new DeepSeekMatchRecorder({ game: {}, lib: {}, get: {}, status: {} }, store);
	assert.equal((await refreshed.listRecords())[0].id, id);
	const loaded = await refreshed.loadRecord(id);
	assert.equal((loaded.decisions[0].result as any).choice, "pass");
	loaded.video.shift();
	loaded.decisions.length = 0;
	const reloaded = await refreshed.exportRecord(id);
	assert.equal(reloaded.video.length, 2);
	assert.equal(reloaded.decisions.length, 1);
});

test("over finalizes and saves the complete native stream independently of replay settings", async () => {
	const { recorder, engine, store, advance } = fixture();
	engine.lib.config.video = 0;
	recorder.install();
	engine.game.addVideo("init", null, []);
	advance(500);
	engine.game.addVideo("over", null, "战斗胜利");
	engine.lib.onover[0](true);
	await recorder.flush();
	const saved = (await store.get(recorder.current()!.id))!;
	assert.equal(saved.endedAt, 1500);
	assert.equal(saved.video.at(-1)!.type, "over");
	assert.deepEqual(saved.videoName, ["测试牌局", "身份模式"]);
});

test("replaying and online games never append new match events or AI traces", async () => {
	const { recorder, engine } = fixture();
	recorder.install();
	engine.game.addVideo("init", null, []);
	const record = recorder.current()!;
	engine.status.video = true;
	engine.lib.video.push({ type: "log", content: "replay", delay: 1 });
	engine.game.addVideo("log", null, "replay");
	recorder.append({ kind: "advice", result: "replay" });
	assert.equal(recorder.startMatch(), null);
	engine.lib.onover[0](true);
	assert.equal(record.video.length, 2);
	assert.equal(record.decisions.length, 0);
	assert.equal(record.endedAt, undefined);
	await recorder.flush();
	assert.equal(record.video.length, 2);
	const online = fixture();
	online.engine.game.online = true;
	online.recorder.install();
	online.recorder.append({ input: {} });
	assert.equal(online.recorder.current(), null);
});

test("direct video pushes are captured on flush and new streams do not mix matches", async () => {
	const { recorder, engine, store, advance } = fixture();
	recorder.install();
	const first = recorder.current()!;
	engine.lib.video.push({ type: "log", content: "direct", delay: 5 });
	await recorder.flush();
	assert.equal((await store.get(first.id))!.video.length, 1);
	advance(20);
	engine.lib.video = [{ type: "init", content: [], delay: 0 }];
	const second = recorder.current()!;
	assert.notEqual(second.id, first.id);
	assert.equal(second.video.length, 1);
	assert.equal(first.video.length, 1);
	await recorder.flush();
	assert.equal((await store.get(first.id))!.endedAt, 1020);
});

test("retention keeps the active match while removing oldest completed records", async () => {
	const { engine, store, advance } = fixture();
	let ids = 0;
	const recorder = new DeepSeekMatchRecorder(engine, store, { now: () => 1000 + ids, createId: () => `retention-${++ids}`, maxRecords: 2, debounceMs: 10000 });
	recorder.install();
	for (let index = 0; index < 4; index++) {
		if (index) engine.lib.video = [];
		advance();
		recorder.startMatch();
		engine.game.addVideo("log", null, `match-${index}`);
		await recorder.flush();
	}
	const records = await recorder.listRecords();
	assert.equal(records.length, 2);
	assert.ok(records.some(record => record.id === recorder.current()!.id));
	assert.equal(await store.get("retention-1"), undefined);
});

test("serialized writes never overwrite a newer request trace with an older snapshot", async () => {
	const { engine } = fixture();
	const memory = new MemoryMatchRecordStore();
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>(resolve => {
		entered = resolve;
	});
	let blocked = true;
	const store: MatchRecordStore = {
		async put(record) {
			if (blocked) {
				blocked = false;
				entered();
				await gate;
			}
			await memory.put(record);
		},
		get: id => memory.get(id),
		list: () => memory.list(),
		delete: id => memory.delete(id),
	};
	const recorder = new DeepSeekMatchRecorder(engine, store, { debounceMs: 10000 });
	recorder.install();
	recorder.append({ stage: "start", requestId: "r1" });
	const first = recorder.flush();
	await started;
	recorder.append({ stage: "complete", requestId: "r1", result: { choice: "pass" } });
	const second = recorder.flush();
	release();
	await Promise.all([first, second]);
	assert.deepEqual(
		(await memory.get(recorder.current()!.id))!.decisions.map(entry => entry.stage),
		["start", "complete"]
	);
});

test("storage failures keep recording usable and expose only a safe error", async () => {
	const { engine } = fixture();
	const fail = async () => {
		throw new Error("private-storage-credential sk-abcdefghijklmnop");
	};
	const recorder = new DeepSeekMatchRecorder(engine, { put: fail, get: fail, list: fail, delete: fail }, { debounceMs: 10000 });
	recorder.install();
	engine.game.addVideo("init", null, []);
	recorder.append({ stage: "error", error: { code: "timeout" } });
	await recorder.flush();
	assert.match(recorder.lastError!, /未能保存/);
	assert.ok(!recorder.lastError!.includes("private-storage-credential"));
	assert.equal((await recorder.listRecords()).length, 1);
	assert.equal((await recorder.exportRecord(recorder.current()!.id)).decisions.length, 1);
	await assert.rejects(recorder.loadRecord("missing"), /牌局记录/);
	await assert.rejects(new IndexedDBMatchRecordStore(undefined).list(), /unavailable/);
});

test("imports are validated, redacted and separated from the currently active match", async () => {
	const { recorder, store } = fixture();
	recorder.install();
	recorder.append({ input: { kind: "advice" }, error: { code: "timeout" } });
	const exported = await recorder.exportRecord(recorder.current()!.id);
	const imported = await recorder.importRecord({ ...exported, apiKey: "private-import-value" });
	assert.notEqual(imported.id, recorder.current()!.id);
	assert.equal(imported.decisions[0].recordId, imported.id);
	assert.ok(!JSON.stringify(imported).includes("private-import-value"));
	assert.equal((await store.get(imported.id))!.decisions.length, 1);
	await assert.rejects(recorder.importRecord({ ...exported, version: 2 }), /格式无效/);
	await assert.rejects(recorder.importRecord({ ...exported, video: [null] }), /格式无效/);
	await recorder.flush();
});

test("actual token usage is deduplicated and missing usage stays unknown", async () => {
	const { recorder } = fixture();
	recorder.install();
	const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheHitTokens: 60, cacheMissTokens: 40 };
	recorder.append({ type: "ai_request", stage: "start", requestId: "cpu-1", kind: "decision" });
	recorder.append({ type: "ai_request", stage: "complete", requestId: "cpu-1", kind: "decision", result: { usage } });
	recorder.append({ type: "ai_request", stage: "complete", requestId: "cpu-1", kind: "decision", result: { usage } });
	recorder.append({ type: "ai_outcome", requestId: "cpu-1", kind: "decision", result: { usage } });
	recorder.append({ type: "ai_request", stage: "error", requestId: "advice-1", kind: "advice", error: { code: "invalid_choice", usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } } });
	recorder.append({ type: "ai_request", stage: "error", requestId: "cpu-2", kind: "plan", error: { code: "timeout" } });
	recorder.append({ type: "ai_request", stage: "start", requestId: "advice-2", kind: "advice" });
	const result = summarizeRecordUsage(recorder.current()!);
	assert.equal(result.requestCount, 4);
	assert.equal(result.knownUsageCount, 2);
	assert.equal(result.unknownUsageCount, 2);
	assert.equal(result.totalTokens, 180);
	assert.equal(result.promptTokens, 150);
	assert.equal(result.cacheHitTokens, 60);
	assert.equal(result.cpu.totalTokens, 120);
	assert.equal(result.cpu.unknownUsageCount, 1);
	assert.equal(result.advice.totalTokens, 60);
	assert.equal(result.advice.unknownUsageCount, 1);
	assert.equal(summarizeRecordUsage({ ...recorder.current()!, decisions: [recorder.current()!.decisions.at(-1)!] }).totalTokens, null);
	await recorder.flush();
});
