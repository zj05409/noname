import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekPolicy } from "./deepseek-policy";

class Classes {
	private values = new Set<string>();
	add(...names: string[]) {
		names.forEach(name => this.values.add(name));
	}
	remove(...names: string[]) {
		names.forEach(name => this.values.delete(name));
	}
	contains(name: string) {
		return this.values.has(name);
	}
	toggle(name: string, value: boolean) {
		value ? this.add(name) : this.remove(name);
	}
}

function fixture({ human = false, forced = false, allTargets = false } = {}) {
	const card: any = { cardid: "card-1", name: "sha", suit: "spade", number: 7, classList: new Classes(), updateTransform() {} };
	const hiddenCard: any = { cardid: "secret-card", name: "tao", suit: "heart", number: 8, classList: new Classes() };
	function player(id: string, cards: any[], identity: string): any {
		return {
			playerid: id,
			name: id,
			identity,
			identityShown: false,
			hp: 4,
			maxHp: 4,
			classList: new Classes(),
			getCards(position = "h") {
				return position.includes("h") ? cards : [];
			},
			countCards() {
				return cards.length;
			},
			getSkills() {
				return [];
			},
			isUnseen() {
				return false;
			},
		};
	}
	const cpu = player("cpu", [card], "fan");
	const opponent = player("opponent", [hiddenCard], "nei");
	const ui: any = { selected: { cards: [], targets: [], buttons: [] }, click: {} };
	const status: any = { connectMode: false, imchoosing: false, currentPhase: cpu, event: undefined };
	const lib: any = { config: { auto_confirm: true, mode: "identity" }, translate: { sha_info: "对一名其他角色造成一点伤害" } };
	let legal = true,
		commits = 0,
		cancels = 0;
	const get: any = {
		translation(value: any) {
			return typeof value === "string" ? value : value.name;
		},
		name(value: any) {
			return value.name;
		},
		suit(value: any) {
			return value.suit;
		},
		number(value: any) {
			return value.number;
		},
		nature() {
			return "";
		},
		select(value: any) {
			return typeof value === "function" ? value() : Array.isArray(value) ? value : [value ?? 1, value ?? 1];
		},
		info() {
			return {};
		},
		card() {
			return ui.selected.cards[0];
		},
		skillInfoTranslation() {
			return "";
		},
	};
	const event: any = {
		name: "chooseToUse",
		type: "phase",
		result: human ? undefined : "ai",
		player: cpu,
		position: "h",
		forced,
		selectCard: [1, 1],
		selectTarget: allTargets ? [-1, -1] : [1, 1],
		filterCard: () => legal,
		filterTarget: (_card: any, _actor: any, target: any) => target !== cpu,
		isMine: () => human,
		isOnline: () => false,
		step: 1,
	};
	status.event = event;
	const game: any = {
		players: [cpu, opponent],
		dead: [],
		me: human ? cpu : opponent,
		roundNumber: 1,
		check() {
			card.classList.toggle("selectable", (legal && ui.selected.cards.length === 0) || ui.selected.cards.includes(card));
			const hasCard = ui.selected.cards.length === 1;
			for (const target of game.players) {
				const allowed = hasCard && event.filterTarget(card, cpu, target);
				if (allTargets) {
					if (allowed && !ui.selected.targets.includes(target)) ui.selected.targets.push(target);
					target.classList.toggle("selected", allowed);
				}
				target.classList.toggle("selectable", (allowed && (allTargets || ui.selected.targets.length === 0)) || ui.selected.targets.includes(target));
			}
			return hasCard && ui.selected.targets.length > 0;
		},
	};
	ui.click.ok = () => {
		commits++;
		event.result = { bool: true, cards: ui.selected.cards.slice(), targets: ui.selected.targets.slice() };
		ui.selected.cards.length = 0;
		ui.selected.targets.length = 0;
	};
	ui.click.cancel = () => {
		cancels++;
		event.result = { bool: false };
	};
	return {
		engine: { game, get, lib, ui, status, ai: undefined as any },
		cpu,
		opponent,
		card,
		hiddenCard,
		event,
		setLegal: (value: boolean) => {
			legal = value;
		},
		commits: () => commits,
		cancels: () => cancels,
	};
}

function policyFor(f: ReturnType<typeof fixture>, request: any, enabled: any, report: any) {
	return new DeepSeekPolicy(
		f.engine,
		async packet => {
			if (packet.kind === "plan") return { choice: null, advice: "测试回合计划", source: "deepseek", plan: "测试回合计划" };
			return request(packet);
		},
		enabled,
		report
	);
}

test("CPU commits only a legal physical card and target through the normal confirmation", async () => {
	const f = fixture();
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.equal(packet.kind, "decision");
			const play = packet.candidates.find((candidate: any) => candidate.id.startsWith("move-"));
			assert.deepEqual(play.targets, ["opponent"]);
			assert.equal(play.cards[0].rules, "对一名其他角色造成一点伤害");
			return { choice: play.id, advice: "使用杀", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.equal(f.commits(), 1);
	assert.deepEqual(f.event.result.cards, [f.card]);
	assert.deepEqual(f.event.result.targets, [f.opponent]);
});

test("all-target cards preserve the engine's complete automatic target set", async () => {
	const f = fixture({ allTargets: true });
	const policy = policyFor(
		f,
		async () => ({ choice: "move-0", advice: "群体牌", source: "deepseek" }),
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(f.event.result.targets, [f.opponent]);
});

test("card and response prompts support targetless physical cards", async () => {
	for (const name of ["chooseCard", "chooseToRespond"]) {
		const f = fixture();
		f.event.name = name;
		delete f.event.filterTarget;
		f.engine.game.check = () => {
			f.card.classList.toggle("selectable", !f.engine.ui.selected.cards.length || f.engine.ui.selected.cards.includes(f.card));
			return f.engine.ui.selected.cards.length === 1;
		};
		const policy = policyFor(
			f,
			async () => ({ choice: "move-0", advice: "", source: "deepseek" }),
			() => true,
			() => {}
		);
		assert.equal(await policy.decide(f.event), true);
		assert.deepEqual(f.event.result.cards, [f.card]);
		assert.deepEqual(f.event.result.targets, []);
	}
});

test("target-only prompts choose from currently selectable targets", async () => {
	const f = fixture();
	f.event.name = "chooseTarget";
	delete f.event.filterCard;
	f.engine.game.check = () => {
		for (const target of f.engine.game.players) {
			target.classList.toggle("selectable", target !== f.cpu && (!f.engine.ui.selected.targets.length || f.engine.ui.selected.targets.includes(target)));
		}
		return f.engine.ui.selected.targets.length === 1;
	};
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.deepEqual(packet.candidates[0].targets, ["opponent"]);
			return { choice: "move-0", advice: "", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(f.event.result.cards, []);
	assert.deepEqual(f.event.result.targets, [f.opponent]);
});

test("invented choices and builtin choices fall back without committing", async () => {
	for (const choice of ["invented", "builtin", null]) {
		const f = fixture();
		const policy = policyFor(
			f,
			async () => ({ choice, advice: "", source: "deepseek" }),
			() => true,
			() => {}
		);
		assert.equal(await policy.decide(f.event), false);
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
		assert.equal(f.event.result, "ai");
	}
});

test("forced prompts never expose or accept a cancellation", async () => {
	const f = fixture({ forced: true });
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.equal(
				packet.candidates.some((candidate: any) => candidate.id === "cancel"),
				false
			);
			return { choice: "cancel", advice: "", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(f.cancels(), 0);
});

test("optional prompts allow the model to decline", async () => {
	const f = fixture();
	const policy = policyFor(
		f,
		async () => ({ choice: "cancel", advice: "留牌", source: "deepseek" }),
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.equal(f.cancels(), 1);
});

test("state changes, event replacement, and disabling during the request reject stale answers", async () => {
	for (const change of ["hp", "event", "enabled"]) {
		const f = fixture();
		let enabled = true;
		const policy = policyFor(
			f,
			async () => {
				if (change === "hp") f.cpu.hp--;
				if (change === "event") f.engine.status.event = {};
				if (change === "enabled") enabled = false;
				return { choice: "move-0", advice: "", source: "deepseek" };
			},
			() => enabled,
			() => {}
		);
		assert.equal(await policy.decide(f.event), false);
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
	}
});

test("legality is checked afresh even when public state is unchanged", async () => {
	const f = fixture();
	const policy = policyFor(
		f,
		async () => {
			f.setLegal(false);
			return { choice: "move-0", advice: "", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(f.commits(), 0);
});

test("advice restores the human's selections before awaiting and never executes a move", async () => {
	const f = fixture({ human: true });
	f.engine.ui.selected.cards.push(f.card);
	f.engine.ui.selected.targets.push(f.opponent);
	f.card.classList.add("selected");
	f.opponent.classList.add("selected");
	const originalCheck = f.engine.game.check;
	f.engine.game.check = () => {
		const ok = originalCheck();
		// The engine can also auto-confirm direct skills when auto_confirm is false.
		if (ok && !f.engine.status.touchnocheck) f.engine.ui.click.ok();
		return ok;
	};
	const messages: string[] = [];
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.equal(packet.kind, "advice");
			assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
			assert.deepEqual(f.engine.ui.selected.targets, [f.opponent]);
			assert.equal(f.engine.lib.config.auto_confirm, true);
			assert.equal(f.engine.status.touchnocheck, undefined);
			return { choice: "move-0", advice: "可以使用杀", source: "deepseek" };
		},
		() => true,
		text => messages.push(text)
	);
	await policy.advise();
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
	assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
	assert.deepEqual(f.engine.ui.selected.targets, [f.opponent]);
	assert.match(messages.at(-1) || "", /可以使用杀/);
});

test("snapshots conceal opponents' hands, roles and unseen generals", () => {
	const f = fixture();
	f.opponent.isUnseen = () => true;
	const policy = policyFor(
		f,
		async () => {
			throw new Error();
		},
		() => true,
		() => {}
	);
	policy.matchMemory.setOmniscient(false);
	const state = policy.snapshot(f.cpu);
	const opponent = state.players.find((player: any) => player.id === "opponent");
	assert.equal(opponent.role, "未知身份");
	assert.equal(opponent.name, "未亮明武将");
	assert.equal(opponent.handCount, 1);
	assert.equal(JSON.stringify(state).includes("secret-card"), false);
	assert.equal(JSON.stringify(state).includes('"nei'), false);
	f.opponent.identityShown = true;
	assert.equal(policy.snapshot(f.cpu).players[1].role, "nei2");
});

test("network failures restore settings and return control to built-in AI", async () => {
	const f = fixture();
	const policy = policyFor(
		f,
		async () => {
			throw new Error("timeout");
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(f.engine.lib.config.auto_confirm, true);
	assert.equal(f.engine.status.touchnocheck, undefined);
	assert.equal(f.event.result, "ai");
	assert.equal(f.commits(), 0);
});

test("humans, multiplayer, skills and complex prompts bypass computer requests", async () => {
	for (const kind of ["human", "online", "skill", "complex", "processAI"]) {
		const f = fixture({ human: kind === "human" });
		if (kind === "online") f.engine.status.connectMode = true;
		if (kind === "skill") f.event.skill = "test_skill";
		if (kind === "complex") f.event.complexSelect = true;
		if (kind === "processAI") f.event.processAI = () => ({});
		const policy = policyFor(
			f,
			async () => {
				assert.fail("request must not happen");
			},
			() => true,
			() => {}
		);
		assert.equal(await policy.decide(f.event), false);
	}
});

test("the global disabled switch prevents computer, planning, and human-advice API calls", async () => {
	for (const human of [false, true]) {
		const f = fixture({ human });
		let requests = 0;
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				requests++;
				throw new Error("must stay offline");
			},
			() => false,
			() => {}
		);
		assert.equal(await policy.decide(f.event), false);
		await policy.planTurn(f.cpu);
		await policy.advise();
		assert.equal(requests, 0);
		assert.equal(f.commits(), 0);
	}
});

test("planning precedes a decision and carries history, hypotheses and strategic memory", async () => {
	const f = fixture();
	const kinds: string[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			kinds.push(packet.kind);
			assert.equal(packet.state.knowledgeMode, "known");
			assert.deepEqual(packet.state.players[1].hand, []);
			assert.equal(packet.state.players[1].role, "未知身份");
			assert.equal(packet.state.recentActions[0].kind, "damage");
			if (packet.kind === "plan") {
				assert.deepEqual(packet.candidates, []);
				return { choice: null, advice: "保留桃", plan: "本回合先压制对手，再保留桃自救", memory: "对手攻击过我", source: "deepseek", identityBeliefs: [{ id: "opponent", role: "unknown", confidence: 0.4, reason: "信息不足" }] };
			}
			assert.match(packet.state.plan, /保留桃/);
			assert.equal(packet.state.memory, "对手攻击过我");
			assert.equal(packet.state.identityBeliefs[0].confidence, 0.4);
			return { choice: "move-0", advice: "作为反贼我先出杀", source: "deepseek", memory: "已计划施压" };
		},
		() => true,
		text => messages.push(text)
	);
	policy.matchMemory.record({ kind: "damage", source: "opponent", targets: ["cpu"], amount: 1 });
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(kinds, ["plan", "decision"]);
	assert.equal(policy.matchMemory.context(f.cpu).memory, "已计划施压");
	assert.equal(policy.matchMemory.context(f.cpu).needsTurnPlan, false);
	assert.equal(
		messages.some(message => message.includes("作为反贼")),
		false
	);
});

test("disabling during turn planning prevents the subsequent decision request", async () => {
	const f = fixture();
	let enabled = true,
		requests = 0;
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			requests++;
			assert.equal(packet.kind, "plan");
			enabled = false;
			return { choice: null, advice: "规划", plan: "规划", source: "deepseek" };
		},
		() => enabled,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(requests, 1);
	assert.equal(f.commits(), 0);
});

test("bounded multi-card discard candidates enumerate legal subsets and respect forced counts", async () => {
	const f = fixture({ forced: true });
	const second = { ...f.card, cardid: "card-2", name: "shan", classList: new Classes() };
	const third = { ...f.card, cardid: "card-3", name: "tao", classList: new Classes() };
	f.cpu.getCards("h").push(second, third);
	f.event.name = "chooseToDiscard";
	f.event.selectCard = [2, 2];
	delete f.event.filterTarget;
	f.engine.game.check = () => {
		const selected = f.engine.ui.selected.cards;
		for (const card of f.cpu.getCards("h")) card.classList.toggle("selectable", selected.length < 2 || selected.includes(card));
		return selected.length === 2;
	};
	const policy = policyFor(
		f,
		async (packet: any) => {
			const actions = packet.candidates.filter((candidate: any) => candidate.id.startsWith("move-"));
			assert.equal(actions.length, 3);
			assert.equal(
				actions.every((candidate: any) => candidate.cards.length === 2),
				true
			);
			assert.equal(
				packet.candidates.some((candidate: any) => candidate.id === "cancel"),
				false
			);
			const preservePeach = actions.find((candidate: any) => candidate.cards.every((card: any) => card.name !== "tao"));
			return { choice: preservePeach.id, advice: "保留桃自救", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(f.event.result.cards, [f.card, second]);
});

test("large required subsets fall back instead of blocking the game with unbounded enumeration", async () => {
	const f = fixture({ forced: true });
	f.event.name = "chooseToDiscard";
	f.event.selectCard = [5, 5];
	delete f.event.filterTarget;
	let requests = 0;
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			requests++;
			throw new Error("unsupported");
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(requests, 0);
	assert.equal(f.engine.lib.config.auto_confirm, true);
});

test("boolean and control decisions preserve the game's result contracts", async () => {
	for (const name of ["chooseBool", "chooseControl"]) {
		const f = fixture();
		f.event.name = name;
		f.event.prompt = "请选择";
		f.event.controls = ["draw_card", "recover_hp", "cancel2"];
		delete f.event.filterCard;
		delete f.event.filterTarget;
		const policy = policyFor(
			f,
			async () => ({ choice: name === "chooseBool" ? "no" : "control-1", advice: "", source: "deepseek" }),
			() => true,
			() => {}
		);
		assert.equal(await policy.decide(f.event), true);
		if (name === "chooseBool") assert.deepEqual(f.event.result, { bool: false });
		else assert.deepEqual(f.event.result, { control: "recover_hp", index: 1 });
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
	}
});

test("known-information snapshots include legitimately revealed hand cards", () => {
	const f = fixture();
	f.opponent.getKnownCards = () => [f.hiddenCard];
	const policy = policyFor(
		f,
		async () => {
			throw new Error();
		},
		() => true,
		() => {}
	);
	policy.matchMemory.setOmniscient(false);
	assert.equal(policy.snapshot(f.cpu).players[1].hand[0].id, "secret-card");
	assert.equal(policy.snapshot(f.cpu).players[1].role, "未知身份");
});

test("card labels use effective names and judgments preserve converted identities", () => {
	const f = fixture();
	f.engine.get.name = (card: any) => (card.name === "sha" ? "tao" : card.name);
	f.opponent.getVCards = () => [{ name: "lebusishu", viewAs: "lebusishu", suit: "diamond", number: 10 }];
	const policy = policyFor(
		f,
		async () => {
			throw new Error();
		},
		() => true,
		() => {}
	);
	const snapshot = policy.snapshot(f.cpu);
	assert.match(snapshot.self.hand[0].label, /^tao/);
	assert.equal(snapshot.players[1].judgments[0].name, "lebusishu");
});

test("optional CPU phase prompts may end despite the UI fakeforce flag", async () => {
	const f = fixture();
	f.event.fakeforce = true;
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.equal(
				packet.candidates.some((candidate: any) => candidate.id === "cancel"),
				true
			);
			return { choice: "cancel", advice: "可以结束出牌阶段", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 1);
});

test("counter-counterspell packets identify the original trick, affected target and immediate response", async () => {
	const f = fixture();
	f.event.type = "wuxie";
	f.event.state = -1;
	const original = { player: f.opponent, target: f.cpu, targets: [f.cpu], card: { name: "juedou", suit: "spade", number: 9, storage: { private: "PRIVATE_EVENT_DATA" } } };
	const immediate = { player: f.opponent, target: f.cpu, targets: [f.cpu], card: { name: "wuxie", suit: "club", number: 12 } };
	f.event.info_map = { ...immediate, _source: original, state: -1, skillState: { hiddenRole: "PRIVATE_EVENT_DATA" } };
	f.event.respondTo = [f.opponent, immediate.card];
	f.event.getParent = (name: string) => (name === "useCard" ? { ...immediate, name: "useCard", storage: { secret: "PRIVATE_EVENT_DATA" } } : {});
	const policy = policyFor(
		f,
		async (packet: any) => {
			const response = packet.state.currentResponse;
			assert.equal(response.type, "wuxie");
			assert.equal(response.respondTo.source, "opponent");
			assert.equal(response.respondTo.card.name, "wuxie");
			assert.equal(response.counterspell.state, -1);
			assert.equal(response.counterspell.originalAction.card.name, "juedou");
			assert.equal(response.counterspell.originalAction.actor, "opponent");
			assert.deepEqual(response.counterspell.originalAction.targets, ["cpu"]);
			assert.equal(packet.state.pendingAction.card.name, "wuxie");
			assert.equal(JSON.stringify(packet.state).includes("PRIVATE_EVENT_DATA"), false);
			assert.equal(packet.state.players[1].role, "未知身份");
			return { choice: "cancel", advice: "不反无懈", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
});

test("rescue packets carry the dying target, peach requirement and public damage source", async () => {
	const f = fixture();
	f.cpu.hp = -1;
	f.event.type = "dying";
	f.event.dying = f.cpu;
	f.event.getParent = (name: string) => (name === "damage" ? { name: "damage", player: f.cpu, source: f.opponent, num: 2, nature: "fire", card: { name: "sha" }, storage: { hidden: "PRIVATE_EVENT_DATA" } } : { name: "other", storage: { hidden: "PRIVATE_EVENT_DATA" } });
	const policy = policyFor(
		f,
		async (packet: any) => {
			assert.deepEqual(packet.state.currentResponse.dying, { target: "cpu", hp: -1, maxHp: 4, peachesNeeded: 2 });
			assert.equal(packet.state.currentResponse.damage.source, "opponent");
			assert.equal(packet.state.currentResponse.damage.target, "cpu");
			assert.equal(packet.state.currentResponse.damage.amount, 2);
			assert.equal(packet.state.currentResponse.damage.nature, "fire");
			assert.equal(packet.state.pendingAction, undefined);
			assert.equal(JSON.stringify(packet.state).includes("PRIVATE_EVENT_DATA"), false);
			return { choice: "cancel", advice: "保留资源", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
});

test("a changed pending counterspell target invalidates an otherwise unchanged answer", async () => {
	const f = fixture();
	f.event.type = "wuxie";
	f.event.info_map = { player: f.opponent, target: f.cpu, targets: [f.cpu], card: { name: "wanjian" }, state: 1 };
	const policy = policyFor(
		f,
		async () => {
			f.event.info_map.target = f.opponent;
			f.event.info_map.targets = [f.opponent];
			return { choice: "move-0", advice: "", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), false);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("phase-begin planning uses the full board before any ordinary or complex prompt", async () => {
	const f = fixture();
	const requests: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			requests.push(`${packet.kind}:${packet.event}`);
			if (packet.kind === "plan") {
				assert.equal(packet.event, "phaseBegin");
				assert.deepEqual(packet.candidates, []);
				assert.deepEqual(packet.state.players[1].hand, []);
				assert.equal(packet.state.knowledgeMode, "known");
				return { choice: null, advice: "保留桃", plan: "回合开始：留桃并压制敌方", source: "deepseek" };
			}
			assert.equal(packet.state.plan, "回合开始：留桃并压制敌方");
			return { choice: "move-0", advice: "出杀", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	f.event.complexSelect = true;
	await policy.planTurn(f.cpu);
	assert.equal(policy.matchMemory.context(f.cpu).needsTurnPlan, false);
	assert.equal(f.commits(), 0);
	delete f.event.complexSelect;
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(requests, ["plan:phaseBegin", "decision:chooseToUse:phase"]);
});

test("phase planning excludes disabled, human, multiplayer, finished and noncurrent turns", async () => {
	for (const mode of ["disabled", "human", "connect", "online", "over", "noncurrent", "onlinePlayer"]) {
		const f = fixture({ human: mode === "human" });
		if (mode === "connect") f.engine.status.connectMode = true;
		if (mode === "online") f.engine.game.online = true;
		if (mode === "over") f.engine.status.over = true;
		if (mode === "noncurrent") f.engine.status.currentPhase = f.opponent;
		if (mode === "onlinePlayer") f.cpu.isOnline = () => true;
		let requests = 0;
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				requests++;
				throw new Error("must not plan");
			},
			() => mode !== "disabled",
			() => {}
		);
		await policy.planTurn(f.cpu);
		assert.equal(requests, 0, mode);
	}
});

test("phase plans are discarded when the turn, match, roster or observed state changes", async () => {
	for (const change of ["phase", "current", "match", "roster", "hp"]) {
		const f = fixture();
		f.engine.game.phaseNumber = 1;
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				if (change === "phase") f.engine.game.phaseNumber++;
				if (change === "current") f.engine.status.currentPhase = f.opponent;
				if (change === "match") policy.resetMatch();
				if (change === "roster") f.engine.game.players[1] = { ...f.opponent };
				if (change === "hp") f.cpu.hp--;
				return { choice: null, advice: "旧回合计划", plan: "旧回合计划", source: "deepseek" };
			},
			() => true,
			() => {}
		);
		await policy.planTurn(f.cpu);
		assert.equal(policy.matchMemory.context(f.cpu).plan, "", change);
		assert.equal(f.commits(), 0);
	}
});

test("concurrent phase-plan requests share one call and a later turn gets a fresh plan", async () => {
	const f = fixture();
	f.engine.game.phaseNumber = 1;
	let requests = 0;
	let resolve: (value: any) => void = () => {};
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			requests++;
			if (requests === 1)
				return await new Promise<any>(complete => {
					resolve = complete;
				});
			return { choice: null, advice: "下回合计划", plan: "下回合计划", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	const first = policy.planTurn(f.cpu),
		second = policy.planTurn(f.cpu);
	assert.equal(requests, 1);
	resolve({ choice: null, advice: "本回合计划", plan: "本回合计划", source: "deepseek" });
	await Promise.all([first, second]);
	assert.equal(policy.matchMemory.context(f.cpu).plan, "本回合计划");
	await policy.planTurn(f.cpu);
	assert.equal(requests, 1);
	f.engine.game.phaseNumber++;
	await policy.planTurn(f.cpu);
	assert.equal(requests, 2);
	assert.equal(policy.matchMemory.context(f.cpu).plan, "下回合计划");
});

test("failed phase planning keeps the game alive and permits a later lazy planning retry", async () => {
	const f = fixture();
	let requests = 0;
	const messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			requests++;
			if (requests === 1) throw new Error("timeout");
			if (packet.kind === "plan") return { choice: null, advice: "作为内奸保留桃", plan: "作为内奸保留桃", source: "deepseek" };
			return { choice: "move-0", advice: "作为内奸出杀", source: "deepseek" };
		},
		() => true,
		text => messages.push(text)
	);
	await policy.planTurn(f.cpu);
	assert.equal(policy.matchMemory.context(f.cpu).needsTurnPlan, true);
	assert.equal(await policy.decide(f.event), true);
	assert.equal(requests, 3);
	assert.equal(
		messages.some(message => message.includes("作为内奸")),
		false
	);
});

test("human advice can be enabled while computers keep the original AI", async () => {
	const f = fixture();
	const requests: string[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			requests.push(packet.kind);
			return { choice: "move-0", advice: "独立开启的玩家建议", source: "deepseek" };
		},
		() => false,
		text => messages.push(text),
		() => true
	);
	await policy.planTurn(f.cpu);
	assert.equal(await policy.decide(f.event), false);
	assert.deepEqual(requests, []);
	assert.equal(f.event.result, "ai");
	f.engine.game.me = f.cpu;
	f.event.isMine = () => true;
	const hand = f.cpu.getCards("h").slice();
	await policy.advise();
	assert.deepEqual(requests, ["advice"]);
	assert.match(messages.at(-1) || "", /独立开启的玩家建议/);
	assert.deepEqual(f.cpu.getCards("h"), hand);
	assert.equal(f.event.result, "ai");
	assert.deepEqual(f.engine.ui.selected.cards, []);
	assert.deepEqual(f.engine.ui.selected.targets, []);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("computer DeepSeek decisions can be enabled while human advice stays disabled", async () => {
	const f = fixture();
	const requests: string[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			requests.push(packet.kind);
			if (packet.kind === "plan") return { choice: null, advice: "电脑回合计划", plan: "电脑回合计划", source: "deepseek" };
			return { choice: "move-0", advice: "电脑出杀", source: "deepseek" };
		},
		() => true,
		text => messages.push(text),
		() => false
	);
	await policy.planTurn(f.cpu);
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(requests, ["plan", "decision"]);
	assert.equal(f.commits(), 1);
	f.engine.game.me = f.cpu;
	f.event.isMine = () => true;
	await policy.advise();
	assert.deepEqual(requests, ["plan", "decision"]);
	assert.equal(messages.at(-1), "请开启 DeepSeek 出牌建议。");
	assert.equal(f.commits(), 1);
});

test("disabling only the advisor rejects an in-flight suggestion without recording or executing it", async () => {
	const f = fixture({ human: true });
	let advisorEnabled = true,
		requests = 0;
	const messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			requests++;
			advisorEnabled = false;
			return { choice: "move-0", advice: "已经过期的独立建议", memory: "已经过期的建议记忆", source: "deepseek" };
		},
		() => false,
		text => messages.push(text),
		() => advisorEnabled
	);
	await policy.advise();
	assert.equal(requests, 1);
	assert.equal(
		messages.some(message => message.includes("已经过期")),
		false
	);
	assert.equal(policy.matchMemory.context(f.cpu).memory, "");
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("disabling only computer DeepSeek rejects its in-flight action even when advice remains enabled", async () => {
	const f = fixture();
	let computerEnabled = true,
		requests = 0;
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			requests++;
			computerEnabled = false;
			return { choice: "move-0", advice: "已经过期的电脑动作", memory: "不应记录", source: "deepseek" };
		},
		() => computerEnabled,
		() => {},
		() => true
	);
	policy.matchMemory.remember(f.cpu, { plan: "已有回合计划" });
	assert.equal(await policy.decide(f.event), false);
	assert.equal(requests, 1);
	assert.equal(f.event.result, "ai");
	assert.equal(policy.matchMemory.context(f.cpu).memory, "");
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("human advice preserves the complete validated response beyond 900 characters", async () => {
	const f = fixture({ human: true });
	const advice = `${"请结合局面保留关键资源。".repeat(100)}尾部建议完整可见。<b>按文本显示</b>`;
	assert.ok(advice.length > 900);
	const messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => ({ choice: null, advice, source: "deepseek" }),
		() => true,
		text => messages.push(text)
	);
	await policy.advise();
	assert.equal(messages.at(-1), advice);
	assert.match(messages.at(-1) || "", /尾部建议完整可见/);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("out-of-turn responses request a tactical decision without an extra turn plan", async () => {
	const f = fixture();
	f.engine.status.currentPhase = f.opponent;
	f.event.name = "chooseToRespond";
	f.event.type = "respondSha";
	delete f.event.filterTarget;
	f.engine.game.check = () => {
		f.card.classList.toggle("selectable", !f.engine.ui.selected.cards.length || f.engine.ui.selected.cards.includes(f.card));
		return f.engine.ui.selected.cards.length === 1;
	};
	const kinds: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			kinds.push(packet.kind);
			assert.equal(packet.kind, "decision");
			assert.equal(packet.state.currentPlayer, "opponent");
			assert.equal(packet.player.id, "cpu");
			assert.equal(packet.state.needsTurnPlan, true);
			assert.equal(packet.state.players.length, 2);
			assert.ok(Array.isArray(packet.state.recentActions));
			return { choice: "move-0", advice: "响应当前威胁", source: "deepseek" };
		},
		() => true,
		() => {}
	);
	assert.equal(await policy.decide(f.event), true);
	assert.deepEqual(kinds, ["decision"]);
	assert.deepEqual(f.event.result.cards, [f.card]);
	assert.deepEqual(f.event.result.targets, []);
	assert.equal(f.commits(), 1);
});

test("known snapshots exclude concealed hands even when a legacy omniscient flag is set", () => {
	const f = fixture();
	const policy = policyFor(
		f,
		async () => {
			throw new Error();
		},
		() => true,
		() => {}
	);
	policy.matchMemory.setOmniscient(true);
	policy.matchMemory.remember(f.cpu, { plan: "凭旧全知手牌制定的计划", memory: "旧全知记忆", identityBeliefs: [{ id: "opponent", role: "nei", confidence: 1, reason: "旧全知推断" }] });
	const state = policy.snapshot(f.cpu);
	assert.equal(state.knowledgeMode, "known");
	assert.deepEqual(state.players[1].hand, []);
	assert.equal(JSON.stringify(state).includes("secret-card"), false);
	assert.equal(state.self.hand[0].id, "card-1");
	assert.equal(state.plan, "");
	assert.equal(state.memory, "");
	assert.deepEqual(state.identityBeliefs, []);
});

test("human advice traces observed facts only without enumerating candidates or altering selections", async () => {
	const f = fixture({ human: true });
	f.engine.ui.selected.cards.push(f.card);
	f.engine.ui.selected.targets.push(f.opponent);
	f.card.classList.add("selected");
	f.opponent.classList.add("selected");
	f.engine.game.check = () => assert.fail("Advice must not probe hypothetical legal selections");
	f.engine.game.video = [{ privateReplay: "PRIVATE_NATIVE_VIDEO" }];
	const entries: any[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			assert.deepEqual(packet.candidates, []);
			assert.equal(packet.state.knowledgeMode, "known");
			assert.deepEqual(packet.state.players[1].hand, []);
			assert.equal(JSON.stringify(packet).includes("PRIVATE_NATIVE_VIDEO"), false);
			assert.equal(JSON.stringify(packet).includes("secret-card"), false);
			return { choice: null, advice: "依据实际手牌保留防御", source: "deepseek", model: "deepseek-flash" };
		},
		() => false,
		text => messages.push(text),
		() => true,
		entry => entries.push(entry)
	);
	policy.matchMemory.setOmniscient(true);
	await policy.advise();
	assert.deepEqual(
		entries.map(entry => [entry.type, entry.stage || entry.status]),
		[
			["ai_request", "start"],
			["ai_request", "complete"],
			["ai_outcome", "shown"],
		]
	);
	assert.equal(new Set(entries.map(entry => entry.requestId)).size, 1);
	assert.equal(entries[0].kind, "advice");
	assert.deepEqual(entries[0].input.candidates, []);
	assert.equal(entries[1].result.advice, "依据实际手牌保留防御");
	assert.equal(entries[1].model, "deepseek-flash");
	assert.equal(entries[2].visible, true);
	assert.equal(entries[2].executed, false);
	assert.match(messages.at(-1) || "", /实际手牌/);
	assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
	assert.deepEqual(f.engine.ui.selected.targets, [f.opponent]);
	assert.equal(f.card.classList.contains("selected"), true);
	assert.equal(f.opponent.classList.contains("selected"), true);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("failed requests trace timing and sanitized error reasons before returning to built-in AI", async () => {
	const f = fixture();
	const entries: any[] = [],
		messages: string[] = [];
	const failure = Object.assign(new Error("网络断开 Bearer sk-0123456789SECRET"), { code: "upstream_error", status: 502 });
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			throw failure;
		},
		() => true,
		text => messages.push(text),
		() => true,
		entry => entries.push(entry)
	);
	policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
	assert.equal(await policy.decide(f.event), false);
	const start = entries.find(entry => entry.stage === "start"),
		error = entries.find(entry => entry.stage === "error"),
		outcome = entries.find(entry => entry.type === "ai_outcome");
	assert.equal(start.kind, "decision");
	assert.equal(start.actorId, "cpu");
	assert.equal(start.event, "chooseToUse:phase");
	assert.equal(error.requestId, start.requestId);
	assert.equal(error.error.code, "upstream_error");
	assert.equal(error.error.status, 502);
	assert.ok(error.durationMs >= 0);
	assert.match(error.error.message, /网络断开/);
	assert.equal(JSON.stringify(entries).includes("0123456789SECRET"), false);
	assert.equal(outcome.reason, "request_failed");
	assert.equal(outcome.fallback, "builtin");
	assert.equal(outcome.executed, false);
	assert.match(messages.at(-1) || "", /网络断开/);
	assert.equal((messages.at(-1) || "").includes("0123456789SECRET"), false);
	assert.equal(f.event.result, "ai");
	assert.equal(f.commits(), 0);
});

test("stale model answers are traced as unexecuted outcomes", async () => {
	const f = fixture();
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			f.cpu.hp--;
			return { choice: "move-0", advice: "过期的出杀", source: "deepseek", model: "deepseek-flash" };
		},
		() => true,
		() => {},
		() => true,
		entry => entries.push(entry)
	);
	policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
	assert.equal(await policy.decide(f.event), false);
	const outcome = entries.find(entry => entry.type === "ai_outcome");
	assert.equal(outcome.status, "stale");
	assert.equal(outcome.reason, "event_or_state_changed");
	assert.equal(outcome.candidate.id, "move-0");
	assert.equal(outcome.applied, false);
	assert.equal(outcome.executed, false);
	assert.equal(outcome.model, "deepseek-flash");
	assert.equal(f.commits(), 0);
});

test("rejected, illegal and built-in choices have distinct recorded fallback reasons", async () => {
	for (const [choice, reason] of [
		["invented", "unknown_choice"],
		["builtin", "builtin_selected"],
		["move-0", "illegal_choice"],
	]) {
		const f = fixture();
		const entries: any[] = [];
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				if (reason === "illegal_choice") f.setLegal(false);
				return { choice, advice: "", source: "deepseek" };
			},
			() => true,
			() => {},
			() => true,
			entry => entries.push(entry)
		);
		policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
		assert.equal(await policy.decide(f.event), false);
		const outcome = entries.find(entry => entry.type === "ai_outcome");
		assert.equal(outcome.reason, reason);
		assert.equal(outcome.executed, false);
		if (choice !== "invented") assert.equal(outcome.candidate.id, choice);
		assert.equal(f.commits(), 0);
	}
});

test("phase plans are recorded as memory updates without executing game actions", async () => {
	const f = fixture();
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => ({ choice: null, advice: "保留桃", plan: "本回合保留桃", source: "deepseek", model: "deepseek-v4-pro" }),
		() => true,
		() => {},
		() => true,
		entry => entries.push(entry)
	);
	await policy.planTurn(f.cpu);
	assert.deepEqual(
		entries.map(entry => entry.kind),
		["plan", "plan", "plan"]
	);
	assert.equal(entries[0].event, "phaseBegin");
	assert.deepEqual(entries[0].input.candidates, []);
	assert.equal(entries[1].model, "deepseek-v4-pro");
	assert.equal(entries[2].status, "applied");
	assert.equal(entries[2].reason, "plan_stored");
	assert.equal(entries[2].executed, false);
	assert.equal(f.commits(), 0);
});

test("a trace callback throwing cannot interrupt a valid computer action", async () => {
	const f = fixture();
	let traceCalls = 0;
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => ({ choice: "move-0", advice: "使用杀", source: "deepseek" }),
		() => true,
		() => {},
		() => true,
		() => {
			traceCalls++;
			throw new Error("recorder unavailable");
		}
	);
	policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
	assert.equal(await policy.decide(f.event), true);
	assert.equal(traceCalls, 3);
	assert.equal(f.commits(), 1);
	assert.deepEqual(f.event.result.cards, [f.card]);
});

test("trace data is detached so recorder mutation cannot change packets or model choices", async () => {
	const f = fixture();
	const policy = new DeepSeekPolicy(
		f.engine,
		async (packet: any) => {
			assert.equal(packet.candidates[0].id, "move-0");
			return { choice: "move-0", advice: "使用杀", source: "deepseek" };
		},
		() => true,
		() => {},
		() => true,
		(entry: any) => {
			if (entry.stage === "start") entry.input.candidates[0].id = "invented";
			if (entry.stage === "complete") entry.result.choice = "builtin";
		}
	);
	policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
	assert.equal(await policy.decide(f.event), true);
	assert.equal(f.commits(), 1);
});

test("builtin human advice uses actual basic scorers with DeepSeek off and restores all live choices", async () => {
	const f = fixture({ human: true });
	const originalResult = { pending: true };
	f.event.result = originalResult;
	f.event.choice = 4;
	f.event.ai1 = (card: any) => (card === f.card ? 2 : 0);
	f.event.ai2 = (target: any) => (target === f.opponent ? 1 : -1);
	f.engine.ui.selected.cards.push(f.card);
	f.engine.ui.selected.targets.push(f.opponent);
	f.card.classList.add("selected");
	f.opponent.classList.add("selected");
	let chooseCardCalls = 0,
		chooseTargetCalls = 0,
		requests = 0;
	f.engine.ai = {
		basic: {
			chooseCard(check: any) {
				chooseCardCalls++;
				assert.equal(f.cpu._noSkill, true);
				assert.equal(f.engine.lib.config.auto_confirm, false);
				assert.equal(f.engine.status.touchnocheck, true);
				assert.equal(check(f.card), 2);
				assert.equal(f.card.classList.contains("selectable"), true);
				f.card.classList.add("selected");
				f.engine.ui.selected.cards.push(f.card);
				f.event.result = { temporary: true };
				f.event.choice = 9;
				f.engine.game.check();
				return true;
			},
			chooseTarget(check: any) {
				chooseTargetCalls++;
				assert.equal(check(f.opponent), 1);
				assert.equal(f.opponent.classList.contains("selectable"), true);
				f.opponent.classList.add("selected");
				f.engine.ui.selected.targets.push(f.opponent);
				f.engine.game.check();
				return true;
			},
		},
	};
	const originalOk = f.engine.ui.click.ok,
		originalCancel = f.engine.ui.click.cancel;
	const entries: any[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			requests++;
			throw new Error();
		},
		() => false,
		text => messages.push(text),
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.equal(chooseCardCalls, 1);
	assert.equal(chooseTargetCalls, 1);
	assert.equal(requests, 0);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
	assert.equal(f.event.result, originalResult);
	assert.equal(f.event.choice, 4);
	assert.equal(Object.hasOwn(f.cpu, "_noSkill"), false);
	assert.equal(f.engine.lib.config.auto_confirm, true);
	assert.equal(f.engine.status.touchnocheck, undefined);
	assert.equal(f.engine.ui.click.ok, originalOk);
	assert.equal(f.engine.ui.click.cancel, originalCancel);
	assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
	assert.deepEqual(f.engine.ui.selected.targets, [f.opponent]);
	assert.equal(f.card.classList.contains("selected"), true);
	assert.equal(f.opponent.classList.contains("selected"), true);
	assert.match(messages.at(-1) || "", /原版 AI 建议.*sha.*opponent/);
	assert.equal(f.card.classList.contains("selectable"), false);
	assert.equal(f.opponent.classList.contains("selectable"), false);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, "ai_outcome");
	assert.equal(entries[0].source, "builtin");
	assert.equal(entries[0].executed, false);
	assert.equal(entries[0].result.cards[0].id, "card-1");
	assert.deepEqual(entries[0].result.targets, ["opponent"]);
	assert.equal(entries[0].usage.totalTokens, 0);
	assert.deepEqual(entries[0].input.candidates, []);
});

test("builtin boolean and control advice uses original event.ai semantics without committing results", async () => {
	for (const name of ["chooseBool", "chooseControl"]) {
		const f = fixture({ human: true });
		f.event.name = name;
		delete f.event.filterCard;
		delete f.event.filterTarget;
		f.event.controls = ["optionA", "optionB", "cancel2"];
		f.event.choice = 0;
		const parent = { name: "parent" },
			originalResult = { pending: true };
		f.event.getParent = () => parent;
		f.event.result = originalResult;
		let calls = 0,
			requests = 0;
		f.event.ai = (givenParent: any, player: any) => {
			calls++;
			assert.equal(givenParent, parent);
			assert.equal(player, f.cpu);
			return name === "chooseBool" ? false : 1;
		};
		const entries: any[] = [];
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				requests++;
				throw new Error();
			},
			() => false,
			() => {},
			() => false,
			entry => entries.push(entry)
		);
		await policy.adviseBuiltin();
		assert.equal(calls, 1);
		assert.equal(requests, 0);
		assert.equal(entries[0].result.choice, name === "chooseBool" ? "no" : "optionB");
		assert.equal(f.event.result, originalResult);
		assert.equal(f.event.choice, 0);
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
	}
});

test("builtin target-only advice invokes only the target selector", async () => {
	const f = fixture({ human: true });
	f.event.name = "chooseTarget";
	delete f.event.filterCard;
	f.event.ai = (target: any) => (target === f.opponent ? 3 : -1);
	f.engine.game.check = () => {
		for (const player of f.engine.game.players) player.classList.toggle("selectable", player === f.opponent);
		return f.engine.ui.selected.targets.length === 1;
	};
	f.engine.ai = {
		basic: {
			chooseCard() {
				assert.fail("Target-only advice must not choose cards");
			},
			chooseTarget(check: any) {
				assert.equal(check(f.opponent), 3);
				f.opponent.classList.add("selected");
				f.engine.ui.selected.targets.push(f.opponent);
				return true;
			},
		},
	};
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			throw new Error();
		},
		() => false,
		() => {},
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.deepEqual(entries[0].result.cards, []);
	assert.deepEqual(entries[0].result.targets, ["opponent"]);
	assert.deepEqual(f.engine.ui.selected.targets, []);
	assert.equal(f.commits(), 0);
});

test("builtin multi-card discard advice uses its scorer while preserving the human's selected peach", async () => {
	const f = fixture({ human: true, forced: true });
	const second = { ...f.card, cardid: "card-2", name: "shan", classList: new Classes() },
		peach = { ...f.card, cardid: "card-3", name: "tao", classList: new Classes() };
	f.cpu.getCards("h").push(second, peach);
	f.event.name = "chooseToDiscard";
	f.event.selectCard = [2, 2];
	delete f.event.filterTarget;
	f.event.ai = (card: any) => (card.name === "tao" ? 0 : card.name === "shan" ? 2 : 1);
	f.engine.ui.selected.cards.push(peach);
	peach.classList.add("selected");
	f.engine.game.check = () => {
		const selected = f.engine.ui.selected.cards;
		for (const card of f.cpu.getCards("h")) card.classList.toggle("selectable", selected.length < 2 || selected.includes(card));
		return selected.length === 2;
	};
	f.engine.ai = {
		basic: {
			chooseCard(check: any) {
				const available = f.cpu
					.getCards("h")
					.slice()
					.sort((first: any, next: any) => check(next) - check(first));
				for (const card of available.slice(0, 2)) {
					assert.equal(card.classList.contains("selectable"), true);
					card.classList.add("selected");
					f.engine.ui.selected.cards.push(card);
					f.engine.game.check();
				}
				return true;
			},
			chooseTarget() {
				assert.fail("Discard advice should not select targets");
			},
		},
	};
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			assert.fail("No cloud calls");
		},
		() => false,
		() => {},
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.deepEqual(
		entries[0].result.cards.map((card: any) => card.id),
		["card-2", "card-1"]
	);
	assert.deepEqual(entries[0].result.targets, []);
	assert.deepEqual(f.engine.ui.selected.cards, [peach]);
	assert.equal(peach.classList.contains("selected"), true);
	assert.equal(peach.classList.contains("selectable"), false);
	assert.equal(f.cpu.getCards("h").length, 3);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("builtin advice refuses unsupported skills and processAI without running their scripts", async () => {
	for (const kind of ["skill", "complex", "processAI", "confirm"]) {
		const f = fixture({ human: true });
		if (kind === "skill") f.event.skill = "test_skill";
		if (kind === "complex") f.event.complexSelect = true;
		if (kind === "processAI") f.event.processAI = () => assert.fail("Unsupported processAI must not run");
		if (kind === "confirm") f.event.custom = { replace: { confirm: () => assert.fail("Custom confirmations must not run") } };
		f.engine.ai = { basic: { chooseCard: () => assert.fail("Unsupported prompts must not simulate native AI") } };
		const entries: any[] = [];
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				assert.fail("Native advice must never call cloud");
			},
			() => false,
			() => {},
			() => false,
			entry => entries.push(entry)
		);
		await policy.adviseBuiltin();
		assert.equal(entries[0].reason, "unsupported_prompt");
		assert.equal(entries[0].source, "builtin");
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
	}
});

test("builtin scorer errors are deferred until selector cleanup and restore the human event", async () => {
	const f = fixture({ human: true });
	f.event.ai1 = () => {
		f.event.result = { temporary: true };
		throw new Error("score failed");
	};
	f.engine.ui.selected.cards.push(f.card);
	f.card.classList.add("selected");
	const result = f.event.result;
	let cacheActive = false,
		cleanupRan = false;
	f.engine.ai = {
		basic: {
			chooseCard(check: any) {
				cacheActive = true;
				assert.equal(check(f.card), -Infinity);
				cacheActive = false;
				cleanupRan = true;
				return false;
			},
		},
	};
	const entries: any[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			assert.fail("No cloud calls");
		},
		() => false,
		text => messages.push(text),
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.equal(cleanupRan, true);
	assert.equal(cacheActive, false);
	assert.equal(f.event.result, result);
	assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
	assert.equal(f.engine.lib.config.auto_confirm, true);
	assert.equal(f.engine.status.touchnocheck, undefined);
	assert.equal(Object.hasOwn(f.cpu, "_noSkill"), false);
	assert.equal(entries[0].reason, "builtin_advice_failed");
	assert.match(entries[0].error.message, /score failed/);
	assert.match(messages.at(-1) || "", /score failed/);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("builtin advice prevents script confirmations from executing human moves", async () => {
	const f = fixture({ human: true });
	f.event.ai1 = () => 1;
	const originalOk = f.engine.ui.click.ok;
	f.engine.ai = {
		basic: {
			chooseCard() {
				f.engine.ui.click.ok();
				return true;
			},
		},
	};
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			assert.fail("No cloud calls");
		},
		() => false,
		() => {},
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.equal(f.commits(), 0);
	assert.equal(f.engine.ui.click.ok, originalOk);
	assert.equal(entries[0].reason, "builtin_advice_failed");
	assert.equal(f.engine.status.touchnocheck, undefined);
});

test("failed paid responses preserve only actual numeric provider usage in traces", async () => {
	const f = fixture();
	const entries: any[] = [];
	const usage = { promptTokens: 120, completionTokens: 30, totalTokens: 150, cacheHitTokens: 80, cacheMissTokens: 40, apiKey: "PRIVATE_USAGE_SECRET" };
	const error = Object.assign(new Error("DeepSeek 返回了无效候选"), { code: "invalid_choice", status: 502, usage });
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			throw error;
		},
		() => true,
		() => {},
		() => true,
		entry => entries.push(entry)
	);
	policy.matchMemory.remember(f.cpu, { plan: "现有计划" });
	assert.equal(await policy.decide(f.event), false);
	const failure = entries.find(entry => entry.stage === "error");
	assert.deepEqual(failure.error.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150, cacheHitTokens: 80, cacheMissTokens: 40 });
	assert.equal(JSON.stringify(entries).includes("PRIVATE_USAGE_SECRET"), false);
	assert.equal(f.commits(), 0);
});

test("wire packets preserve known facts once while snapshot and fingerprints retain their original structure", async () => {
	for (const kind of ["advice", "plan", "decision"]) {
		const f = fixture({ human: kind === "advice" });
		f.cpu.hp = 3;
		f.cpu.getSkills = () => ["test_skill"];
		f.engine.get.skillInfoTranslation = () => "完整技能规则：出牌阶段可以按规定使用技能，结束阶段保留防御资源。";
		const equipment = { ...f.card, cardid: "own-equipment", name: "bagua" },
			judgment = { ...f.card, cardid: "own-judgment", name: "lebu" };
		const originalGetCards = f.cpu.getCards;
		f.cpu.getCards = (position: string) => (position === "e" ? [equipment] : position === "j" ? [judgment] : originalGetCards(position));
		const revealed = { ...f.hiddenCard, cardid: "known-card", name: "shan" };
		f.opponent.getCards("h").push(revealed);
		f.opponent.getKnownCards = () => [revealed];
		const packets: any[] = [];
		const policy = new DeepSeekPolicy(
			f.engine,
			async (packet: any) => {
				packets.push(packet);
				return { choice: kind === "decision" ? "move-0" : null, advice: "依据已知局面行动", plan: "保留防御资源", source: "deepseek" };
			},
			() => true,
			() => {}
		);
		policy.matchMemory.record({ kind: "damage", source: "opponent", targets: ["cpu"], amount: 1 });
		policy.matchMemory.remember(f.cpu, { ...(kind === "decision" ? { plan: "已有计划" } : {}), memory: "对手曾造成伤害", identityBeliefs: [{ id: "opponent", role: "unknown", confidence: 0.2, reason: "只能推测身份" }] });
		const snapshot = policy.snapshot(f.cpu);
		if (kind === "advice") await policy.advise();
		else if (kind === "plan") await policy.planTurn(f.cpu);
		else assert.equal(await policy.decide(f.event), true);
		assert.equal(packets.length, 1);
		const packet = packets[0],
			own = packet.state.players.find((player: any) => player.id === packet.player.id);
		assert.equal(packet.kind, kind);
		assert.deepEqual(packet.player, snapshot.self);
		assert.equal(Object.hasOwn(packet.state, "self"), false);
		assert.equal(Object.hasOwn(own, "hand"), false);
		assert.equal(Object.hasOwn(own, "skills"), false);
		assert.equal(own.selfInfo, "player");
		assert.equal(own.hp, 3);
		assert.equal(own.handCount, 1);
		assert.equal(own.role, snapshot.players[0].role);
		assert.deepEqual(own.equipment, snapshot.players[0].equipment);
		assert.deepEqual(own.judgments, snapshot.players[0].judgments);
		assert.equal(packet.player.hand[0].rules, snapshot.self.hand[0].rules);
		assert.equal(packet.player.skills[0].rules, snapshot.self.skills[0].rules);
		assert.deepEqual(packet.state.players[1].hand, snapshot.players[1].hand);
		assert.equal(packet.state.players[1].hand[0].id, "known-card");
		assert.equal(JSON.stringify(packet).includes("secret-card"), false);
		assert.equal(packet.state.knowledgeMode, "known");
		assert.deepEqual(packet.state.recentActions, snapshot.recentActions);
		assert.deepEqual(packet.state.playerTrends, snapshot.playerTrends);
		assert.deepEqual(packet.state.identityBeliefs, snapshot.identityBeliefs);
		assert.equal(packet.state.memory, snapshot.memory);
		assert.equal(packet.state.plan, snapshot.plan);
		assert.equal(Object.hasOwn(packet.state, "strategyGoals"), false);
		assert.ok(snapshot.strategyGoals.length > 0);
		assert.equal(snapshot.players[0].hand[0].id, "card-1");
		assert.equal(snapshot.self.hand[0].id, "card-1");
		assert.equal(snapshot.players[0].skills[0].rules, snapshot.self.skills[0].rules);
		assert.ok(JSON.stringify({ player: packet.player, state: packet.state }).length < JSON.stringify({ player: snapshot.self, state: snapshot }).length);
		if (kind !== "decision") {
			assert.deepEqual(packet.candidates, []);
			assert.equal(f.commits(), 0);
			assert.equal(f.cancels(), 0);
		}
	}
});

function builtinRetryFixture(includeWuzhong: boolean, exclusions: any[] | Set<any>) {
	const f = fixture({ human: true });
	const second = { ...f.card, cardid: "card-2", name: includeWuzhong ? "wuzhong" : "sha", classList: new Classes() };
	f.cpu.getCards("h").push(second);
	f.event._aiexclude = exclusions;
	f.event._cardChoice = { original: ["card-cache"] };
	f.event._targetChoice = { original: ["target-cache"] };
	f.event._skillChoice = ["original-skill"];
	f.event._checked = false;
	f.event.result = { pending: true };
	f.event.ai1 = (card: any) => (card.name === "sha" ? 10 : 7);
	f.event.ai2 = (target: any) => (f.engine.ui.selected.cards[0]?.name === "wuzhong" && target === f.cpu ? 4 : -1);
	f.event.filterTarget = (card: any, _player: any, target: any) => (card?.name === "wuzhong" ? target === f.cpu : target === f.opponent);
	f.engine.ui.selected.cards.push(f.card);
	f.engine.ui.selected.targets.push(f.opponent);
	f.card.classList.add("selected", "selectable");
	f.opponent.classList.add("selected", "selectable");
	f.engine.game.uncheck = () => assert.fail("Readonly retries must not call game.uncheck");
	f.event.redo = () => assert.fail("Readonly retries must not redo game events");
	f.engine.game.check = () => {
		f.event._checked = true;
		const cache = (f.event._cardChoice ||= {});
		const cards = (cache.valid ||= f.cpu.getCards("h").filter((card: any) => f.event.filterCard(card, f.cpu)));
		for (const card of f.cpu.getCards("h")) card.classList.toggle("selectable", (cards.includes(card) && f.engine.ui.selected.cards.length === 0) || f.engine.ui.selected.cards.includes(card));
		const selected = f.engine.ui.selected.cards[0];
		for (const target of f.engine.game.players) target.classList.toggle("selectable", (Boolean(selected) && f.event.filterTarget(selected, f.cpu, target) && f.engine.ui.selected.targets.length === 0) || f.engine.ui.selected.targets.includes(target));
		return f.engine.ui.selected.cards.length === 1 && f.engine.ui.selected.targets.length === 1;
	};
	const tried: string[] = [];
	f.engine.ai = {
		basic: {
			chooseCard(check: any) {
				assert.notEqual(f.event._aiexclude, exclusions);
				const cards = f.cpu
					.getCards("h")
					.filter((card: any) => card.classList.contains("selectable") && !card.classList.contains("selected"))
					.sort((first: any, next: any) => check(next) - check(first));
				if (!cards.length || check(cards[0]) <= 0) return false;
				const card = cards[0];
				tried.push(card.name);
				card.classList.add("selected");
				f.engine.ui.selected.cards.push(card);
				f.engine.game.check();
				return true;
			},
			chooseTarget(check: any) {
				const targets = f.engine.game.players.filter((target: any) => target.classList.contains("selectable") && !target.classList.contains("selected")).sort((first: any, next: any) => check(next) - check(first));
				if (!targets.length || check(targets[0]) <= 0) return false;
				const target = targets[0];
				target.classList.add("selected");
				f.engine.ui.selected.targets.push(target);
				f.engine.game.check();
				return true;
			},
		},
	};
	return { ...f, second, tried };
}

test("builtin physical retries skip a higher-order attack with no positive target and advise the next valid draw", async () => {
	for (const exclusions of [["previous-skill"], new Set(["previous-skill"])]) {
		const f = builtinRetryFixture(true, exclusions);
		const originalCardCache = f.event._cardChoice,
			originalTargetCache = f.event._targetChoice,
			originalSkills = f.event._skillChoice,
			originalResult = f.event.result,
			originalFilter = f.event.filterCard;
		const entries: any[] = [],
			messages: string[] = [];
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				assert.fail("No cloud calls");
			},
			() => false,
			text => messages.push(text),
			() => false,
			entry => entries.push(entry)
		);
		await policy.adviseBuiltin();
		assert.deepEqual(f.tried, ["sha", "wuzhong"]);
		assert.equal(entries[0].status, "shown");
		assert.equal(entries[0].result.cards[0].name, "wuzhong");
		assert.deepEqual(entries[0].result.targets, ["cpu"]);
		assert.match(messages.at(-1) || "", /wuzhong/);
		assert.equal((messages.at(-1) || "").includes("结束出牌阶段"), false);
		assert.equal(f.event._aiexclude, exclusions);
		assert.deepEqual([...exclusions], ["previous-skill"]);
		assert.equal(f.event._cardChoice, originalCardCache);
		assert.equal(f.event._targetChoice, originalTargetCache);
		assert.deepEqual(originalCardCache, { original: ["card-cache"] });
		assert.deepEqual(originalTargetCache, { original: ["target-cache"] });
		assert.equal(f.event._skillChoice, originalSkills);
		assert.equal(f.event._checked, false);
		assert.equal(f.event.filterCard, originalFilter);
		assert.equal(f.event.result, originalResult);
		assert.deepEqual(f.engine.ui.selected.cards, [f.card]);
		assert.deepEqual(f.engine.ui.selected.targets, [f.opponent]);
		assert.equal(f.card.classList.contains("selected"), true);
		assert.equal(f.opponent.classList.contains("selected"), true);
		assert.equal(f.commits(), 0);
		assert.equal(f.cancels(), 0);
	}
});

test("builtin phase ending is advised only after all remaining physical choices are rejected", async () => {
	const exclusions: any[] = [];
	const f = builtinRetryFixture(false, exclusions);
	const entries: any[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			assert.fail("No cloud calls");
		},
		() => false,
		() => {},
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.deepEqual(f.tried, ["sha", "sha"]);
	assert.equal(entries[0].result.choice, "cancel");
	assert.match(entries[0].result.label, /结束出牌阶段/);
	assert.equal(f.event._aiexclude, exclusions);
	assert.deepEqual(exclusions, []);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("builtin retry limits report a bound instead of falsely advising phase end with untried cards", async () => {
	const f = builtinRetryFixture(false, []);
	for (let index = 0; index < 65; index++) f.cpu.getCards("h").push({ ...f.card, cardid: `extra-${index}`, classList: new Classes() });
	const entries: any[] = [],
		messages: string[] = [];
	const policy = new DeepSeekPolicy(
		f.engine,
		async () => {
			assert.fail("No cloud calls");
		},
		() => false,
		text => messages.push(text),
		() => false,
		entry => entries.push(entry)
	);
	await policy.adviseBuiltin();
	assert.equal(f.tried.length, 64);
	assert.equal(entries[0].reason, "builtin_advice_failed");
	assert.match(messages.at(-1) || "", /评估范围/);
	assert.equal((messages.at(-1) || "").includes("结束出牌阶段"), false);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});

test("builtin advice does not suggest ending a phase while active skills remain unassessed", async () => {
	const exclusions: any[] = [], f = builtinRetryFixture(false, exclusions), entries: any[] = [], reports: string[] = [];
	f.engine.get.skills = () => {
		assert.equal(f.cpu._noSkill, undefined);
		return ["zhiheng"];
	};
	const policy = new DeepSeekPolicy(f.engine, async () => { assert.fail("No cloud calls"); }, () => false, text => reports.push(text), () => false, entry => entries.push(entry));
	await policy.adviseBuiltin();
	assert.match(reports[0], /仍有可用技能尚未评估/);
	assert.equal(entries[0].status, "fallback");
	assert.equal(entries[0].result, undefined);
	assert.equal(f.event._aiexclude, exclusions);
	assert.deepEqual(exclusions, []);
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
});
