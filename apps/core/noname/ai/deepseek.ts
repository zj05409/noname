import { _status, ai, game, get, lib, ui } from "noname";
import { DeepSeekPolicy, type DeepSeekReply } from "./deepseek-policy";
import { installStrategicObserver } from "./deepseek-strategy";
import { DeepSeekMatchRecorder, summarizeRecordUsage } from "./deepseek-recorder";

const preferences = { master: "noname-deepseek-enabled", computer: "noname-deepseek-computer", advice: "noname-deepseek-advice", source: "noname-advice-source" };
function preference(name: string, fallback: boolean) {
	try { const value = localStorage.getItem(name); return value === null ? fallback : value === "true"; } catch { return fallback; }
}
let enabled = preference(preferences.master, false);
let computerEnabled = preference(preferences.computer, true);
let adviceEnabled = preference(preferences.advice, true);
let adviceSource = "builtin";
try { if (localStorage.getItem(preferences.source) === "deepseek") adviceSource = "deepseek"; } catch {}
const useComputer = () => enabled && computerEnabled && !_status.video && !_status.playback;
const useAdvice = () => enabled && adviceEnabled && !_status.video && !_status.playback;
const pending = new Map<AbortController, boolean>();
let adviceNode: HTMLElement | undefined, computerNode: HTMLElement | undefined;
let policy: DeepSeekPolicy | undefined, recorder: DeepSeekMatchRecorder | undefined;
let refreshControls = () => {};

function getRecorder() {
	return (recorder ??= new DeepSeekMatchRecorder({ game, get, lib, status: _status }));
}
export const getDeepSeekRecorder = () => getRecorder();

async function request(packet: Record<string, unknown>): Promise<DeepSeekReply> {
	const controller = new AbortController(), isComputer = packet.kind !== "advice";
	pending.set(controller, isComputer);
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, isComputer ? 22000 : 50000);
	try {
		const response = await fetch("/api/deepseek/decision", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet), signal: controller.signal,
		});
		const reply = await response.json().catch(() => null);
		if (!response.ok) throw Object.assign(new Error(typeof reply?.message === "string" ? reply.message : `请求失败（HTTP ${response.status}）`), {
			code: reply?.error || "http_error", status: response.status, usage: reply?.usage, requestId: reply?.requestId,
		});
		if (!reply || typeof reply.advice !== "string" || !(reply.choice === null || typeof reply.choice === "string")) throw Object.assign(new Error("服务返回的建议格式无效。"), { code: "invalid_reply" });
		return reply;
	} catch (error) {
		if (controller.signal.aborted) throw Object.assign(new Error(timedOut ? "等待模型响应超时。" : "请求已取消。"), { code: timedOut ? "client_timeout" : "canceled" });
		if (error instanceof TypeError) throw Object.assign(new Error("无法连接本机建议服务，请重新运行游戏启动文件。"), { code: "network_error" });
		throw error;
	} finally { clearTimeout(timeout); pending.delete(controller); }
}

function getPolicy() {
	return (policy ??= new DeepSeekPolicy(
		{ ai, game, get, lib, ui, status: _status }, request, useComputer,
		(text, computer = false) => {
			const node = computer ? computerNode : adviceNode;
			if (node) node.textContent = computer && !useComputer() ? "电脑使用原版 AI，不调用模型。" : text;
		}, useAdvice, entry => getRecorder().append(entry)
	));
}
export const tryDeepSeekDecision = (event: any) => getPolicy().decide(event);
export const getDeepSeekMatchMemory = () => getPolicy().matchMemory;
/** Observe an already completed native AI result without changing engine state. */
export function recordBuiltinDecision(event: any) {
	if (_status.video || _status.playback || _status.connectMode || game.online || !event?.player || event.player === game.me) return;
	try {
		const result = event.result || {}, card = (value: any) => ({ name: get.translation(value.name), suit: get.translation(value.suit), number: value.number, id: String(value.cardid || "") });
		const selected = {
			...(typeof result.bool === "boolean" ? { bool: result.bool } : {}),
			...(typeof result.control === "string" ? { control: get.translation(result.control) } : {}),
			...(Number.isInteger(result.index) ? { index: result.index } : {}),
			...(typeof result.skill === "string" ? { skill: get.translation(result.skill) } : {}),
			...(typeof result.used === "string" || typeof result.used === "boolean" ? { used: result.used } : {}),
			...(typeof result.confirm === "string" ? { confirm: result.confirm } : {}),
			...(result.card && typeof result.card.name === "string" ? { card: { ...card(result.card), nature: get.translation(result.card.nature) } } : {}),
			...(Array.isArray(result.cards) ? { cards: result.cards.map(card) } : {}),
			...(Array.isArray(result.targets) ? { targets: result.targets.map((player: any) => ({ id: String(player.playerid || player.dataset?.position || ""), name: get.translation(player.name) })) } : {}),
			...(result.buttons?.length || result.links?.length ? { note: "此复杂选择包含按钮或自定义对象；公开执行过程见关联录像。" } : {}),
		};
		getRecorder().append({ type: "ai_outcome", kind: "decision", source: "builtin", status: "completed", event: event.name, actorId: String(event.player.playerid || event.player.dataset?.position || ""), actorName: get.translation(event.player.name), result: selected, executed: true });
	} catch { /* Recording cannot interrupt native AI. */ }
}

function savePreferences() {
	try {
		localStorage.setItem(preferences.master, String(enabled)); localStorage.setItem(preferences.computer, String(computerEnabled)); localStorage.setItem(preferences.advice, String(adviceEnabled));
		localStorage.setItem(preferences.source, adviceSource);
	} catch {}
	for (const [controller, computer] of pending) if (computer ? !useComputer() : !useAdvice() || adviceSource !== "deepseek") controller.abort();
	refreshControls();
}

export function mountDeepSeekPanel() {
	getPolicy().resetMatch(); getPolicy().matchMemory.setOmniscient(false);
	getRecorder().install();
	if (document.getElementById("noname-deepseek-root")) return;
	installStrategicObserver({ game, get, lib, status: _status }, getPolicy().matchMemory, actor => getPolicy().planTurn(actor));
	const root = document.createElement("div"); root.id = "noname-deepseek-root";
	const style = document.createElement("style");
	style.textContent = `
#noname-deepseek-root{position:static;display:block;font:14px/1.65 system-ui,sans-serif;color:#eee;text-shadow:none;letter-spacing:normal}
#noname-deepseek-root :where(div){position:static;display:block;transition:none}
#noname-deepseek-root *{box-sizing:border-box}
#noname-deepseek-root button{font:inherit;color:#f5eedf;background:#443d2c;border:1px solid #9c8657;border-radius:6px;padding:6px 12px;cursor:pointer;margin:0;white-space:normal}
#noname-deepseek-root button:disabled{opacity:.45;cursor:default}
#noname-deepseek-root button:focus-visible,#noname-deepseek-root input:focus-visible{outline:2px solid #ffd788;outline-offset:2px}
#noname-deepseek-toolbar{position:fixed;top:8px;right:12px;z-index:2147483645;display:flex;gap:6px;align-items:center;padding:5px;background:#171c24ed;border:1px solid #79663e;border-radius:9px;box-shadow:0 2px 10px #0008}
#noname-deepseek-toolbar button{font-size:12px;padding:3px 9px}
#noname-deepseek-backdrop{position:fixed;inset:0;z-index:2147483647;background:#000b;display:flex;align-items:center;justify-content:center;padding:16px;isolation:isolate}
#noname-deepseek-backdrop[hidden]{display:none}
#noname-deepseek-panel{width:min(960px,100%);height:min(820px,calc(100dvh - 32px));max-height:calc(100dvh - 32px);background:#171c24;border:1px solid #b59b64;border-radius:12px;box-shadow:0 12px 60px #000c;display:flex;flex-direction:column;overflow:hidden;user-select:text}
#noname-deepseek-header{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #ffffff24;flex-shrink:0}
#noname-deepseek-tabs{display:flex;gap:8px;padding:10px 18px;flex-shrink:0;border-bottom:1px solid #ffffff18}
#noname-deepseek-content{padding:16px 20px;overflow:auto;min-height:0;flex:1;overscroll-behavior:contain}
#noname-deepseek-content [hidden]{display:none}
#noname-deepseek-content label{display:flex;gap:10px;align-items:center;margin:12px 0;font:inherit;color:inherit}
#noname-deepseek-content input[type=checkbox]{width:18px;height:18px;margin:0;accent-color:#c8a667;flex-shrink:0}
#noname-deepseek-content p{margin:8px 0;color:#b8c1cf;font-size:13px}
#noname-deepseek-advice{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.9;margin:16px 0;max-height:none;height:auto}
#noname-deepseek-root .ds-record-details{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,monospace;max-height:none}
#noname-deepseek-root select{font:inherit;color:#eee;background:#303744;padding:6px;border:1px solid #9c8657;border-radius:5px}
#noname-deepseek-root .ds-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#noname-deepseek-root .ds-record{border:1px solid #ffffff24;border-radius:7px;padding:12px;margin:10px 0}
@media(max-width:640px){#noname-deepseek-backdrop{padding:8px}#noname-deepseek-panel{height:calc(100dvh - 16px);max-height:calc(100dvh - 16px)}#noname-deepseek-header,#noname-deepseek-tabs{padding:10px}#noname-deepseek-content{padding:12px}#noname-deepseek-tabs button{padding:5px 9px}}
`;
	const toolbar = document.createElement("div"); toolbar.id = "noname-deepseek-toolbar";
	const backdrop = document.createElement("div"); backdrop.id = "noname-deepseek-backdrop"; backdrop.hidden = true;
	const panel = document.createElement("section"); panel.id = "noname-deepseek-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "出牌助手");
	const header = document.createElement("div"); header.id = "noname-deepseek-header";
	const title = document.createElement("strong"); title.textContent = "出牌助手";
	const tabs = document.createElement("div"); tabs.id = "noname-deepseek-tabs";
	const content = document.createElement("div"); content.id = "noname-deepseek-content";
	const settingsView = document.createElement("div"), adviceView = document.createElement("div"), recordsView = document.createElement("div");
	content.append(settingsView, adviceView, recordsView);
	let lastFocus: HTMLElement | null = null;
	const show = (view: string) => {
		settingsView.hidden = view !== "settings"; adviceView.hidden = view !== "advice"; recordsView.hidden = view !== "records";
		const opening = backdrop.hidden;
		if (opening) lastFocus = document.activeElement as HTMLElement;
		backdrop.hidden = false; content.scrollTop = 0;
		if (opening) header.querySelector("button")?.focus();
		if (view === "records") {
			const id = localStorage.getItem("noname-deepseek-replay-record");
			if (id && (_status.video || _status.playback)) void getRecorder().loadRecord(id).then(record => { if (record) renderRecord(record); else void renderRecords(); });
			else void renderRecords();
		}
	};
	const hide = () => { backdrop.hidden = true; lastFocus?.focus(); };
	const button = (parent: HTMLElement, label: string, click: () => void | Promise<void>) => {
		const node = document.createElement("button"); node.type = "button"; node.textContent = label;
		node.addEventListener("click", async () => { try { await click(); } catch (error) { const message = document.createElement("p"); message.textContent = `操作失败：${error instanceof Error ? error.message : "请重试"}`; content.prepend(message); } }); parent.append(node); return node;
	};
	button(header, "关闭", hide); header.prepend(title);
	button(tabs, "建议", () => show("advice")); button(tabs, "设置", () => show("settings")); button(tabs, "牌局记录", () => show("records"));
	button(toolbar, "助手设置", () => show("settings"));
	const toolbarAdvice = button(toolbar, "给我建议", () => obtainAdvice()); button(toolbar, "牌局记录", () => show("records"));
	const checkbox = (text: string, checked: boolean, change: (checked: boolean) => void) => {
		const label = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox"; input.checked = checked;
		input.addEventListener("change", () => change(input.checked)); label.append(input, document.createTextNode(text)); settingsView.append(label); return input;
	};
	const masterToggle = checkbox("启用 DeepSeek", enabled, value => { enabled = value; savePreferences(); });
	const computerToggle = checkbox("电脑使用 DeepSeek", computerEnabled, value => { computerEnabled = value; savePreferences(); });
	const adviceToggle = checkbox("给我 DeepSeek 建议", adviceEnabled, value => { adviceEnabled = value; savePreferences(); });
	const note = document.createElement("p"); note.textContent = "电脑与建议可分别选择。DeepSeek 首次默认关闭；原版 AI 建议始终可用，不消耗 Token。你的 DeepSeek 建议只在点击时请求。"; settingsView.append(note);
	const presets = document.createElement("div"); presets.className = "ds-actions"; settingsView.append(presets);
	button(presets, "电脑原版，我用 DeepSeek 建议", () => { enabled = true; computerEnabled = false; adviceEnabled = true; adviceSource = "deepseek"; savePreferences(); });
	button(presets, "电脑和我都用 DeepSeek", () => { enabled = true; computerEnabled = true; adviceEnabled = true; adviceSource = "deepseek"; savePreferences(); });
	const knowledge = document.createElement("p"); knowledge.textContent = "模型只接收决策者已知的信息和已发生的行动；本地完整录像与其他人的隐藏身份、未知手牌不会发送。"; settingsView.append(knowledge);
	const models = document.createElement("p"); models.textContent = "正在读取模型设置…"; settingsView.append(models);
	void fetch("/api/deepseek/health").then(response => response.json()).then(value => { models.textContent = `具体出牌 / 你的建议：${value.model}；电脑回合规划：${value.planModel || value.model}。`; }).catch(() => { models.textContent = "本机建议服务尚未连接。"; });
	computerNode = document.createElement("p"); settingsView.append(computerNode);
	adviceNode = document.createElement("div"); adviceNode.id = "noname-deepseek-advice"; adviceNode.textContent = "在自己的出牌或选择提示出现时获取建议。建议只显示文字，不替你出牌。";
	const adviceActions = document.createElement("div"); adviceActions.className = "ds-actions"; adviceView.append(adviceActions, adviceNode);
	const sourceLabel = document.createElement("label"), sourceSelect = document.createElement("select"); sourceSelect.id = "noname-advice-source"; sourceSelect.setAttribute("aria-label", "建议来源");
	for (const [value, label] of [["builtin", "原版 AI（本机即时，无 Token）"], ["deepseek", "DeepSeek（联网分析）"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; sourceSelect.append(option); }
	sourceSelect.value = adviceSource; sourceLabel.append(document.createTextNode("建议来源"), sourceSelect); adviceView.prepend(sourceLabel);
	const sourceNote = document.createElement("p"); sourceNote.textContent = "原版建议支持实体牌与普通选择，复杂技能请自行判断；两种建议均只显示文字，由你手动操作。"; sourceLabel.after(sourceNote);
	sourceSelect.addEventListener("change", () => { adviceSource = sourceSelect.value; savePreferences(); });
	let advicePending = false;
	const requestButton = button(adviceActions, "重新获取建议", () => obtainAdvice());
	button(adviceActions, "复制建议", async () => { try { await navigator.clipboard.writeText(adviceNode?.textContent || ""); } catch { if (adviceNode) { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(adviceNode); selection?.removeAllRanges(); selection?.addRange(range); } } });
	async function obtainAdvice() {
		if (advicePending) return;
		show("advice"); advicePending = true; refreshControls();
		try {
			if (adviceSource === "builtin") await getPolicy().adviseBuiltin();
			else if (useAdvice()) await getPolicy().advise();
			else if (adviceNode) adviceNode.textContent = "请在设置中启用 DeepSeek 和玩家建议，或选择原版 AI 获取本机建议。";
		} finally { advicePending = false; refreshControls(); }
	}
	refreshControls = () => {
		masterToggle.checked = enabled; computerToggle.checked = computerEnabled; adviceToggle.checked = adviceEnabled;
		computerToggle.disabled = !enabled; adviceToggle.disabled = !enabled;
		sourceSelect.value = adviceSource;
		toolbarAdvice.disabled = requestButton.disabled = advicePending || !!(_status.video || _status.playback);
		toolbarAdvice.textContent = advicePending ? "分析中…" : "给我建议";
		requestButton.textContent = advicePending ? "正在获取建议…" : "重新获取建议";
		if (computerNode) computerNode.textContent = !enabled ? "DeepSeek 已关闭；电脑使用原版 AI。" : useComputer() ? "电脑使用 DeepSeek；回合外响应只请求 Flash，省去额外 Pro 规划。" : "电脑使用原版 AI，不调用模型。";
	};
	refreshControls();

	async function renderRecords() {
		recordsView.replaceChildren();
		const actions = document.createElement("div"); actions.className = "ds-actions"; recordsView.append(actions);
		button(actions, "刷新记录", () => renderRecords());
		const importInput = document.createElement("input"); importInput.type = "file"; importInput.accept = ".json,application/json"; importInput.hidden = true; recordsView.append(importInput);
		button(actions, "导入记录", () => importInput.click());
		importInput.addEventListener("change", async () => { const file = importInput.files?.[0]; if (!file) return; try { await getRecorder().importRecord(JSON.parse(await file.text())); await renderRecords(); } catch (error) { recordsView.append(document.createTextNode(`导入失败：${error instanceof Error ? error.message : "格式错误"}`)); } });
		const note = document.createElement("p"); note.textContent = "完整录像和决策详情只保存在本机。Token 统计采用服务返回的实际用量；失败且无用量回报的请求不会算作零消耗。"; recordsView.append(note);
		try {
			await getRecorder().flush();
			const records = await getRecorder().listRecords();
			if (!records.length) recordsView.append(document.createTextNode("新牌局开始后会自动记录。"));
			for (const summary of records) {
				const row = document.createElement("div"); row.className = "ds-record";
				const label = document.createElement("strong"); label.textContent = `${summary.title || summary.mode} · ${new Date(summary.startedAt).toLocaleString()}${summary.endedAt ? "（已结束）" : "（未结束）"}`; row.append(label);
				const buttons = document.createElement("div"); buttons.className = "ds-actions"; row.append(buttons);
				button(buttons, "查看过程与决策", async () => { const record = await getRecorder().loadRecord(summary.id); if (record) renderRecord(record); });
				button(buttons, "导出完整记录", async () => { const record = await getRecorder().exportRecord(summary.id); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" })); a.download = `noname-${summary.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
				const replayButton = button(buttons, _status.over || _status.video ? "回放录像" : "回放（离开当前牌局）", async () => {
					const record = await getRecorder().exportRecord(summary.id); if (!record?.video?.length) return;
					await getRecorder().flush();
					const time = Date.now(), native = { name: record.videoName || [record.title, "AI 决策复盘"], mode: record.mode, video: record.video, win: false, name1: record.players?.[0]?.name || "liubei", time };
					await new Promise<void>((resolve, reject) => { const transaction = lib.db.transaction(["video"], "readwrite"); transaction.objectStore("video").put(native); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(new Error("录像存储失败")); });
					localStorage.setItem("noname-deepseek-replay-record", record.id); for (const controller of pending.keys()) controller.abort(); game.playVideo(time, record.mode);
				});
				replayButton.disabled = !summary.videoCount;
				recordsView.append(row);
			}
			const storageError = getRecorder().lastError;
			if (storageError) recordsView.append(document.createTextNode(storageError));
		} catch (error) { recordsView.append(document.createTextNode(`读取记录失败：${error instanceof Error ? error.message : "本机存储不可用"}`)); }
	}
	function renderRecord(record: any) {
		recordsView.replaceChildren(); button(recordsView, "返回牌局列表", () => renderRecords());
		const usage = summarizeRecordUsage(record), total = document.createElement("p");
		total.textContent = `录像 ${record.video.length} 步；AI 轨迹 ${record.decisions.length} 条。`; recordsView.append(total);
		for (const [label, value] of [["全部", usage], ["电脑", usage.cpu], ["我的建议", usage.advice]] as const) {
			const text = document.createElement("p");
			text.textContent = !value.requestCount ? `${label}：无模型调用。` : `${label}：${value.requestCount} 次模型请求；已回报用量 ${value.knownUsageCount} 次，未知 ${value.unknownUsageCount} 次。已知输入 ${value.promptTokens ?? "未回报"}，输出 ${value.completionTokens ?? "未回报"}，合计 ${value.totalTokens ?? "未回报"} Token。`;
			recordsView.append(text);
		}
		const filter = document.createElement("select"); filter.setAttribute("aria-label", "记录筛选");
		for (const [value, label] of [["all", "全部过程"], ["ai", "只看 AI 决策"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; filter.append(option); } recordsView.append(filter);
		const entries = document.createElement("div"); recordsView.append(entries);
		const stages: Record<string, string> = { start: "请求开始", complete: "返回结果", error: "请求失败", shown: "建议已显示", applied: "选择或计划已采用", completed: "原版选择已完成", fallback: "回退或暂不可用", stale: "局面已变化", blocked: "当前提示不支持" };
		const timeline = [...record.video.map((video: any, index: number) => ({ cursor: index + 1, type: "录像", text: `${video.type} · 座位 ${video.player ?? "—"}`, detail: video })), ...record.decisions.map((entry: any) => ({ cursor: entry.videoCursor, type: "AI", text: `${entry.actorName || entry.actorId || entry.actor || ""} · ${entry.source === "builtin" ? "原版 AI" : entry.result?.model || entry.model || "DeepSeek"} · ${entry.kind === "advice" ? "我的建议" : entry.kind === "plan" ? "回合规划" : "出牌选择"} · ${stages[entry.stage || entry.status] || entry.stage || entry.status || ""}`, detail: entry }))].sort((a: any, b: any) => a.cursor - b.cursor);
		for (const [index, entry] of timeline.entries()) {
			const detail = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre"); pre.className = "ds-record-details"; detail.dataset.entryType = entry.type;
			summary.textContent = `${index + 1}. [${entry.type}] ${entry.text}（录像位置 ${entry.cursor}）`; detail.append(summary);
			if (entry.type === "AI") {
				const data = entry.detail, result = data.result || {};
				const explanation = result.advice || data.advice || data.error?.message || data.candidate?.label;
				if (explanation) { const text = document.createElement("p"); text.style.whiteSpace = "pre-wrap"; text.textContent = String(explanation); detail.append(text); }
				if (data.source === "builtin" && data.status === "completed") {
					const text = document.createElement("p");
					text.textContent = `实际选择：${[result.cards?.map((card: any) => card.name).join("、"), result.targets?.length ? `→ ${result.targets.map((player: any) => player.name).join("、")}` : "", result.control, result.skill, result.bool === false ? "取消 / 不响应" : result.bool === true ? "确认 / 响应" : ""].filter(Boolean).join(" ") || "见完整记录"}`;
					detail.append(text);
				}
			}
			const raw = document.createElement("details"), rawTitle = document.createElement("summary"); rawTitle.textContent = "原始局面与完整记录";
			pre.textContent = JSON.stringify(entry.detail, null, 2); raw.append(rawTitle, pre); detail.append(raw); entries.append(detail);
		}
		filter.addEventListener("change", () => { for (const row of Array.from(entries.children) as HTMLElement[]) row.hidden = filter.value === "ai" && row.dataset.entryType !== "AI"; });
	}
	panel.append(header, tabs, content); backdrop.append(panel); root.append(style, toolbar, backdrop); document.body.append(root);
	for (const type of ["click", "dblclick", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "wheel"]) root.addEventListener(type, event => event.stopPropagation());
	backdrop.addEventListener("click", event => { if (event.target === backdrop) hide(); });
	root.addEventListener("keydown", event => {
		if (backdrop.hidden) return;
		event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); hide(); }
		if (event.key === "Tab") { const nodes = Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),summary")).filter(node => node.getClientRects().length); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
	});
}
