/** Only compile extension modules and the JIT probe within this registration. */
export function isJitRequest(requestURL: string, registrationScope: string, method = "GET"): boolean {
	if (method.toUpperCase() !== "GET") return false;
	let request: URL;
	let scope: URL;
	try {
		request = new URL(requestURL);
		scope = new URL(registrationScope);
	} catch {
		return false;
	}
	if (!/^https?:$/.test(request.protocol) || request.origin !== scope.origin) return false;
	const scopePath = scope.pathname.endsWith("/") ? scope.pathname : `${scope.pathname}/`;
	if (!request.pathname.startsWith(scopePath)) return false;
	const path = request.pathname.slice(scopePath.length);
	// Ambiguous escaped separators can be interpreted differently by web hosts.
	// They are not needed by game extension paths and must not widen the scope.
	for (const segment of path.split("/")) {
		let decoded = segment;
		try {
			for (let depth = 0; depth < 8; depth++) {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			}
		} catch {
			return false;
		}
		if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) return false;
	}
	return path === "jit-test.ts" || path.startsWith("extension/");
}
