import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekMatchMemory, installStrategicObserver } from "./deepseek-strategy";

function fixture() {
	const self = { playerid: "self" }, other = { playerid: "other" };
	const engine: any = {
		game: { players: [self, other], dead: [], me: self, roundNumber: 1, phaseNumber: 1, addGlobalSkill() {} },
		get: { name: (card: any) => card.name },
		lib: { skill: {} }, status: { currentPhase: self, connectMode: false },
	};
	return { engine, self, other, memory: new DeepSeekMatchMemory(engine) };
}

test("plans persist across reactions and refresh on the actor's next turn", () => {
	const { engine, self, other, memory } = fixture();
	assert.equal(memory.context(self).needsTurnPlan, true);
	memory.remember(self, { plan: "保留桃，优先保护主公", memory: "other 曾对主公使用杀" });
	assert.equal(memory.context(self).needsTurnPlan, false);
	engine.game.phaseNumber++; engine.status.currentPhase = other;
	assert.equal(memory.context(self).needsTurnPlan, false);
	assert.equal(memory.context(other).needsTurnPlan, true);
	engine.game.phaseNumber++; engine.status.currentPhase = self;
	assert.equal(memory.context(self).needsTurnPlan, true);
	assert.equal(memory.context(self).memory, "other 曾对主公使用杀");
});

test("identity hypotheses are separate per actor and never read hidden role truth", () => {
	const { self, other, memory } = fixture();
	Object.defineProperty(other, "identity", { get() { throw new Error("hidden role read"); } });
	memory.remember(self, { identityBeliefs: [
		{ id: "other", role: "fan", confidence: 0.7, reason: "攻击主公" },
		{ id: "missing", role: "nei", confidence: 1, reason: "invalid" },
		{ id: "other", role: "invalid", confidence: 1, reason: "invalid" },
	] });
	assert.deepEqual(memory.context(self).identityBeliefs, [{ id: "other", role: "fan", confidence: 0.7, reason: "攻击主公" }]);
	assert.deepEqual(memory.context(other).identityBeliefs, []);
});

test("public gain history contains counts without concealed card names and deduplicates triggers", () => {
	const { self, memory } = fixture();
	const gain = { player: self, cards: [{ name: "tao" }, { name: "wuxie" }] };
	memory.observe("gainAfter", gain); memory.observe("gainAfter", gain);
	const context = memory.context(self);
	assert.equal(context.actionsObserved, 1);
	assert.equal(context.recentActions[0].amount, 2);
	assert.equal(JSON.stringify(context.recentActions).includes("wuxie"), false);
	assert.equal(context.playerTrends[0].draws, 2);
});

test("older actions remain represented by aggregate interaction trends", () => {
	const { self, memory } = fixture();
	for (let n = 0; n < 160; n++) memory.record({ kind: "damage", source: "self", targets: ["other"], amount: 1 });
	const context = memory.context(self);
	assert.equal(context.recentActions.length, 64);
	assert.equal(context.actionsObserved, 160);
	assert.equal(context.playerTrends[0].damage.other, 160);
});

test("observer runs only once via the local player and skips multiplayer", async () => {
	const { engine, self, other, memory } = fixture();
	let added = ""; engine.game.addGlobalSkill = (name: string) => { added = name; };
	installStrategicObserver(engine, memory);
	const skill = engine.lib.skill[added];
	assert.equal(skill.filter({}, self), true);
	assert.equal(skill.filter({}, other), false);
	engine.status.connectMode = true;
	assert.equal(skill.filter({}, self), false);
	engine.status.connectMode = false;
	await skill.content({ triggername: "useCardAfter" }, { player: self, card: { name: "sha" }, targets: [other] }, self);
	assert.equal(memory.context(self).recentActions[0].card, "sha");
});

test("new-match reset drops all past beliefs and strategic plans", () => {
	const { self, memory } = fixture();
	memory.setOmniscient(false); memory.remember(self, { plan: "控场" });
	memory.record({ kind: "turnBegin", actor: "self" }); memory.clear();
	assert.equal(memory.context(self).needsTurnPlan, true);
	assert.equal(memory.context(self).actionsObserved, 0);
	assert.equal(memory.context(self).knowledgeMode, "known");
});

test("switching hand knowledge discards privileged plans and beliefs but preserves public history", () => {
	const { self, memory } = fixture();
	memory.remember(self, { plan: "other 手握两桃", memory: "other 私有手牌含无懈", identityBeliefs: [{ id: "other", role: "fan", confidence: 0.6, reason: "全知信息" }] });
	memory.record({ kind: "useCard", actor: "other", card: "sha", targets: ["self"] });
	memory.setOmniscient(false);
	const context = memory.context(self);
	assert.equal(context.plan, "");
	assert.equal(context.memory, "");
	assert.deepEqual(context.identityBeliefs, []);
	assert.equal(context.needsTurnPlan, true);
	assert.equal(context.recentActions[0].card, "sha");
});
