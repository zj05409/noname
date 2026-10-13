import { spawnSync } from "node:child_process";
import { cp, access, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(process.env.NONAME_ASSETS_DIR || resolve(repository, "apps/core"));
for (const directory of ["image", "audio"]) {
	try {
		await access(resolve(assets, directory));
	} catch {
		throw new Error(`缺少 ${directory} 素材；请完整检出官方游戏，或设置 NONAME_ASSETS_DIR 为官方 apps/core 目录。`);
	}
}
const result = spawnSync(process.env.PNPM_BIN || "pnpm", ["-F", "noname...", "build"], {
	cwd: repository,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const destination = resolve(repository, "dist");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(repository, "apps/core/dist"), destination, { recursive: true });
for (const directory of ["image", "audio"]) {
	await cp(resolve(assets, directory), resolve(destination, directory), { recursive: true });
}
for (const [source, target] of [["apps/core/extension", "extension"], ["docs", "docs"], ["LICENSE", "LICENSE"], ["README.md", "README.md"]]) {
	await cp(resolve(repository, source), resolve(destination, target), { recursive: true });
}
console.log("DeepSeek 版已构建到 dist；运行 pnpm start:deepseek --config /安全位置/deepseek.json");
