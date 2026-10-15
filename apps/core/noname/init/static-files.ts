/** A build-time inventory for the read-only game files hosted by GitHub Pages. */
export interface StaticFileManifest {
	version: 1;
	files: string[];
	/** Empty directories may be included; all parent directories are inferred. */
	directories?: string[];
}

type StaticFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type StaticFileApiOptions = {
	baseURL: string | URL;
	manifest?: StaticFileManifest;
	fetch?: StaticFetch;
};

type Inventory = {
	files: Set<string>;
	directories: Set<string>;
	children: Map<string, { folders: Set<string>; files: Set<string> }>;
};

export const STATIC_READ_ONLY_MESSAGE = "网页版只支持读取游戏文件";

function fail(code: string, message: string): never {
	throw new Error(`${code}: ${message}`);
}

function hasControlCharacters(value: string): boolean {
	return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Root-relative file paths refer to the game root, never to the hosting origin. */
export function normalizeStaticPath(path: string): string {
	if (typeof path !== "string" || hasControlCharacters(path) || path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
		fail("EINVAL", "Invalid path: 只能访问游戏文件目录");
	}
	const normalized: string[] = [];
	for (const part of path.replace(/^\//, "").split("/")) {
		if (!part || part === ".") continue;
		let decoded = part;
		// Reject encoded traversal as well as literal traversal, without treating
		// '%' in ordinary asset names as a URL escape when constructing requests.
		for (let count = 0; count < 8; count++) {
			let next: string;
			try {
				next = decodeURIComponent(decoded);
			} catch {
				break;
			}
			if (next === decoded) break;
			decoded = next;
		}
		if (decoded === ".." || decoded === "." || hasControlCharacters(decoded) || /[/\\]/.test(decoded)) {
			fail("EINVAL", "Invalid path: 只能访问游戏文件目录");
		}
		normalized.push(part);
	}
	return normalized.join("/");
}

function makeInventory(manifest: StaticFileManifest): Inventory {
	if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || (manifest.directories !== undefined && !Array.isArray(manifest.directories))) {
		fail("EIO", "游戏文件清单格式无效，请刷新页面");
	}
	const files = new Set<string>();
	const directories = new Set<string>([""]);
	const children: Inventory["children"] = new Map();
	const childSet = (path: string) => {
		let value = children.get(path);
		if (!value) children.set(path, (value = { folders: new Set(), files: new Set() }));
		return value;
	};
	childSet("");
	const addDirectory = (path: string) => {
		let parent = "";
		for (const name of path.split("/").filter(Boolean)) {
			childSet(parent).folders.add(name);
			parent = parent ? `${parent}/${name}` : name;
			directories.add(parent);
			childSet(parent);
		}
	};
	for (const rawPath of manifest.directories ?? []) {
		addDirectory(normalizeStaticPath(rawPath));
	}
	for (const rawPath of manifest.files) {
		const path = normalizeStaticPath(rawPath);
		if (!path) fail("EIO", "游戏文件清单包含空文件名");
		const index = path.lastIndexOf("/");
		const parent = index < 0 ? "" : path.slice(0, index);
		const name = index < 0 ? path : path.slice(index + 1);
		addDirectory(parent);
		files.add(path);
		childSet(parent).files.add(name);
	}
	for (const file of files) {
		if (directories.has(file)) fail("EIO", "游戏文件清单中存在重复文件和目录");
	}
	return { files, directories, children };
}

/**
 * Return the same data as the local file endpoints, using only a static manifest
 * and same-origin asset requests. No DOM or game state is required.
 */
export function createStaticFileApi(options: StaticFileApiOptions) {
	const base = new URL(".", options.baseURL);
	if (!/^https?:$/.test(base.protocol)) fail("EINVAL", "Invalid path: 网页文件必须使用 HTTP 或 HTTPS");
	const fetchFile = options.fetch ?? ((input, init) => fetch(input, init));
	let inventory: Promise<Inventory> | undefined;
	const safeFetch = async (url: URL) => {
		if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) fail("EINVAL", "Invalid path: 只能访问游戏文件目录");
		const response = await fetchFile(url, { method: "GET", mode: "same-origin", credentials: "omit", redirect: "error" });
		// Redirects are forbidden above. This additional check also covers custom
		// fetch implementations that do not honor the redirect option.
		if (response.url) {
			const finalURL = new URL(response.url);
			if (finalURL.origin !== base.origin || !finalURL.pathname.startsWith(base.pathname)) fail("EACCES", "拒绝访问游戏目录以外的文件");
		}
		if (!response.ok) fail(response.status === 404 ? "ENOENT" : "EIO", `读取游戏文件失败（HTTP ${response.status}）`);
		return response;
	};
	const loadInventory = () => {
		if (!inventory) {
			inventory = (async () => {
				const manifest = options.manifest ?? (await (await safeFetch(new URL("static-files.json", base))).json());
				return makeInventory(manifest);
			})();
			inventory.catch(() => {
				inventory = undefined;
			});
		}
		return inventory;
	};

	return async function requestStaticFileApi(route: string, rawPath: string, _query?: Record<string, string>, init?: RequestInit) {
		if (!["/checkFile", "/readFile", "/getFileList"].includes(route) || (init?.method && init.method.toUpperCase() !== "GET")) {
			fail("EROFS", STATIC_READ_ONLY_MESSAGE);
		}
		const path = normalizeStaticPath(rawPath);
		const state = await loadInventory();
		const type = state.files.has(path) ? "file" : state.directories.has(path) ? "directory" : null;
		if (route === "/checkFile") return type;
		if (type === null) fail("ENOENT", "游戏文件不存在");
		if (route === "/getFileList") {
			if (type !== "directory") fail("ENOTDIR", "不是目录");
			const entries = state.children.get(path)!;
			return { folders: [...entries.folders].sort(), files: [...entries.files].sort() };
		}
		if (type !== "file") fail("EISDIR", "不是文件");
		const assetURL = new URL(path.split("/").map(encodeURIComponent).join("/"), base);
		return new Uint8Array(await (await safeFetch(assetURL)).arrayBuffer());
	};
}
