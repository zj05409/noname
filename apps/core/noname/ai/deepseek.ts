import { _status, game, get, lib, ui } from "noname";
import { DeepSeekPolicy, type DeepSeekReply } from "./deepseek-policy";
import { installStrategicObserver } from "./deepseek-strategy";

const preference = "noname-deepseek-enabled";
let enabled = false;
try {
	enabled = localStorage.getItem(preference) === "true";
} catch {}

let adviceNode: HTMLElement | undefined;
let computerNode: HTMLElement | undefined;

async function request(packet: Record<string, unknown>): Promise<DeepSeekReply> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 22000);
	try {
		const response = await fetch("/api/deepseek/decision", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(packet),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`DeepSeek request failed (${response.status})`);
		const reply = await response.json();
		if (!reply || typeof reply.advice !== "string" || !(reply.choice === null || typeof reply.choice === "string")) throw new Error("Invalid DeepSeek reply");
		return reply;
	} finally {
		clearTimeout(timeout);
	}
}

let policy: DeepSeekPolicy | undefined;
function getPolicy() {
	// noname's core modules share cyclic imports; read their instances only after initialization.
	return (policy ??= new DeepSeekPolicy(
		{ game, get, lib, ui, status: _status },
		request,
		() => enabled,
		(text, computer = false) => {
			const node = computer ? computerNode : adviceNode;
			if (node) node.textContent = text;
		}
	));
}

export const tryDeepSeekDecision = (event: any) => getPolicy().decide(event);
export const getDeepSeekMatchMemory = () => getPolicy().matchMemory;

export function mountDeepSeekPanel() {
	getPolicy().resetMatch();
	if (document.getElementById("noname-deepseek-panel")) return;
	installStrategicObserver({ game, get, lib, status: _status }, getPolicy().matchMemory, actor => getPolicy().planTurn(actor));
	const panel = document.createElement("section");
	panel.id = "noname-deepseek-panel";
	panel.setAttribute("aria-label", "DeepSeek 出牌助手");
	panel.style.cssText = "position:fixed;right:16px;top:62px;width:276px;max-width:calc(100vw - 24px);z-index:120;box-sizing:border-box;background:rgba(21,26,33,.95);color:#f5f1e8;border:1px solid #9f8a5b;border-radius:10px;box-shadow:0 5px 24px #0008;font:13px/1.5 system-ui,sans-serif;text-shadow:none;user-select:text;";
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:move;font-weight:700;touch-action:none;";
	const title = document.createElement("span");
	title.textContent = "DeepSeek 出牌助手";
	const collapse = document.createElement("button");
	collapse.type = "button";
	collapse.textContent = "收起";
	collapse.setAttribute("aria-expanded", "true");
	collapse.style.cssText = "background:transparent;border:0;color:#d7c89c;cursor:pointer;padding:2px 5px;font:inherit;";
	header.append(title, collapse);
	const content = document.createElement("div");
	content.style.cssText = "padding:0 12px 12px;";
	const label = document.createElement("label");
	label.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer;margin:2px 0 10px;";
	const toggle = document.createElement("input");
	toggle.type = "checkbox";
	toggle.checked = enabled;
	toggle.style.cssText = "width:16px;height:16px;accent-color:#d7ba76;margin:0;";
	label.append(toggle, document.createTextNode("启用 DeepSeek"));
	const knowledgeLabel = document.createElement("label");
	knowledgeLabel.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer;margin:2px 0 10px;font-size:12px;color:#c1c6cd;";
	const knowledgeToggle = document.createElement("input");
	knowledgeToggle.type = "checkbox";
	knowledgeToggle.checked = getPolicy().matchMemory.isOmniscient();
	knowledgeToggle.style.cssText = toggle.style.cssText;
	knowledgeLabel.append(knowledgeToggle, document.createTextNode("全场手牌（全知）"));
	const adviceButton = document.createElement("button");
	let advicePending = false;
	adviceButton.type = "button";
	adviceButton.textContent = "给我建议";
	adviceButton.disabled = !enabled;
	adviceButton.style.cssText = "width:100%;border:1px solid #ad9865;border-radius:5px;padding:6px;background:#544a30;color:#fff;font:inherit;cursor:pointer;";
	adviceNode = document.createElement("div");
	adviceNode.style.cssText = "margin-top:9px;white-space:pre-wrap;overflow:auto;max-height:180px;";
	adviceNode.textContent = "在自己的出牌或选择提示出现时点击。建议不会替你出牌。";
	computerNode = document.createElement("div");
	computerNode.style.cssText = "border-top:1px solid #ffffff24;margin-top:9px;padding-top:8px;font-size:12px;color:#c1c6cd;white-space:pre-wrap;max-height:130px;overflow:auto;";
	computerNode.textContent = enabled ? "DeepSeek 已开启；电脑会规划回合并按合法候选行动。复杂选择使用原版 AI。" : "默认关闭：当前使用原版 AI，不会调用 DeepSeek。";
	content.append(label, knowledgeLabel, adviceButton, adviceNode, computerNode);
	panel.append(header, content);
	(ui.window || document.body).append(panel);
	for (const type of ["click", "dblclick", "pointerdown", "touchstart", "touchend"]) panel.addEventListener(type, event => event.stopPropagation());
	toggle.addEventListener("change", () => {
		enabled = toggle.checked;
		adviceButton.disabled = !enabled || advicePending;
		try {
			localStorage.setItem(preference, String(enabled));
		} catch {}
		if (computerNode) computerNode.textContent = enabled ? "DeepSeek 已开启。" : "当前使用原版 AI，不会调用 DeepSeek。";
	});
	knowledgeToggle.addEventListener("change", () => {
		getPolicy().matchMemory.setOmniscient(knowledgeToggle.checked);
		if (adviceNode) adviceNode.textContent = knowledgeToggle.checked ? "全知模式：分析全场手牌，仍依据行为推断隐藏身份。" : "已切为已知信息模式：仅分析自己手牌与已知公开信息。";
	});
	adviceButton.addEventListener("click", async () => {
		if (advicePending || !enabled) return;
		advicePending = true;
		adviceButton.disabled = true;
		adviceButton.textContent = "正在获取建议…";
		try {
			await getPolicy().advise();
		} finally {
			advicePending = false;
			adviceButton.disabled = !enabled;
			adviceButton.textContent = "给我建议";
		}
	});
	collapse.addEventListener("click", () => {
		content.hidden = !content.hidden;
		collapse.textContent = content.hidden ? "展开" : "收起";
		collapse.setAttribute("aria-expanded", String(!content.hidden));
	});
	header.addEventListener("pointerdown", event => {
		if ((event.target as HTMLElement).closest("button")) return;
		const bounds = panel.getBoundingClientRect();
		const startX = event.clientX,
			startY = event.clientY;
		header.setPointerCapture(event.pointerId);
		const move = (next: PointerEvent) => {
			panel.style.right = "auto";
			panel.style.left = `${Math.max(0, Math.min(window.innerWidth - bounds.width, bounds.left + next.clientX - startX))}px`;
			panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, bounds.top + next.clientY - startY))}px`;
		};
		const finish = () => {
			header.removeEventListener("pointermove", move);
			header.removeEventListener("pointerup", finish);
			header.removeEventListener("pointercancel", finish);
		};
		header.addEventListener("pointermove", move);
		header.addEventListener("pointerup", finish);
		header.addEventListener("pointercancel", finish);
	});
}
