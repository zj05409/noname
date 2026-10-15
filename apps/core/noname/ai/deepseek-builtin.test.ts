import assert from "node:assert/strict";
import test from "node:test";
import { markBuiltinDecision, recordCompletedBuiltinDecision } from "./deepseek-builtin";

function fixture(result: any = { bool: true, cards: [], targets: [] }) {
	const player = { playerid: "cpu" };
	const event: any = { player, result, isMine: () => false, isOnline: () => false };
	const engine: any = { game: { me: { playerid: "human" }, online: false }, status: { video: false, connectMode: false } };
	return { event, engine };
}

test("only completed builtin outcomes are observed once without changing their results", () => {
	for (const result of [
		{ bool: false, confirm: "cancel" },
		{ cards: [{ cardid: "card" }], targets: [{ playerid: "target" }], bool: true },
		{ control: "选项二", index: 1 },
		{ bool: true, skill: "longdan", card: { name: "shan" }, used: "longdan" },
	]) {
		const { event, engine } = fixture(result);
		const original = JSON.stringify(result);
		let calls = 0;
		const record = (observed: any) => {
			calls++;
			assert.equal(observed.result, result);
		};
		assert.equal(recordCompletedBuiltinDecision(event, engine, record), false);
		markBuiltinDecision(event);
		assert.equal(recordCompletedBuiltinDecision(event, engine, record), true);
		assert.equal(recordCompletedBuiltinDecision(event, engine, record), false);
		assert.equal(calls, 1);
		assert.equal(JSON.stringify(result), original);
	}
});

test("retrying selections wait for the final result and can become DeepSeek-handled", () => {
	const { event, engine } = fixture("ai");
	let calls = 0;
	const record = () => {
		calls++;
	};
	markBuiltinDecision(event);
	assert.equal(recordCompletedBuiltinDecision(event, engine, record), false);
	event.result = { bool: true, cancel: true, skill: "backup" };
	assert.equal(recordCompletedBuiltinDecision(event, engine, record), false);
	event.result = { bool: true, cards: [{ cardid: "final" }] };
	assert.equal(recordCompletedBuiltinDecision(event, engine, record), true);
	assert.equal(calls, 1);
	const next = fixture();
	markBuiltinDecision(next.event);
	markBuiltinDecision(next.event, false);
	assert.equal(recordCompletedBuiltinDecision(next.event, next.engine, record), false);
	assert.equal(calls, 1);
});

test("human, online, connect-mode and replay outcomes are excluded", () => {
	for (const condition of ["humanSeat", "mine", "onlineSeat", "onlineGame", "connect", "replay"]) {
		const { event, engine } = fixture();
		if (condition === "humanSeat") engine.game.me = event.player;
		if (condition === "mine") event.isMine = () => true;
		if (condition === "onlineSeat") event.isOnline = () => true;
		if (condition === "onlineGame") engine.game.online = true;
		if (condition === "connect") engine.status.connectMode = true;
		if (condition === "replay") engine.status.video = true;
		markBuiltinDecision(event);
		let calls = 0;
		assert.equal(
			recordCompletedBuiltinDecision(event, engine, () => {
				calls++;
			}),
			false,
			condition
		);
		assert.equal(calls, 0);
	}
});

test("a failing recorder cannot throw into the game or change its result", () => {
	const { event, engine } = fixture();
	markBuiltinDecision(event);
	assert.equal(
		recordCompletedBuiltinDecision(event, engine, () => {
			throw new Error("quota");
		}),
		false
	);
	assert.equal(event.result.bool, true);
	assert.equal(
		recordCompletedBuiltinDecision(event, engine, () => {
			throw new Error("must not retry");
		}),
		false
	);
});
