import { spawn } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codecVersion = "pages-audio-v1-libmp3lame-speech-mono-32000-48k-background-stereo-44100-96k";

function runFfmpeg(arguments_) {
	return new Promise((resolveRun, reject) => {
		const child = spawn("ffmpeg", arguments_, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", data => { stdout = (stdout + data).slice(-16384); });
		child.stderr.on("data", data => { stderr = (stderr + data).slice(-16384); });
		child.once("error", error => reject(new Error(error.code === "ENOENT" ? "未找到 FFmpeg。请先安装 ffmpeg，再构建 GitHub Pages 音频。" : `无法启动 FFmpeg：${error.message}`, { cause: error })));
		child.once("close", code => code === 0 ? resolveRun(stdout) : reject(new Error(`FFmpeg 音频处理失败（退出码 ${code}）：${stderr.trim() || "未返回错误详情"}`)));
	});
}

function isWithin(parent, child) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function listFiles(root, directory = root) {
	const files = [];
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`音频源不允许符号链接：${relative(root, path)}`);
		if (entry.isDirectory()) files.push(...await listFiles(root, path));
		else if (entry.isFile()) files.push({ path, relativePath: relative(root, path), size: (await stat(path)).size });
		else throw new Error(`音频源包含不支持的文件类型：${relative(root, path)}`);
	}
	return files;
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function atomicCopy(source, destination) {
	await mkdir(dirname(destination), { recursive: true });
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await copyFile(source, temporary);
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
}

/**
 * Preserve every relative audio path while preparing a smaller, complete Pages bundle.
 * counts.compressed/copied describe output files; counts.cached is their cache-hit subset.
 * onProgress receives { completed, total, counts, bytes, sourceBytes } every 500 files and at completion.
 * The original audio directory is read-only. A failed file rejects the entire preparation.
 */
export async function preparePagesAudio(sourceDir, destDir, options = {}) {
	const source = resolve(sourceDir), destination = resolve(destDir);
	const cache = resolve(options.cacheDir || resolve(repository, "../work/pages-audio-cache"));
	if (isWithin(source, destination) || isWithin(destination, source) || isWithin(source, cache) || isWithin(cache, source) || isWithin(destination, cache) || isWithin(cache, destination)) throw new Error("音频源、输出和缓存必须使用互不包含的独立目录。");
	const concurrency = Number(options.concurrency ?? process.env.NONAME_PAGES_AUDIO_CONCURRENCY ?? 4);
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("音频并发数必须为 1 到 8 的整数。");
	const ffmpegVersion = (await runFfmpeg(["-version"])).split("\n")[0];
	const files = await listFiles(source);
	await Promise.all([mkdir(destination, { recursive: true }), mkdir(cache, { recursive: true })]);
	const counts = { files: 0, compressed: 0, copied: 0, cached: 0 };
	const sourceBytes = files.reduce((total, file) => total + file.size, 0);
	let bytes = 0, cursor = 0, failure;
	const runningCache = new Map();

	async function encode(file) {
		const background = file.relativePath.split(sep)[0] === "background";
		const profile = background ? "background" : "speech";
		const sourceHash = await sha256(file.path);
		const key = createHash("sha256").update(`${codecVersion}\n${ffmpegVersion}\n${profile}\n${sourceHash}`).digest("hex");
		const payload = resolve(cache, `${key}.mp3`), metadata = resolve(cache, `${key}.json`);
		async function cached() {
			try {
				const entry = JSON.parse(await readFile(metadata, "utf8"));
				const size = (await stat(payload)).size;
				if (entry.version === codecVersion && entry.sourceHash === sourceHash && entry.sourceBytes === file.size && entry.bytes === size && size > 0 && size <= file.size && typeof entry.compressed === "boolean") return { path: payload, bytes: size, compressed: entry.compressed, cached: true };
			} catch { /* A missing or incomplete cache entry is rebuilt. */ }
		}
		const existing = await cached();
		if (existing) return existing;
		if (runningCache.has(key)) return { ...await runningCache.get(key), cached: true };
		const pending = (async () => {
			const temporary = resolve(cache, `${key}.${randomUUID()}.tmp.mp3`);
			try {
				await runFfmpeg(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", file.path, "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "libmp3lame", "-ac", background ? "2" : "1", "-ar", background ? "44100" : "32000", "-b:a", background ? "96k" : "48k", "-threads", "1", "-f", "mp3", temporary]);
				const encodedBytes = (await stat(temporary)).size;
				if (!encodedBytes) throw new Error(`FFmpeg 返回空音频：${file.relativePath}`);
				const compressed = encodedBytes < file.size;
				if (!compressed) await copyFile(file.path, temporary);
				const outputBytes = compressed ? encodedBytes : file.size;
				await rename(temporary, payload);
				const metadataTemporary = `${metadata}.${randomUUID()}.tmp`;
				try {
					await writeFile(metadataTemporary, JSON.stringify({ version: codecVersion, sourceHash, sourceBytes: file.size, bytes: outputBytes, compressed, profile }));
					await rename(metadataTemporary, metadata);
				} finally { await rm(metadataTemporary, { force: true }); }
				return { path: payload, bytes: outputBytes, compressed, cached: false };
			} catch (error) {
				throw new Error(`处理音频失败：${file.relativePath}；${error.message}`, { cause: error });
			} finally { await rm(temporary, { force: true }); }
		})();
		runningCache.set(key, pending);
		try { return await pending; }
		finally { runningCache.delete(key); }
	}

	async function worker() {
		while (!failure && cursor < files.length) {
			const file = files[cursor++];
			try {
				const result = extname(file.path).toLowerCase() === ".mp3" ? await encode(file) : { path: file.path, bytes: file.size, compressed: false, cached: false };
				await atomicCopy(result.path, resolve(destination, file.relativePath));
				counts.files++;
				counts[result.compressed ? "compressed" : "copied"]++;
				if (result.cached) counts.cached++;
				bytes += result.bytes;
				if (options.onProgress && (counts.files % 500 === 0 || counts.files === files.length)) await options.onProgress({ completed: counts.files, total: files.length, counts: { ...counts }, bytes, sourceBytes });
			} catch (error) { failure ??= error; }
		}
	}
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	if (failure) throw failure;
	return { counts, bytes, sourceBytes };
}

async function main() {
	const args = process.argv.slice(2), flags = {};
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		if (!["--source", "--dest", "--cache", "--concurrency"].includes(name) || !args[index + 1]) throw new Error("用法：node scripts/pages-audio.mjs --source apps/core/audio --dest ../work/pages-audio-prepared [--cache ../work/pages-audio-cache] [--concurrency 4]");
		flags[name.slice(2)] = args[index + 1];
	}
	if (!flags.source || !flags.dest) throw new Error("请提供 --source 和 --dest 音频目录。");
	const result = await preparePagesAudio(flags.source, flags.dest, {
		cacheDir: flags.cache, concurrency: flags.concurrency,
		onProgress: progress => console.log(`音频 ${progress.completed}/${progress.total}；输出 ${(progress.bytes / 1e6).toFixed(1)} MB；缓存命中 ${progress.counts.cached}`),
	});
	console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
