/** Build a complete static site; never reads local gateway configuration or credentials. */
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { preparePagesAudio } from "./pages-audio.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "skip-build": { type: "boolean", default: false } } });
const destination = resolve(repository, "dist-pages");
const assets = resolve(process.env.NONAME_ASSETS_DIR || resolve(repository, "apps/core"));
if (!values["skip-build"])
	for (const name of ["@noname/fs", "@noname/jit", "noname"]) {
		const result = spawnSync(process.env.PNPM_BIN || "pnpm", ["-F", name, "build"], { cwd: repository, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status || 1);
	}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(repository, "apps/core/dist"), destination, { recursive: true, dereference: true });
for (const [source, target] of [
	[resolve(assets, "image"), "image"],
	[resolve(repository, "apps/core/extension"), "extension"],
	[resolve(repository, "docs"), "docs"],
	[resolve(repository, "LICENSE"), "LICENSE"],
	[resolve(repository, "README.md"), "README.md"],
])
	await cp(source, resolve(destination, target), { recursive: true, dereference: true });
const audio = await preparePagesAudio(resolve(assets, "audio"), resolve(destination, "audio"), { cacheDir: process.env.NONAME_PAGES_AUDIO_CACHE || resolve(repository, ".pages-audio-cache"), onProgress: p => console.log(`语音 ${p.completed}/${p.total}，已输出 ${(p.bytes / 1e6).toFixed(1)} MB`) });
console.log(`完整音频 ${(audio.sourceBytes / 1e6).toFixed(1)} → ${(audio.bytes / 1e6).toFixed(1)} MB`);
const indexFile = resolve(destination, "index.html");
let html = await readFile(indexFile, "utf8");
html = html.replace("<head>", "<head>\n<script>window.nonameStaticSite=true;</script>");
await writeFile(indexFile, html);
await writeFile(resolve(destination, ".nojekyll"), "");
await writeFile(resolve(destination, "preload.js"), 'export { default } from "./noname/init/browser.js";\n');
const files = [],
	directories = [];
let bytes = 0;
async function walk(directory) {
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, item.name),
			name = relative(destination, path).split("\\").join("/");
		if (item.isSymbolicLink()) throw new Error(`Pages 包含符号链接：${name}`);
		if (item.isDirectory()) {
			directories.push(name);
			await walk(path);
		} else if (item.isFile()) {
			if (/(^|\/)(?:\.env(?:\..*)?|deepseek\.json|runtime|\.git)(\/|$)/i.test(name)) throw new Error(`禁止公开的运行配置：${name}`);
			files.push(name);
			bytes += (await stat(path)).size;
		}
	}
}
await walk(destination);
files.push("static-files.json");
const manifest = JSON.stringify({ version: 1, files: files.sort(), directories: directories.sort() });
bytes += Buffer.byteLength(manifest);
await writeFile(resolve(destination, "static-files.json"), manifest);
if (bytes >= 980000000) throw new Error(`Pages 包 ${(bytes / 1e6).toFixed(1)} MB，超过 980 MB 构建上限。`);
console.log(`GitHub Pages 完整站点：${files.length} 个文件，${(bytes / 1e6).toFixed(1)} MB，位于 dist-pages。`);
