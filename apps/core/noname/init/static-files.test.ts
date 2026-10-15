import assert from "node:assert/strict";
import test from "node:test";
import { createStaticFileApi, normalizeStaticPath, type StaticFileManifest } from "./static-files";

const manifest: StaticFileManifest = {
	version: 1,
	files: ["noname.js", "image/card/sha.png", "image/武将 甲.png", "audio/card/sha.mp3", "data/a#b?.txt"],
	directories: ["extension/empty"],
};
const baseURL = "https://example.github.io/noname/index.html?mode=identity#game";

function setup() {
	const requests: { url: string; init?: RequestInit }[] = [];
	const request = createStaticFileApi({
		baseURL,
		manifest,
		fetch: async (url, init) => {
			requests.push({ url: String(url), init });
			return new Response(new Uint8Array([0, 128, 255]));
		},
	});
	return { request, requests };
}

test("static file stat and listing come from the manifest without backend requests", async () => {
	const { request, requests } = setup();
	assert.equal(await request("/checkFile", "noname.js"), "file");
	assert.equal(await request("/checkFile", "image/card"), "directory");
	assert.equal(await request("/checkFile", "extension/empty"), "directory");
	assert.equal(await request("/checkFile", "missing.txt"), null);
	assert.deepEqual(await request("/getFileList", "image/"), { folders: ["card"], files: ["武将 甲.png"] });
	assert.deepEqual(await request("/getFileList", "extension/empty"), { folders: [], files: [] });
	assert.equal(requests.length, 0);
});

test("root-relative paths stay inside the Pages project directory", async () => {
	const { request, requests } = setup();
	assert.deepEqual(await request("/readFile", "/audio/card/sha.mp3"), new Uint8Array([0, 128, 255]));
	assert.equal(requests[0].url, "https://example.github.io/noname/audio/card/sha.mp3");
	assert.equal(requests[0].init?.redirect, "error");
	assert.equal(requests[0].init?.credentials, "omit");
	assert.deepEqual(await request("/getFileList", "/"), { folders: ["audio", "data", "extension", "image"], files: ["noname.js"] });
	assert.deepEqual(await request("/getFileList", "."), await request("/getFileList", "/"));
});

test("unicode and URL-significant file names are encoded as literal asset names", async () => {
	const { request, requests } = setup();
	await request("/readFile", "./image/武将 甲.png");
	await request("/readFile", "data/a#b?.txt");
	assert.equal(requests[0].url, "https://example.github.io/noname/image/%E6%AD%A6%E5%B0%86%20%E7%94%B2.png");
	assert.equal(requests[1].url, "https://example.github.io/noname/data/a%23b%3F.txt");
});

test("traversal, absolute URLs, cross-origin paths and control characters are rejected before fetching", async () => {
	const { request, requests } = setup();
	for (const path of ["../secret", "image/../noname.js", "/../secret", "%2e%2e/secret", "%252e%252e/secret", "image%2f..%2fsecret", "https://evil.test/file", "//evil.test/file", "image\\sha.png", "a\u0000b", "a\nb"]) {
		await assert.rejects(request("/readFile", path), /EINVAL/);
	}
	assert.equal(requests.length, 0);
});

test("all mutation endpoints and POST reads are rejected without loading the manifest", async () => {
	let fetched = false;
	const request = createStaticFileApi({ baseURL, fetch: async () => { fetched = true; return new Response(); } });
	for (const route of ["/writeFile", "/createDir", "/removeFile", "/removeDir", "/unknown"]) {
		await assert.rejects(request(route, "image/sha.png"), /EROFS: 网页版只支持读取游戏文件/);
	}
	await assert.rejects(request("/readFile", "noname.js", undefined, { method: "POST" }), /EROFS/);
	assert.equal(fetched, false);
});

test("nonexistent and wrong-type reads preserve filesystem error distinctions", async () => {
	const { request, requests } = setup();
	await assert.rejects(request("/readFile", "missing.png"), /ENOENT/);
	await assert.rejects(request("/readFile", "image"), /EISDIR/);
	await assert.rejects(request("/getFileList", "noname.js"), /ENOTDIR/);
	await assert.rejects(request("/getFileList", "missing"), /ENOENT/);
	assert.equal(requests.length, 0);
});

test("manifest is fetched once at the same project root for concurrent requests", async () => {
	const requests: string[] = [];
	const request = createStaticFileApi({
		baseURL,
		fetch: async url => {
			requests.push(String(url));
			return Response.json(manifest);
		},
	});
	assert.deepEqual(await Promise.all([request("/checkFile", "noname.js"), request("/checkFile", "image")]), ["file", "directory"]);
	assert.deepEqual(requests, ["https://example.github.io/noname/static-files.json"]);
});

test("failed inventory fetch can be retried", async () => {
	let attempts = 0;
	const request = createStaticFileApi({ baseURL, fetch: async () => ++attempts === 1 ? new Response("missing", { status: 404 }) : Response.json(manifest) });
	await assert.rejects(request("/checkFile", "noname.js"), /ENOENT/);
	assert.equal(await request("/checkFile", "noname.js"), "file");
	assert.equal(attempts, 2);
});

test("asset HTTP failures propagate without fabricating file contents", async () => {
	const request = createStaticFileApi({ baseURL, manifest, fetch: async () => new Response("missing", { status: 404 }) });
	await assert.rejects(request("/readFile", "noname.js"), /ENOENT.*404/);
});

test("fetch responses cannot redirect to another origin or outside the project", async () => {
	for (const target of ["https://evil.test/noname.js", "https://example.github.io/private/file"]) {
		const request = createStaticFileApi({ baseURL, manifest, fetch: async () => {
			const response = new Response("data");
			Object.defineProperty(response, "url", { value: target });
			return response;
		} });
		await assert.rejects(request("/readFile", "noname.js"), /EACCES/);
	}
});

test("invalid manifests reject traversal and file-directory conflicts", async () => {
	for (const invalid of [{ version: 2, files: [] }, { version: 1, files: ["../secret"] }, { version: 1, files: ["image", "image/a.png"] }, { version: 1, files: [null] }]) {
		const request = createStaticFileApi({ baseURL, manifest: invalid as StaticFileManifest });
		await assert.rejects(request("/checkFile", "noname.js"), /EIO|EINVAL/);
	}
});

test("path normalization keeps canonical game-root names", () => {
	assert.equal(normalizeStaticPath("./image//card/sha.png/"), "image/card/sha.png");
	assert.equal(normalizeStaticPath("/"), "");
	assert.throws(() => createStaticFileApi({ baseURL: "file:///tmp/noname/index.html", manifest }), /EINVAL/);
});
