/** Local match replay and AI audit data. Never send this bundle to a model API. */
export type RecordJSON = null | boolean | number | string | RecordJSON[] | { [key: string]: RecordJSON };

export interface NativeVideo {
	type: string;
	player?: RecordJSON;
	content?: RecordJSON;
	delay?: number;
	[key: string]: RecordJSON | undefined;
}

export interface RecordedPlayer {
	id: string;
	position: string;
	name: string;
	human: boolean;
}

export interface TraceEntry extends Record<string, unknown> {
	sequence: number;
	traceId: string;
	recordId: string;
	timestamp: number;
	elapsedMs: number;
	actor: string;
	round: number;
	phase: string;
	/** Number of native events present at this trace boundary. */
	videoCursor: number;
	/** Zero-based last event index; -1 when the native stream is still empty. */
	videoIndex: number;
	videoTimeMs: number;
}

export interface DeepSeekMatchRecord {
	version: 1;
	id: string;
	title: string;
	startedAt: number;
	endedAt?: number;
	mode: string;
	videoName?: RecordJSON;
	video: NativeVideo[];
	decisions: TraceEntry[];
	players?: RecordedPlayer[];
}

export interface MatchRecordSummary {
	id: string;
	title: string;
	startedAt: number;
	endedAt?: number;
	mode: string;
	videoCount: number;
	decisionCount: number;
}

export interface MatchRecordStore {
	put(record: DeepSeekMatchRecord): Promise<void>;
	get(id: string): Promise<DeepSeekMatchRecord | undefined>;
	list(): Promise<MatchRecordSummary[]>;
	delete(id: string): Promise<void>;
}

interface RecorderEngine {
	game: any;
	lib: any;
	get: any;
	status: any;
}

interface RecorderOptions {
	debounceMs?: number;
	maxRecords?: number;
	now?: () => number;
	createId?: () => string;
}

const usageCounterKeys = new Set(["promptTokens", "completionTokens", "totalTokens", "cacheHitTokens", "cacheMissTokens"]);

function scrubText(value: string) {
	return value
		.replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
		.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[redacted]");
}

/** Only plain JSON values survive: no engine events, players, DOM nodes or credentials. */
export function sanitizeRecordData(value: unknown): RecordJSON | undefined {
	const seen = new WeakSet<object>();
	function visit(item: any, depth = 0): RecordJSON | undefined {
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "string") return scrubText(item);
		if (typeof item === "number") return Number.isFinite(item) ? item : null;
		if (typeof item === "bigint") return String(item);
		if (typeof item !== "object") return undefined;
		if (seen.has(item)) return "[omitted: circular reference]";
		if (depth > 64) return "[omitted: excessive nesting]";
		try {
			if (item instanceof Date) return item.toISOString();
			if (item instanceof Error) {
				const error: { [key: string]: RecordJSON } = { name: scrubText(item.name), message: scrubText(item.message) };
				for (const key of ["code", "status", "usage"]) {
					const child = visit((item as unknown as Record<string, unknown>)[key], depth + 1);
					if (child !== undefined) error[key] = child;
				}
				return error;
			}
			if (typeof item.nodeType === "number" || typeof item.getCards === "function" || typeof item.getParent === "function" || item.classList || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item))) return "[omitted: runtime object]";
			seen.add(item);
			if (Array.isArray(item)) return item.map(element => visit(element, depth + 1) ?? null);
			const result: { [key: string]: RecordJSON } = {};
			for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
				if (["__proto__", "constructor", "prototype"].includes(key)) continue;
				const safeKey = scrubText(key);
				if (/api[_-]?key|authorization|password|passwd|secret|cookie|token|headers/i.test(key) && !(usageCounterKeys.has(key) && typeof descriptor.value === "number" && Number.isFinite(descriptor.value))) {
					result[safeKey] = "[redacted]";
					continue;
				}
				if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) continue;
				const child = visit(descriptor.value, depth + 1);
				if (child !== undefined) result[safeKey] = child;
			}
			return result;
		} catch {
			return "[omitted: unreadable object]";
		} finally {
			seen.delete(item);
		}
	}
	return visit(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function summary(record: DeepSeekMatchRecord): MatchRecordSummary {
	return { id: record.id, title: record.title, startedAt: record.startedAt, ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}), mode: record.mode, videoCount: record.video.length, decisionCount: record.decisions.length };
}

export interface RecordUsageCounters {
	requestCount: number;
	knownUsageCount: number;
	unknownUsageCount: number;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	cacheHitTokens: number | null;
	cacheMissTokens: number | null;
}

export interface RecordUsageSummary extends RecordUsageCounters {
	cpu: RecordUsageCounters;
	advice: RecordUsageCounters;
}

/** Actual provider usage only; starts without a terminal result remain explicitly unknown. */
export function summarizeRecordUsage(record: DeepSeekMatchRecord): RecordUsageSummary {
	const empty = (): RecordUsageCounters => ({ requestCount: 0, knownUsageCount: 0, unknownUsageCount: 0, promptTokens: null, completionTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null });
	const result: RecordUsageSummary = { ...empty(), cpu: empty(), advice: empty() };
	const requests = new Map<string, { kind: unknown; usage: any }>();
	for (const entry of record.decisions) {
		if (!["start", "complete", "error"].includes(String(entry.stage))) continue;
		const key = typeof entry.requestId === "string" ? entry.requestId : `trace-${entry.sequence}`;
		const previous = requests.get(key);
		const usage = (entry.result as any)?.usage ?? (entry.error as any)?.usage ?? entry.usage;
		requests.set(key, { kind: entry.kind ?? (entry.input as any)?.kind ?? previous?.kind, usage: usage ?? previous?.usage });
	}
	const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	for (const request of requests.values()) {
		const known = request.usage && ["promptTokens", "completionTokens", "totalTokens"].every(key => valid(request.usage[key]));
		for (const counters of [result, request.kind === "advice" ? result.advice : result.cpu]) {
			counters.requestCount++;
			if (!known) {
				counters.unknownUsageCount++;
				continue;
			}
			counters.knownUsageCount++;
			for (const key of ["promptTokens", "completionTokens", "totalTokens", "cacheHitTokens", "cacheMissTokens"] as const) {
				if (valid(request.usage[key])) counters[key] = (counters[key] ?? 0) + request.usage[key];
			}
		}
	}
	return result;
}

/** Useful for tests and browsers where durable storage is unavailable. */
export class MemoryMatchRecordStore implements MatchRecordStore {
	private records = new Map<string, DeepSeekMatchRecord>();
	async put(record: DeepSeekMatchRecord) {
		this.records.set(record.id, clone(record));
	}
	async get(id: string) {
		const record = this.records.get(id);
		return record ? clone(record) : undefined;
	}
	async list() {
		return [...this.records.values()].map(summary);
	}
	async delete(id: string) {
		this.records.delete(id);
	}
}

/** Separate from Noname's native DB so its migrations cannot erase the AI audit log. */
export class IndexedDBMatchRecordStore implements MatchRecordStore {
	private database?: Promise<IDBDatabase>;
	constructor(private factory: IDBFactory | undefined = globalThis.indexedDB) {}
	private open() {
		return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
			if (!this.factory) return reject(new Error("Browser record storage unavailable"));
			const request = this.factory.open("noname-deepseek-records", 1);
			let settled = false;
			const timeout = setTimeout(() => finish(new Error("Browser record storage timed out")), 5000);
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (error) reject(error);
				else resolve(request.result);
			};
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains("matches")) request.result.createObjectStore("matches", { keyPath: "id" });
			};
			request.onsuccess = () => {
				if (settled) request.result.close();
				else {
					request.result.onversionchange = () => {
						request.result.close();
						this.database = undefined;
					};
					finish();
				}
			};
			request.onerror = () => finish(new Error("Browser record storage failed to open"));
			request.onblocked = () => finish(new Error("Browser record storage upgrade blocked"));
		}).catch(error => {
			this.database = undefined;
			throw error;
		}));
	}
	private async operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const database = await this.open();
		return new Promise<T>((resolve, reject) => {
			const transaction = database.transaction("matches", mode);
			const request = run(transaction.objectStore("matches"));
			let result: T;
			const timer = setTimeout(() => {
				try {
					transaction.abort();
				} catch {}
				reject(new Error("Browser record storage timed out"));
			}, 5000);
			request.onsuccess = () => {
				result = request.result;
			};
			transaction.oncomplete = () => {
				clearTimeout(timer);
				resolve(result);
			};
			transaction.onabort = transaction.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Browser record storage transaction failed"));
			};
		});
	}
	async put(record: DeepSeekMatchRecord) {
		await this.operation("readwrite", store => store.put(record));
	}
	async get(id: string) {
		return this.operation<DeepSeekMatchRecord | undefined>("readonly", store => store.get(id));
	}
	async list() {
		return (await this.operation<DeepSeekMatchRecord[]>("readonly", store => store.getAll())).map(summary);
	}
	async delete(id: string) {
		await this.operation("readwrite", store => store.delete(id));
	}
}

const installed = new WeakMap<object, Set<DeepSeekMatchRecorder>>();

export class DeepSeekMatchRecorder {
	public lastError: string | null = null;
	private active: DeepSeekMatchRecord | null = null;
	private nativeSource: any[] | null = null;
	private nativeCursor = 0;
	private nativeTime = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private writes: Promise<void> = Promise.resolve();
	private installed = false;
	private store: MatchRecordStore;
	private now: () => number;
	private createId: () => string;
	private debounceMs: number;
	private maxRecords: number;

	constructor(
		private engine: RecorderEngine,
		store?: MatchRecordStore,
		options: RecorderOptions = {}
	) {
		this.now = options.now || Date.now;
		this.createId = options.createId || (() => globalThis.crypto?.randomUUID?.() || `match-${this.now()}-${Math.random().toString(36).slice(2)}`);
		this.debounceMs = options.debounceMs ?? 1000;
		this.maxRecords = Math.max(1, options.maxRecords ?? 30);
		if (store) this.store = store;
		else {
			try {
				if (!globalThis.indexedDB) throw new Error("unavailable");
				this.store = new IndexedDBMatchRecordStore();
			} catch {
				this.store = new MemoryMatchRecordStore();
				this.lastError = "浏览器存储不可用，当前记录仅保存在内存中；请及时导出。";
			}
		}
	}

	public install() {
		if (this.installed) return this;
		this.installed = true;
		const { game, lib } = this.engine;
		let recorders = installed.get(game);
		if (!recorders) {
			recorders = new Set();
			installed.set(game, recorders);
			const original = game.addVideo;
			game.addVideo = function (this: unknown, ...args: unknown[]) {
				try {
					return original.apply(this, args);
				} finally {
					for (const recorder of recorders!) recorder.captureSafely();
				}
			};
		}
		recorders.add(this);
		(lib.onover ||= []).push(() => {
			if (this.engine.status.video) return;
			this.captureSafely();
			if (this.active) this.active.endedAt ??= this.now();
			void this.flush();
		});
		if (typeof window !== "undefined") {
			window.addEventListener("pagehide", () => void this.flush());
			window.addEventListener("beforeunload", () => void this.flush());
		}
		if (typeof document !== "undefined")
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "hidden") void this.flush();
			});
		this.captureSafely();
		return this;
	}

	private report(message: string) {
		if (this.lastError !== message) console.warn(message);
		this.lastError = message;
	}

	private actorId(value: any): string {
		return typeof value === "string" ? scrubText(value) : String(value?.playerid ?? value?.id ?? value?.dataset?.position ?? "");
	}

	private metadata() {
		if (!this.active) return;
		const { game } = this.engine;
		this.active.players = (game.players || []).concat(game.dead || []).map((player: any) => ({ id: this.actorId(player), position: String(player.dataset?.position ?? ""), name: scrubText(String(player.name || player.name1 || "")), human: player === game.me }));
		try {
			if (typeof game.getVideoName === "function") this.active.videoName = sanitizeRecordData(game.getVideoName());
		} catch {}
	}

	public startMatch(): DeepSeekMatchRecord | null {
		if (this.engine.status.video || this.engine.game.online) return null;
		const source = Array.isArray(this.engine.lib.video) ? this.engine.lib.video : [];
		if (this.active && source === this.nativeSource && source.length >= this.nativeCursor && this.active.endedAt === undefined) {
			this.captureSafely();
			return this.active;
		}
		if (this.active) {
			this.active.endedAt ??= this.now();
			void this.persist(clone(this.active));
		}
		const startedAt = this.now();
		const mode = scrubText(String(this.engine.lib.config?.mode || "unknown"));
		this.active = { version: 1, id: this.createId(), title: `${mode} · ${new Date(startedAt).toLocaleString("zh-CN", { hour12: false })}`, startedAt, mode, video: [], decisions: [] };
		this.nativeSource = source;
		this.nativeCursor = 0;
		this.nativeTime = 0;
		this.metadata();
		this.readNative(source);
		this.schedule();
		return this.active;
	}

	private readNative(source: any[]) {
		if (!this.active) return;
		for (; this.nativeCursor < source.length; this.nativeCursor++) {
			const event = sanitizeRecordData(source[this.nativeCursor]) as unknown as NativeVideo;
			this.active.video.push(event);
			this.nativeTime += Math.max(0, Number(event?.delay) || 0);
			if (event?.type === "init") this.metadata();
			if (event?.type === "over") this.active.endedAt ??= this.now();
		}
	}

	private capture() {
		const { lib, status, game } = this.engine;
		if (status.video || game.online || !Array.isArray(lib.video)) return;
		if (!this.active) {
			if (lib.video.length || status.videoInited) this.startMatch();
			return;
		}
		if (lib.video !== this.nativeSource || lib.video.length < this.nativeCursor) {
			if (this.nativeSource) this.readNative(this.nativeSource);
			this.startMatch();
			return;
		}
		if (this.nativeCursor < lib.video.length) {
			this.readNative(lib.video);
			this.schedule();
		}
	}

	private captureSafely() {
		try {
			this.capture();
		} catch {
			this.report("牌局记录暂时无法更新，请导出现有记录后重试。");
		}
	}

	private schedule() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.debounceMs);
		(this.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	}

	public append(entry: Record<string, unknown>) {
		if (this.engine.status.video || this.engine.game.online) return;
		try {
			this.capture();
			if (!this.active) this.startMatch();
			if (!this.active) return;
			this.metadata();
			const data = sanitizeRecordData(entry) as Record<string, unknown>;
			const { game, status } = this.engine;
			const sequence = this.active.decisions.length + 1;
			const timestamp = this.now();
			const request = (data.request || data.input || data.packet) as any;
			const actor = this.actorId(entry.actor || entry.actorId || request?.player?.id || status.event?.player || status.currentPhase);
			const round = Number(data.round ?? game.roundNumber ?? 0);
			this.active.decisions.push({ ...data, sequence, traceId: `${this.active.id}:trace-${sequence}`, recordId: this.active.id, timestamp, elapsedMs: Math.max(0, timestamp - this.active.startedAt), actor, round: Number.isFinite(round) ? round : 0, phase: scrubText(String(data.phase ?? status.event?.name ?? "")), videoCursor: this.active.video.length, videoIndex: this.active.video.length - 1, videoTimeMs: this.nativeTime });
			this.schedule();
		} catch {
			this.report("AI 决策记录暂时无法更新，游戏仍可继续。");
		}
	}

	public current() {
		this.captureSafely();
		return this.active;
	}

	private persist(record: DeepSeekMatchRecord) {
		let succeeded = false;
		const write = this.writes
			.then(async () => {
				await this.store.put(record);
				const records = (await this.store.list()).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
				let excess = records.length - this.maxRecords;
				for (const old of records.slice().reverse()) {
					if (excess <= 0) break;
					if (old.id === this.active?.id) continue;
					await this.store.delete(old.id);
					excess--;
				}
				if (this.store instanceof IndexedDBMatchRecordStore || this.lastError?.includes("未能保存")) this.lastError = null;
				succeeded = true;
			})
			.catch(() => {
				this.report("牌局记录未能保存到浏览器；游戏仍可继续，请及时导出记录。");
			});
		this.writes = write;
		return write.then(() => succeeded);
	}

	public async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.captureSafely();
		try {
			if (this.active) await this.persist(clone(this.active));
			else await this.writes;
		} catch {
			this.report("牌局记录未能保存到浏览器；游戏仍可继续，请及时导出记录。");
		}
	}

	public async listRecords(): Promise<MatchRecordSummary[]> {
		await this.flush();
		try {
			const records = await this.store.list();
			if (this.active && !records.some(record => record.id === this.active!.id)) records.push(summary(this.active));
			return records.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
		} catch {
			this.report("无法读取浏览器中的牌局记录；当前记录仍可导出。");
			return this.active ? [summary(this.active)] : [];
		}
	}

	public async loadRecord(id: string): Promise<DeepSeekMatchRecord> {
		this.captureSafely();
		if (this.active?.id === id) return clone(this.active);
		try {
			const record = await this.store.get(id);
			if (!record) throw new Error("missing");
			return clone(record);
		} catch {
			this.report("牌局记录不存在或暂时无法读取。");
			throw new Error("牌局记录不存在或暂时无法读取。");
		}
	}

	public async exportRecord(id: string): Promise<DeepSeekMatchRecord> {
		return sanitizeRecordData(await this.loadRecord(id)) as unknown as DeepSeekMatchRecord;
	}

	public async importRecord(input: unknown): Promise<DeepSeekMatchRecord> {
		const data = sanitizeRecordData(input) as unknown as DeepSeekMatchRecord;
		if (!data || typeof data !== "object" || data.version !== 1 || typeof data.id !== "string" || !data.id || data.id.length > 200 || typeof data.title !== "string" || data.title.length > 500 || !Number.isFinite(data.startedAt) || (data.endedAt !== undefined && !Number.isFinite(data.endedAt)) || typeof data.mode !== "string" || data.mode.length > 100 || !Array.isArray(data.video) || !Array.isArray(data.decisions) || data.video.some(video => !video || typeof video !== "object" || typeof video.type !== "string" || ["__proto__", "prototype", "constructor"].includes(video.type)) || data.decisions.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("牌局记录格式无效，请选择本地导出的 JSON 文件。");
		// Importing a bundle never makes it the active match and never rewinds its current stream.
		if (data.id === this.active?.id) {
			data.id = this.createId();
			data.decisions.forEach((entry, index) => {
				entry.recordId = data.id;
				entry.traceId = `${data.id}:trace-${entry.sequence || index + 1}`;
			});
		}
		if (!(await this.persist(data))) throw new Error("牌局记录未能保存到浏览器，请保留原始 JSON 文件。");
		return clone(data);
	}
}
