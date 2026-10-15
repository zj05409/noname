import assert from "node:assert/strict";
import test from "node:test";
import { resolvePackURL } from "./pack-url";

const packagePaths = ["/card/standard", "/character/standard", "/character/standard/index", "/mode/identity", "/mode/identity/index", "/extension/example/extension"];

test("card, character, mode and extension imports stay under a GitHub Pages project root", () => {
	for (const path of packagePaths) {
		const url = resolvePackURL(path, new URL("https://example.github.io/noname/"));
		assert.equal(url, `https://example.github.io/noname${path}`);
		assert.equal(new URL(url + ".js").pathname, `/noname${path}.js`);
		assert.equal(new URL(url + ".ts").pathname, `/noname${path}.ts`);
	}
});

test("origin-root deployments preserve the original package URLs", () => {
	for (const path of packagePaths) {
		assert.equal(resolvePackURL(path, "http://127.0.0.1:8081/"), `http://127.0.0.1:8081${path}`);
	}
});

test("relative paths and Unicode extension names resolve from the module's game root", () => {
	assert.equal(resolvePackURL("card/standard", "https://example.github.io/games/noname/"), "https://example.github.io/games/noname/card/standard");
	assert.equal(resolvePackURL("/extension/中文扩展/extension", "https://example.github.io/noname/"), "https://example.github.io/noname/extension/%E4%B8%AD%E6%96%87%E6%89%A9%E5%B1%95/extension");
});
