import assert from "node:assert/strict";
import test from "node:test";
import { toOutputImportMapPath } from "./vite-plugin-importmap";

test("import-map dependencies are relative to the deployed game root", () => {
	assert.equal(toOutputImportMapPath("/repo/apps/core", "/repo/apps/core/node_modules/.pnpm/vue/node_modules/vue/index.js"), "./node_modules/.pnpm/vue/node_modules/vue/index.js");
	assert.equal(toOutputImportMapPath("/repo/apps/core", "/repo/node_modules/.pnpm/vue/node_modules/vue/index.js"), "./node_modules/.pnpm/vue/node_modules/vue/index.js");
	assert.equal(new URL(toOutputImportMapPath("/repo/apps/core", "/repo/node_modules/pkg/index.js"), "https://example.github.io/noname/index.html").href, "https://example.github.io/noname/node_modules/pkg/index.js");
});
