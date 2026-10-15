import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePagesAudio } from "./pages-audio.mjs";

const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
function fixture(path, options = []) {
	const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...options, path], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

test("Pages audio preserves paths/WAV, compresses speech/music, caches, and rebuilds changed source", { skip: !available }, async () => {
	const root = await mkdtemp(join(tmpdir(), "noname-pages-audio-"));
	try {
		const source = join(root, "source"), destination = join(root, "output"), cacheDir = join(root, "cache");
		await mkdir(join(source, "skill"), { recursive: true }); await mkdir(join(source, "background"));
		fixture(join(source, "skill", "speech.mp3"), ["-c:a", "libmp3lame", "-b:a", "192k"]);
		fixture(join(source, "background", "music.mp3"), ["-c:a", "libmp3lame", "-b:a", "192k", "-ac", "2"]);
		fixture(join(source, "effect.wav"));
		const original = await readFile(join(source, "skill", "speech.mp3"));
		const progress = [];
		const first = await preparePagesAudio(source, destination, { cacheDir, concurrency: 2, onProgress: value => progress.push(value) });
		assert.deepEqual(first.counts, { files: 3, compressed: 2, copied: 1, cached: 0 });
		assert.ok(first.bytes < first.sourceBytes);
		assert.deepEqual(await readFile(join(destination, "effect.wav")), await readFile(join(source, "effect.wav")));
		assert.deepEqual(await readFile(join(source, "skill", "speech.mp3")), original);
		for (const [path, channels, sampleRate] of [["skill/speech.mp3", 1, "32000"], ["background/music.mp3", 2, "44100"]]) {
			const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=channels,sample_rate", "-of", "json", join(destination, path)], { encoding: "utf8" });
			assert.equal(probe.status, 0, probe.stderr);
			assert.deepEqual(JSON.parse(probe.stdout).streams[0], { sample_rate: sampleRate, channels });
		}
		assert.equal(progress.at(-1).completed, 3);
		assert.deepEqual((await preparePagesAudio(source, destination, { cacheDir })).counts, { files: 3, compressed: 2, copied: 1, cached: 2 });
		await rm(join(source, "skill", "speech.mp3"));
		fixture(join(source, "skill", "speech.mp3"), ["-c:a", "libmp3lame", "-b:a", "128k"]);
		assert.equal((await preparePagesAudio(source, destination, { cacheDir })).counts.cached, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Pages audio keeps an original when transcoding would make it larger", { skip: !available }, async () => {
	const root = await mkdtemp(join(tmpdir(), "noname-pages-audio-"));
	try {
		const source = join(root, "source"), destination = join(root, "output"); await mkdir(source);
		fixture(join(source, "small.mp3"), ["-c:a", "libmp3lame", "-b:a", "32k", "-ar", "22050", "-ac", "1"]);
		const result = await preparePagesAudio(source, destination, { cacheDir: join(root, "cache") });
		assert.deepEqual(result.counts, { files: 1, compressed: 0, copied: 1, cached: 0 });
		assert.deepEqual(await readFile(join(source, "small.mp3")), await readFile(join(destination, "small.mp3")));
		assert.equal(result.bytes, result.sourceBytes);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Pages audio rejects incomplete/corrupt media and unsafe directory/concurrency inputs", { skip: !available }, async () => {
	const root = await mkdtemp(join(tmpdir(), "noname-pages-audio-"));
	try {
		const source = join(root, "source"), destination = join(root, "output"), cacheDir = join(root, "cache"); await mkdir(source);
		await writeFile(join(source, "broken.mp3"), "this is not audio");
		await assert.rejects(preparePagesAudio(source, destination, { cacheDir }), /处理音频失败.*broken.mp3/);
		await assert.rejects(stat(join(destination, "broken.mp3")), { code: "ENOENT" });
		await assert.rejects(preparePagesAudio(source, source, { cacheDir }), /独立目录/);
		await assert.rejects(preparePagesAudio(source, destination, { cacheDir, concurrency: 9 }), /1 到 8/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
