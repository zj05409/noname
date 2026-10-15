/** Public action history and per-player strategic memory, independent of network access. */
interface MemoryEngine {
	game: any;
	get: any;
	lib: any;
	status: any;
}

interface Belief {
	id: string;
	role: string;
	confidence: number;
	reason: string;
}

interface PlayerMemory {
	plan: string;
	memory: string;
	beliefs: Belief[];
	plannedTurn: string;
}

interface PublicAction {
	sequence?: number;
	round?: number;
	turn?: number;
	kind: string;
	actor?: string;
	source?: string;
	targets?: string[];
	card?: string;
	amount?: number;
	cards?: string[];
}

const roles = new Set(["zhu", "zhong", "fan", "nei", "unknown"]);
const text = (value: unknown, limit = 1500) => String(value ?? "").replace(/<[^>]*>/g, "").slice(0, limit);

/** Keeps each computer's hypotheses separate and never reads another player's true role. */
export class DeepSeekMatchMemory {
	private memories = new Map<string, PlayerMemory>();
	private actions: PublicAction[] = [];
	private seen = new WeakMap<object, Set<string>>();
	private sequence = 0;
	private omniscient = true;
	private trends = new Map<string, { cardUses: Record<string, number>; damage: Record<string, number>; healing: Record<string, number>; draws: number; discards: number }>();

	constructor(private engine: MemoryEngine) {}

	public setOmniscient(enabled: boolean) {
		if (this.omniscient !== enabled) this.memories.clear();
		this.omniscient = enabled;
	}

	public isOmniscient() {
		return this.omniscient;
	}

	public clear() {
		this.memories.clear();
		this.actions.length = 0;
		this.trends.clear();
		this.seen = new WeakMap();
		this.sequence = 0;
	}

	private id(player: any) {
		const { game } = this.engine;
		return String(player?.playerid ?? `seat-${game.players.concat(game.dead || []).indexOf(player) + 1}`);
	}

	private turn() {
		const { game, status } = this.engine;
		return `${game.phaseNumber || 0}:${status.currentPhase ? this.id(status.currentPhase) : "setup"}`;
	}

	private forPlayer(actor: any) {
		const id = this.id(actor);
		if (!this.memories.has(id)) this.memories.set(id, { plan: "", memory: "", beliefs: [], plannedTurn: "" });
		return this.memories.get(id)!;
	}

	public context(actor: any) {
		const saved = this.forPlayer(actor);
		const { game, status } = this.engine;
		return {
			knowledgeMode: this.omniscient ? "omniscient" : "known",
			turn: this.turn(),
			needsTurnPlan: !saved.plan || (status.currentPhase === actor && saved.plannedTurn !== this.turn()),
			plan: saved.plan,
			memory: saved.memory,
			identityBeliefs: saved.beliefs.map(belief => ({ ...belief })),
			actionsObserved: this.sequence,
			recentActions: this.actions.slice(-64).map(action => ({ ...action, targets: action.targets?.slice(), cards: action.cards?.slice() })),
			playerTrends: game.players.concat(game.dead || []).map((player: any) => {
				const id = this.id(player), trend = this.trends.get(id);
				const limited = (counts: Record<string, number> = {}) => Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 32));
				return { id, cardUses: limited(trend?.cardUses), damage: limited(trend?.damage), healing: limited(trend?.healing), draws: trend?.draws || 0, discards: trend?.discards || 0 };
			}),
			strategyGoals: ["根据公开身份和行动推断阵营并保留不确定性", "权衡留桃自救与救队友", "群体锦囊评估各人的防御牌和阵营收益", "无懈可击评估关键收益、后续反无懈和资源", "内奸平衡主反双方，准备单挑和爆发"],
		};
	}

	public remember(actor: any, reply: { plan?: string; memory?: string; identityBeliefs?: Belief[] }) {
		const saved = this.forPlayer(actor);
		if (typeof reply.plan === "string" && reply.plan.trim()) {
			saved.plan = text(reply.plan, 2500);
			saved.plannedTurn = this.turn();
		}
		if (typeof reply.memory === "string") saved.memory = text(reply.memory, 2500);
		if (Array.isArray(reply.identityBeliefs)) {
			const ids = new Set(this.engine.game.players.concat(this.engine.game.dead || []).map((player: any) => this.id(player)));
			saved.beliefs = reply.identityBeliefs.slice(0, 32).filter(belief => ids.has(belief.id) && roles.has(belief.role) && Number.isFinite(belief.confidence)).map(belief => ({
				id: belief.id, role: belief.role, confidence: Math.max(0, Math.min(1, belief.confidence)), reason: text(belief.reason, 500),
			}));
		}
	}

	/** Record only a sanitized public action; draw/gain records never include hidden card names. */
	public record(action: PublicAction) {
		const { game } = this.engine;
		const safe: PublicAction = {
			sequence: ++this.sequence, round: game.roundNumber || 0, turn: game.phaseNumber || 0,
			kind: text(action.kind, 40),
			...(action.actor ? { actor: text(action.actor, 100) } : {}),
			...(action.source ? { source: text(action.source, 100) } : {}),
			...(action.targets ? { targets: action.targets.slice(0, 32).map(id => text(id, 100)) } : {}),
			...(action.card ? { card: text(action.card, 100) } : {}),
			...(Number.isFinite(action.amount) ? { amount: action.amount } : {}),
			...(action.cards ? { cards: action.cards.slice(0, 32).map(card => text(card, 100)) } : {}),
		};
		this.actions.push(safe);
		if (this.actions.length > 128) this.actions.shift();
		const source = safe.source || safe.actor;
		if (!source) return;
		if (!this.trends.has(source)) this.trends.set(source, { cardUses: {}, damage: {}, healing: {}, draws: 0, discards: 0 });
		const trend = this.trends.get(source)!;
		if (safe.kind === "useCard" && safe.card) trend.cardUses[safe.card] = (trend.cardUses[safe.card] || 0) + 1;
		if (safe.kind === "damage" || safe.kind === "recover") {
			const table = safe.kind === "damage" ? trend.damage : trend.healing;
			for (const target of safe.targets || []) table[target] = (table[target] || 0) + (safe.amount || 0);
		}
		if (safe.kind === "gain") trend.draws += safe.amount || 0;
		if (safe.kind === "discard") trend.discards += safe.amount || 0;
	}

	public observe(kind: string, trigger: any) {
		if (!trigger || typeof trigger !== "object") return;
		let kinds = this.seen.get(trigger);
		if (!kinds) this.seen.set(trigger, kinds = new Set());
		if (kinds.has(kind)) return;
		kinds.add(kind);
		const { get } = this.engine;
		const actor = trigger.player ? this.id(trigger.player) : undefined;
		if (["phaseBegin", "roundStart"].includes(kind)) this.record({ kind: kind === "phaseBegin" ? "turnBegin" : "roundBegin", actor });
		else if (["useCardAfter", "respondAfter"].includes(kind)) this.record({
			kind: kind === "useCardAfter" ? "useCard" : "respond", actor,
			card: text(get.name(trigger.card, trigger.player), 100),
			targets: (trigger.targets || []).map((target: any) => this.id(target)),
		});
		else if (["damageEnd", "recoverEnd"].includes(kind)) this.record({
			kind: kind === "damageEnd" ? "damage" : "recover", actor,
			source: trigger.source ? this.id(trigger.source) : actor,
			targets: actor ? [actor] : [], amount: Number(trigger.num) || 0,
		});
		else if (kind === "gainAfter") this.record({ kind: "gain", actor, amount: trigger.cards?.length || 0 });
		else if (kind === "loseAfter" && trigger.type === "discard") this.record({
			kind: "discard", actor, amount: (trigger.cards2 || trigger.cards || []).length,
			cards: (trigger.cards2 || trigger.cards || []).map((card: any) => text(get.name(card, trigger.player), 100)),
		});
	}
}

/** Observe once through the local player's rule skill, including after their death. */
export function installStrategicObserver(engine: MemoryEngine, memory: DeepSeekMatchMemory, planTurn?: (actor: any) => Promise<void>) {
	const name = "_deepseek_public_history";
	engine.lib.skill[name] = {
		trigger: { global: ["useCardAfter", "respondAfter", "damageEnd", "recoverEnd", "loseAfter", "gainAfter", "phaseBegin", "roundStart"] },
		silent: true, charlotte: true, ruleSkill: true, forceDie: true, forceOut: true, popup: false, lastDo: true,
		filter(_trigger: any, owner: any) {
			return owner === engine.game.me && !engine.status.connectMode && !engine.game.online;
		},
		async content(event: any, trigger: any, _player: any) {
			try {
				memory.observe(event.triggername, trigger);
				if (event.triggername === "phaseBegin" && planTurn) await planTurn(trigger.player);
			} catch {
				// Observing history must never interrupt the game or affect a skill's result.
			}
		},
	};
	engine.game.addGlobalSkill(name);
}
