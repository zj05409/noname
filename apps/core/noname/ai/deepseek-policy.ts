import { DeepSeekMatchMemory } from "./deepseek-strategy";

/** Legal choices remain engine-validated; knowledge mode is explicit and never reveals hidden roles. */
export interface DeepSeekCandidate {
	id: string;
	label: string;
	cards?: Record<string, unknown>[];
	targets?: string[];
}

interface Move {
	candidate: DeepSeekCandidate;
	cards: any[];
	targets: any[];
	kind: "play" | "cancel" | "builtin" | "bool" | "control";
	value?: boolean | string;
}

interface Engine {
	game: any;
	get: any;
	lib: any;
	ui: any;
	status: any;
}

export interface DeepSeekPublicAction {
	kind: "useCard" | "judgment";
	actor?: string;
	target?: string;
	targets: string[];
	card: Record<string, unknown>;
}

export interface DeepSeekResponseContext {
	pendingAction?: DeepSeekPublicAction;
	currentResponse: {
		type: string;
		respondTo?: { source?: string; card: Record<string, unknown> };
		counterspell?: { state: 1 | -1; originalAction?: DeepSeekPublicAction; immediateAction?: DeepSeekPublicAction };
		dying?: { target: string; hp: number; maxHp: number; peachesNeeded: number };
		damage?: { source?: string; target: string; hp: number; amount?: number; nature?: string; card?: Record<string, unknown> };
		requiredSha?: number;
		requiredShan?: number;
	};
}

export interface DeepSeekReply {
	choice: string | null;
	advice: string;
	source: string;
	model?: string;
	memory?: string;
	identityBeliefs?: { id: string; role: "zhu" | "zhong" | "fan" | "nei" | "unknown"; confidence: number; reason: string }[];
	plan?: string;
}

const supportedEvents = new Set(["chooseToUse", "chooseToRespond", "chooseCard", "chooseTarget", "chooseToDiscard", "chooseBool", "chooseControl"]);
const plain = (value: unknown) =>
	String(value ?? "")
		.replace(/<[^>]*>/g, "")
		.slice(0, 900);

export class DeepSeekPolicy {
	private pending = new WeakMap<object, object>();
	private turnPlans = new Map<string, Promise<void>>();
	private matchGeneration = 0;
	public readonly matchMemory: DeepSeekMatchMemory;

	constructor(
		private engine: Engine,
		private request: (packet: Record<string, unknown>) => Promise<DeepSeekReply>,
		private enabled: () => boolean,
		private report: (text: string, computer?: boolean) => void
	) {
		this.matchMemory = new DeepSeekMatchMemory(engine);
	}

	public resetMatch() {
		this.matchGeneration++;
		this.matchMemory.clear();
		this.turnPlans.clear();
	}

	private playerId(player: any) {
		const { game } = this.engine;
		return String(player.playerid ?? `seat-${game.players.concat(game.dead || []).indexOf(player) + 1}`);
	}

	private playerName(player: any, own = false) {
		const { get } = this.engine;
		const names = [];
		if (own || !player.isUnseen?.(0)) names.push(plain(get.translation(player.name1 || player.name)));
		if (player.name2 && (own || !player.isUnseen?.(1))) names.push(plain(get.translation(player.name2)));
		return names.filter(Boolean).join(" / ") || "未亮明武将";
	}

	private card(card: any, player: any, judgment = false) {
		const { get, lib } = this.engine;
		const name = judgment && card.viewAs ? (typeof card.viewAs === "string" ? card.viewAs : card.viewAs.name) : get.name(card, player);
		const suit = get.suit(card, player),
			number = get.number(card, player);
		return {
			id: String(card.cardid ?? ""),
			name,
			label: plain(`${get.translation(name)}${suit && suit !== "none" ? `［${get.translation(suit)}${number || ""}］` : ""}`),
			suit,
			number,
			nature: get.nature(card, player) || undefined,
			rules: plain(lib.translate[`${name}_info`]),
		};
	}

	public snapshot(actor: any) {
		const { game, get, lib, status } = this.engine;
		const players = game.players.concat(game.dead || []).map((player: any) => ({
			id: this.playerId(player),
			name: this.playerName(player, player === actor),
			hp: player.hp,
			maxHp: player.maxHp,
			handCount: player.countCards("h"),
			hand: (player === actor || this.matchMemory.isOmniscient() ? player.getCards("h") : player.getKnownCards?.(actor) || []).map((card: any) => this.card(card, player)),
			role: player === actor || player.identityShown === true ? plain(get.translation(`${player.identity}2`) || player.identity) : "未知身份",
			group: player === actor || (!player.isUnseen?.(0) && !player.isUnseen?.(1)) ? plain(get.translation(player.group || "")) : undefined,
			skills: player === actor || (!player.isUnseen?.(0) && !player.isUnseen?.(1)) ? player.getSkills().map((skill: string) => ({ name: plain(get.translation(skill)), rules: plain(get.skillInfoTranslation(skill, player)) })) : [],
			equipment: player.getCards("e").map((card: any) => this.card(card, player)),
			judgments: (player.getVCards?.("j") || player.getCards("j")).map((card: any) => this.card(card, player, true)),
			alive: game.players.includes(player),
			linked: Boolean(player.isLinked?.()),
			turnedOver: Boolean(player.isTurnedOver?.()),
		}));
		return {
			mode: lib.config.mode,
			round: game.roundNumber || 0,
			currentPlayer: status.currentPhase ? this.playerId(status.currentPhase) : null,
			self: {
				id: this.playerId(actor),
				name: this.playerName(actor, true),
				role: plain(get.translation(`${actor.identity}2`) || actor.identity),
				hand: actor.getCards("h").map((card: any) => this.card(card, actor)),
				skills: actor.getSkills().map((skill: string) => ({ name: plain(get.translation(skill)), rules: plain(get.skillInfoTranslation(skill, actor)) })),
			},
			players,
			...this.matchMemory.context(actor),
		};
	}

	/** Read only a few public fields; never serialize event graphs, storage, or private skill state. */
	private responseContext(event: any): DeepSeekResponseContext {
		const { game } = this.engine;
		const players = game.players.concat(game.dead || []);
		const playerId = (player: any) => (players.includes(player) ? this.playerId(player) : undefined);
		const publicCard = (card: any, source?: any, judgment = false) => (card && typeof card.name === "string" ? this.card(card, source || event.player, judgment) : undefined);
		const action = (value: any, judgment = false): DeepSeekPublicAction | undefined => {
			const card = publicCard(value?.card, value?.player || value?.target, judgment);
			if (!card) return undefined;
			const target = playerId(value.target);
			const targets = Array.isArray(value.targets) ? value.targets.flatMap((player: any) => (playerId(player) ? [playerId(player)!] : [])) : target ? [target] : [];
			return { kind: judgment ? "judgment" : "useCard", actor: playerId(value.player), target, targets, card };
		};
		const parent = (name: string) => {
			const value = event.getParent?.(name);
			return value?.name === name ? value : undefined; // getParent returns {} when no matching event exists.
		};
		const currentResponse: DeepSeekResponseContext["currentResponse"] = { type: plain(event.type || event.name) };
		if (Array.isArray(event.respondTo)) {
			const [source, card] = event.respondTo;
			const serialized = publicCard(card, source);
			if (serialized) currentResponse.respondTo = { source: playerId(source), card: serialized };
		}
		const pendingAction = action(parent("useCard"));
		// _wuxie passes a public effect map. _source is the original trick in a counter-counter chain.
		if (event.type === "wuxie" && event.info_map && typeof event.info_map === "object") {
			const map = event.info_map;
			const origin = map._source || map;
			currentResponse.counterspell = {
				state: event.state === -1 || map.state === -1 ? -1 : 1,
				originalAction: action(origin, Boolean(origin.isJudge)),
				immediateAction: action(map, Boolean(map.isJudge)),
			};
		}
		const dyingParent = parent("dying");
		const dying = players.includes(event.dying) ? event.dying : dyingParent?.player;
		if (playerId(dying)) currentResponse.dying = { target: playerId(dying)!, hp: dying.hp, maxHp: dying.maxHp, peachesNeeded: Math.max(1, 1 - dying.hp) };
		const damage = parent("damage");
		if (damage && playerId(damage.player)) {
			currentResponse.damage = {
				source: playerId(damage.source),
				target: playerId(damage.player)!,
				hp: damage.player.hp,
				amount: Number.isFinite(damage.num) ? damage.num : undefined,
				nature: typeof damage.nature === "string" ? plain(damage.nature) : undefined,
				card: publicCard(damage.card, damage.source),
			};
		}
		if (Number.isFinite(event.shaRequired)) currentResponse.requiredSha = event.shaRequired;
		if (Number.isFinite(event.shanRequired)) currentResponse.requiredShan = event.shanRequired;
		return { pendingAction, currentResponse };
	}

	private safeEvent(event: any) {
		return supportedEvents.has(event.name) && !event.skill && !event.processAI && !event.filterButton && !event.complexSelect && !event.complexCard && !event.complexTarget && !event.custom?.replace?.confirm;
	}

	private active(event: any) {
		return this.engine.status.event === event && !event.finished && !event.responded && !this.engine.status.over && !this.engine.status.connectMode && !this.engine.game.online;
	}

	private eligible(event: any) {
		return this.enabled() && this.active(event) && event.result === "ai" && event.player !== this.engine.game.me && !event.isMine() && !event.isOnline() && this.safeEvent(event);
	}

	private items(event: any) {
		const { game } = this.engine;
		return event.player.getCards("hejsx").concat(game.players, game.dead || []);
	}

	private clear(event: any) {
		const { ui } = this.engine;
		this.items(event).forEach((item: any) => {
			item.classList.remove("selected", "selectable");
			item.updateTransform?.(false);
		});
		ui.selected.cards.length = 0;
		ui.selected.targets.length = 0;
	}

	/** Synchronous only: all temporary selections are restored before any network await. */
	private transaction<T>(event: any, callback: () => T, keep: () => boolean = () => false): T {
		const { lib, ui, status, game } = this.engine;
		const cards = ui.selected.cards.slice();
		const targets = ui.selected.targets.slice();
		const flags = this.items(event).map((item: any) => [item, item.classList.contains("selected"), item.classList.contains("selectable")]);
		const autoConfirm = lib.config.auto_confirm;
		const touchNoCheck = status.touchnocheck;
		const imChoosing = status.imchoosing;
		const multitarget = status.multitarget;
		// touchnocheck also suppresses auto-confirm for skills marked `direct`.
		lib.config.auto_confirm = false;
		status.touchnocheck = true;
		try {
			this.clear(event);
			return callback();
		} finally {
			try {
				if (!keep()) {
					this.clear(event);
					ui.selected.cards.push(...cards);
					ui.selected.targets.push(...targets);
					flags.forEach(([item, selected, selectable]: any[]) => {
						item.classList.toggle("selected", selected);
						item.classList.toggle("selectable", selectable);
						item.updateTransform?.(selected);
					});
					// Rebuild controls / prompts for the original human selection, with auto-confirm suppressed.
					if (this.active(event)) game.check();
				}
			} finally {
				status.imchoosing = imChoosing;
				status.multitarget = multitarget;
				lib.config.auto_confirm = autoConfirm;
				status.touchnocheck = touchNoCheck;
			}
		}
	}

	private select(item: any, type: "cards" | "targets") {
		if (!item.classList.contains("selectable") || item.classList.contains("selected")) return false;
		item.classList.add("selected");
		this.engine.ui.selected[type].push(item);
		item.updateTransform?.(true);
		return true;
	}

	private collect(event: any): Move[] {
		if (!this.safeEvent(event) || this.engine.ui.selected.buttons.length) return [];
		if (event.name === "chooseBool") {
			return [{ candidate: { id: "yes", label: `同意 / 发动：${plain(event.prompt)}` }, cards: [], targets: [], kind: "bool", value: true }, ...(!event.forced ? [{ candidate: { id: "no", label: "拒绝 / 不发动" }, cards: [], targets: [], kind: "bool" as const, value: false }] : [])];
		}
		if (event.name === "chooseControl") {
			return (event.controls || []).slice(0, 32).flatMap((control: string, index: number) => {
				if (event.forced && control === "cancel2") return [];
				return [{ candidate: { id: `control-${index}`, label: `${plain(this.engine.get.translation(control))}${event.choiceList?.[index] ? `：${plain(event.choiceList[index])}` : ""}` }, cards: [], targets: [], kind: "control", value: control }];
			});
		}
		const { game, get, ui } = this.engine;
		return this.transaction(event, () => {
			const moves: Move[] = [];
			const seen = new Set<string>();
			let explored = 0;
			const replay = (cards: any[], targets: any[] = []) => {
				this.clear(event);
				game.check();
				for (const card of cards) {
					if (!ui.selected.cards.includes(card) && !this.select(card, "cards")) return false;
					game.check();
				}
				for (const target of targets) {
					if (!ui.selected.targets.includes(target) && !this.select(target, "targets")) return false;
					game.check();
				}
				return true;
			};
			const add = () => {
				if (!game.check() || moves.length >= 64) return;
				const cards = ui.selected.cards.slice(),
					targets = ui.selected.targets.slice();
				if (!cards.length && !targets.length) return;
				const key = JSON.stringify([cards.map((card: any) => card.cardid), targets.map((target: any) => this.playerId(target))]);
				if (seen.has(key)) return;
				seen.add(key);
				const cardData = cards.map((card: any) => this.card(card, event.player));
				const label = [event.name === "chooseToDiscard" ? "弃置" : "", cardData.map((card: any) => `${card.label}${card.rules ? `（${card.rules.slice(0, 110)}）` : ""}`).join("、"), targets.length ? `→ ${targets.map((target: any) => `${this.playerName(target, target === event.player)}（${target.hp}/${target.maxHp} 体力）`).join("、")}` : "", cardData.some((card: any) => ["nanman", "wanjian"].includes(card.name)) ? "群体伤害：评估所有受影响队友及敌人" : ""].filter(Boolean).join(" ").slice(0, 700);
				moves.push({ candidate: { id: `move-${moves.length}`, label, cards: cardData, targets: targets.map((target: any) => this.playerId(target)) }, cards, targets, kind: "play" });
			};
			const targetsForCard = () => {
				game.check();
				if (!event.filterTarget) return add();
				const [min, max] = get.select(event.selectTarget);
				const info = get.info(get.card()) || {};
				if (info.complexSelect || info.complexTarget || info.singleCard) return;
				if (max === -1 || max === 0) return add(); // engine-selected all targets / targetless card
				if (!Number.isFinite(max) || max > 3 || min > max || min < 0) return;
				const cards = ui.selected.cards.slice();
				const pool = game.players.concat(game.dead || []);
				const visitTargets = (selected: any[], start: number) => {
					if (++explored > 512 || moves.length >= 64 || !replay(cards, selected)) return;
					if (selected.length >= min) add();
					if (selected.length >= max) return;
					const available = pool.map((target: any, index: number) => ({ target, index })).filter(({ target, index }: any) => index >= start && target.classList.contains("selectable") && !target.classList.contains("selected"));
					for (const { target, index } of available) visitTargets(selected.concat(target), index + 1);
				};
				visitTargets([], 0);
			};
			game.check();
			if (!event.filterCard) {
				targetsForCard();
			} else {
				const [min, max] = get.select(event.selectCard);
				if (max === -1) targetsForCard();
				else {
					const cap = Math.min(max, 4);
					if (min < 0 || min > cap || cap < 1 || (!["chooseCard", "chooseToDiscard"].includes(event.name) && max !== 1)) return [];
					const pool = event.player.getCards(event.position);
					const visitCards = (selected: any[], start: number) => {
						if (++explored > 512 || moves.length >= 64 || !replay(selected)) return;
						if (selected.length >= min) targetsForCard();
						if (selected.length >= cap || !replay(selected)) return;
						const available = pool.map((card: any, index: number) => ({ card, index })).filter(({ card, index }: any) => index >= start && card.classList.contains("selectable") && !card.classList.contains("selected"));
						for (const { card, index } of available) visitCards(selected.concat(card), index + 1);
					};
					visitCards([], 0);
				}
			}
			if (!moves.length) return [];
			if (!event.forced && (!event.fakeforce || event.type === "phase")) {
				moves.push({ candidate: { id: "cancel", label: event.type === "phase" ? "结束出牌阶段" : "本次不出牌 / 不响应 / 不选择" }, cards: [], targets: [], kind: "cancel" });
			}
			moves.push({ candidate: { id: "builtin", label: "由原版 AI 决定（可发动技能或处理复杂选择）" }, cards: [], targets: [], kind: "builtin" });
			return moves;
		});
	}

	private packet(event: any, kind: "decision" | "advice" | "plan", moves: Move[], actor = event.player) {
		const state = { ...this.snapshot(actor), ...this.responseContext(event) };
		return {
			kind,
			event: `${event.name}${event.type ? `:${event.type}` : ""}`,
			player: state.self,
			state,
			prompt: [plain(typeof event.prompt === "string" ? event.prompt : ""), plain(event.prompt2), event.hsskill ? plain(this.engine.get.skillInfoTranslation(event.hsskill, actor)) : ""].filter(Boolean).join("\n"),
			candidates: moves.map(move => move.candidate),
		};
	}

	private fingerprint(event: any) {
		const { ui } = this.engine;
		return JSON.stringify([this.snapshot(event.player), this.responseContext(event), event.step, event.skill, event.forced, event.responded, event.controls, event.choiceList, ui.selected.cards.map((card: any) => card.cardid), ui.selected.targets.map((player: any) => this.playerId(player))]);
	}

	private commit(event: any, move: Move) {
		if (move.kind === "builtin") return false;
		if (move.kind === "bool") {
			if (event.forced && move.value === false) return false;
			event.result = { bool: move.value };
			return true;
		}
		if (move.kind === "control") {
			if (!event.controls?.includes(move.value) || (event.forced && move.value === "cancel2")) return false;
			event.result = { control: move.value, index: event.controls.indexOf(move.value) };
			return true;
		}
		let committed = false;
		return this.transaction(
			event,
			() => {
				const { game, ui } = this.engine;
				if (move.kind === "cancel") {
					if (event.forced || (event.fakeforce && event.type !== "phase")) return false;
					ui.click.cancel();
					return (committed = true);
				}
				game.check();
				for (const card of move.cards) {
					if (!ui.selected.cards.includes(card) && !this.select(card, "cards")) return false;
					game.check();
				}
				for (const target of move.targets) {
					// All-target cards are already selected by game.check().
					if (ui.selected.targets.includes(target)) continue;
					if (!this.select(target, "targets")) return false;
					game.check();
				}
				if (!game.check() || ui.selected.cards.length !== move.cards.length || ui.selected.targets.length !== move.targets.length) return false;
				if (!move.cards.every(card => ui.selected.cards.includes(card)) || !move.targets.every(target => ui.selected.targets.includes(target))) return false;
				ui.click.ok();
				event._aiexcludeclear = true;
				return (committed = true);
			},
			() => committed
		);
	}

	/** Phase-begin planning works even when this turn later contains only unsupported skill prompts. */
	public async planTurn(actor: any): Promise<void> {
		const { game, status } = this.engine;
		const allowed = () => this.enabled() && !status.connectMode && !game.online && !status.over && actor !== game.me && !actor?.isOnline?.() && game.players.includes(actor) && status.currentPhase === actor;
		if (!allowed()) return;
		const context = this.matchMemory.context(actor);
		if (!context.needsTurnPlan) return;
		const key = `${this.matchGeneration}:${this.playerId(actor)}:${context.turn}`;
		const existing = this.turnPlans.get(key);
		if (existing) return existing;
		const generation = this.matchGeneration;
		const phaseNumber = game.phaseNumber;
		const currentPhase = status.currentPhase;
		const roster = game.players.slice();
		const state = this.snapshot(actor);
		const fingerprint = JSON.stringify(state);
		const planning = (async () => {
			try {
				this.report(`${this.playerName(actor)}：DeepSeek 正在规划本回合…`, true);
				const reply = await this.request({ kind: "plan", event: "phaseBegin", player: state.self, state, candidates: [] });
				if (!allowed() || generation !== this.matchGeneration || game.phaseNumber !== phaseNumber || status.currentPhase !== currentPhase || roster.length !== game.players.length || !roster.every((player: any, index: number) => game.players[index] === player) || this.matchMemory.context(actor).turn !== context.turn || JSON.stringify(this.snapshot(actor)) !== fingerprint) return;
				if (reply.source !== "deepseek") throw new Error("No turn plan");
				this.matchMemory.remember(actor, { ...reply, plan: reply.plan || reply.advice });
				this.report(`${this.playerName(actor)}：本回合计划已就绪。`, true);
			} catch {
				this.report("本回合规划暂时不可用；后续出牌会重试或使用原版 AI。", true);
			}
		})();
		this.turnPlans.set(key, planning);
		try {
			await planning;
		} finally {
			if (this.turnPlans.get(key) === planning) this.turnPlans.delete(key);
		}
	}

	public async decide(event: any): Promise<boolean> {
		if (!this.eligible(event)) return false;
		try {
			const moves = this.collect(event);
			if (!moves.length) return false;
			const token = {};
			const generation = this.matchGeneration;
			this.pending.set(event, token);
			let fingerprint = this.fingerprint(event);
			if (this.matchMemory.context(event.player).needsTurnPlan) {
				this.report(`${this.playerName(event.player)}：DeepSeek 正在规划本回合…`, true);
				const plan = await this.request(this.packet(event, "plan", []));
				if (generation !== this.matchGeneration || !this.eligible(event) || this.fingerprint(event) !== fingerprint) return false;
				if (plan.source !== "deepseek") throw new Error("No turn plan");
				this.matchMemory.remember(event.player, { ...plan, plan: plan.plan || plan.advice });
				fingerprint = this.fingerprint(event);
			}
			this.report(`${this.playerName(event.player)}：DeepSeek 正在思考…`, true);
			const reply = await this.request(this.packet(event, "decision", moves));
			if (generation !== this.matchGeneration || this.pending.get(event) !== token || !this.eligible(event) || this.fingerprint(event) !== fingerprint) {
				this.report("局面已变化，本次使用原版 AI。", true);
				return false;
			}
			const move = moves.find(move => move.candidate.id === reply.choice);
			if (reply.source !== "deepseek" || !move || !this.commit(event, move)) {
				if (reply.source === "deepseek" && move?.kind === "builtin") this.matchMemory.remember(event.player, reply);
				this.report("本次使用原版 AI（技能、复杂选择或无效答案）。", true);
				return false;
			}
			this.matchMemory.remember(event.player, reply);
			// CPU reasoning includes its own secret role; only the selected public action is shown.
			const publicLabel = ["bool", "control"].includes(move.kind) ? "完成本次选择" : move.candidate.label;
			this.report(`${this.playerName(event.player)}：${publicLabel}`, true);
			return true;
		} catch {
			this.report("DeepSeek 暂时不可用，本次已切回原版 AI。", true);
			return false;
		}
	}

	public async advise(): Promise<void> {
		if (!this.enabled()) {
			this.report("请先勾选「启用 DeepSeek」，再获取建议。");
			return;
		}
		const { status, game } = this.engine;
		const event = status.event;
		if (status.connectMode || game.online || !game.me || !event || event.player !== game.me || !event.isMine?.() || !this.active(event)) {
			this.report("请在自己的选择或出牌提示出现时点击「给我建议」。");
			return;
		}
		try {
			const moves = this.collect(event);
			const generation = this.matchGeneration;
			const fingerprint = this.fingerprint(event);
			this.report("DeepSeek 正在分析你的手牌与公开局面…");
			const reply = await this.request(this.packet(event, "advice", moves, game.me));
			if (generation !== this.matchGeneration || !this.enabled() || !this.active(event) || this.fingerprint(event) !== fingerprint) {
				this.report("局面或你的选择已变化，请重新获取建议。");
				return;
			}
			if (reply.source !== "deepseek") throw new Error("No DeepSeek advice");
			this.matchMemory.remember(game.me, reply);
			const chosen = moves.find(move => move.candidate.id === reply.choice);
			this.report(`${chosen ? `建议：${chosen.candidate.label}\n` : ""}${plain(reply.advice) || "当前没有明确建议。"}`);
		} catch {
			this.report("暂时无法获取 DeepSeek 建议，请稍后重试。");
		}
	}
}
