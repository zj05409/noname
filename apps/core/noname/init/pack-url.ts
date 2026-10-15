/** Package paths are relative to noname.js, including on project-hosted Pages. */
export function resolvePackURL(path: string, rootURL: string | URL): string {
	return new URL(path.replace(/^\/+/, ""), rootURL).href;
}
