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
		engine: { game, get, lib, ui, status },
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
			assert.equal(packet.state.knowledgeMode, "omniscient");
			assert.equal(packet.state.players[1].hand[0].id, "secret-card");
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

test("human phase advice may recommend ending despite the UI fakeforce flag", async () => {
	const f = fixture({ human: true });
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
	await policy.advise();
	assert.equal(f.commits(), 0);
	assert.equal(f.cancels(), 0);
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
				assert.equal(packet.state.players[1].hand[0].id, "secret-card");
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

test("phase plans are discarded when the turn, match, roster or knowledge mode changes", async () => {
	for (const change of ["phase", "current", "match", "roster", "knowledge"]) {
		const f = fixture();
		f.engine.game.phaseNumber = 1;
		const policy = new DeepSeekPolicy(
			f.engine,
			async () => {
				if (change === "phase") f.engine.game.phaseNumber++;
				if (change === "current") f.engine.status.currentPhase = f.opponent;
				if (change === "match") policy.resetMatch();
				if (change === "roster") f.engine.game.players[1] = { ...f.opponent };
				if (change === "knowledge") policy.matchMemory.setOmniscient(false);
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
