import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const { values } = parseArgs({ options: {
	output: { type: "string" }, config: { type: "string" },
	port: { type: "string", default: "8081" },
	"runtime-dir": { type: "string" },
} });
if (!values.output || !values.config || !values["runtime-dir"]) throw new Error("请提供 --output、--config 和 --runtime-dir。");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const args = [process.execPath, resolve(repository, "scripts/launch-local.mjs"), "--root", resolve(repository, "dist"), "--port", values.port, "--config", resolve(values.config), "--runtime-dir", resolve(values["runtime-dir"])];
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `#!/bin/zsh\nset -e\ncd ${quote(repository)}\n${args.map(quote).join(" ")}\n`, { mode: 0o700 });
await chmod(output, 0o700);
console.log(`已生成本机启动入口：${output}`);
