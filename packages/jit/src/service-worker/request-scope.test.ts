import assert from "node:assert/strict";
import test from "node:test";
import { isJitRequest } from "./request-scope";

const scope = "https://example.github.io/noname/";

test("Pages project extensions and the JIT probe are compiled within the registration scope", () => {
	for (const path of ["extension/my-addon/index.ts", "extension/中文扩展/界面.vue?raw", "extension/tool/a.json", "jit-test.ts?cache=1"]) {
		assert.equal(isJitRequest(new URL(path, scope).href, scope), true, path);
	}
	assert.equal(isJitRequest("http://localhost:8081/extension/a.ts", "http://localhost:8081/"), true);
	assert.equal(isJitRequest("http://127.0.0.1:8081/jit-test.ts", "http://127.0.0.1:8081/"), true);
});

test("other repositories and origin-root extensions are outside a project registration", () => {
	for (const path of ["/extension/a.ts", "/jit-test.ts", "/another/extension/a.ts", "/noname-copy/extension/a.ts", "/noname/../extension/a.ts"]) {
		assert.equal(isJitRequest(new URL(path, scope).href, scope), false, path);
	}
});

test("cross-origin, different scheme or port, malformed and non-network requests are ignored", () => {
	for (const request of ["https://evil.test/noname/extension/a.ts", "http://example.github.io/noname/extension/a.ts", "https://example.github.io:8443/noname/extension/a.ts", "file:///noname/extension/a.ts", "data:text/javascript,hello", "/noname/extension/a.ts", "invalid"]) {
		assert.equal(isJitRequest(request, scope), false, request);
	}
	assert.equal(isJitRequest(`${scope}extension/a.ts`, "invalid"), false);
});

test("game assets, API calls and similarly named paths pass through unchanged", () => {
	for (const path of ["noname.js", "noname/entry.js", "preload.js", "image/card/sha.png", "api/deepseek/decision", "api/deepseek/health", "extension-other/a.ts", "extension", "jit-test.ts/other", "jit-test.ts.bak"]) {
		assert.equal(isJitRequest(new URL(path, scope).href, scope), false, path);
	}
	assert.equal(isJitRequest("https://api.deepseek.com/v1/chat/completions", scope), false);
	assert.equal(isJitRequest(`${scope}extension/a.ts`, scope, "POST"), false);
	assert.equal(isJitRequest(`${scope}extension/a.ts`, scope, "HEAD"), false);
});

test("encoded traversal and ambiguous separators cannot widen the compiler scope", () => {
	for (const path of ["extension/%2e%2e/api/deepseek", "extension/%252e%252e/a.ts", "extension/a%2fb.ts", "extension/a%5cb.ts", "extension/%E0%A4%A.ts"]) {
		assert.equal(isJitRequest(new URL(path, scope).href, scope), false, path);
	}
});
