import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";

const { fetch, AbortSignal } = globalThis;

const { values } = parseArgs({ options: {
	root: { type: "string", default: "dist" },
	port: { type: "string", default: "8092" },
	config: { type: "string" },
	"runtime-dir": { type: "string", default: resolve(tmpdir(), "noname-local") },
	"no-open": { type: "boolean", default: false },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("本地端口无效");
const url = `http://127.0.0.1:${port}/`;
const configured = Boolean(values.config);
async function ready() {
	try {
		const response = await fetch(`${url}api/deepseek/health`, { signal: AbortSignal.timeout(1000) });
		if (!response.ok) return false;
		const health = await response.json();
		return health.configured === configured;
	} catch {
		return false;
	}
}
if (!(await ready())) {
	await mkdir(values["runtime-dir"], { recursive: true, mode: 0o700 });
	const logfile = await open(resolve(values["runtime-dir"], `noname-${port}.log`), "a", 0o600);
	const args = [resolve(dirname(fileURLToPath(import.meta.url)), "deepseek-server.mjs"), "--root", resolve(values.root), "--port", String(port)];
	if (values.config) args.push("--config", resolve(values.config));
	const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logfile.fd, logfile.fd] });
	child.unref();
	await logfile.close();
	for (let retry = 0; retry < 30 && !(await ready()); retry++) {
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	if (!(await ready())) throw new Error(`游戏服务启动失败，请查看 ${values["runtime-dir"]}/noname-${port}.log`);
}
console.log(`已启动${configured ? " DeepSeek 版" : "原版 AI"}：${url}`);
if (!values["no-open"]) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => console.log(`请在浏览器中打开 ${url}`));
	child.unref();
}
