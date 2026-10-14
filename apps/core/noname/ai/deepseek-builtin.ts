/** Audit bookkeeping only: never selects, resumes, or modifies a game result. */
const pending = new WeakSet<object>();
const completed = new WeakSet<object>();

export function markBuiltinDecision(event: object, builtin = true) {
	if (builtin) pending.add(event);
	else pending.delete(event);
}

export function recordCompletedBuiltinDecision(event: any, engine: { game: any; status: any }, record: (event: any) => void): boolean {
	try {
		if (!event || !pending.has(event) || completed.has(event)) return false;
		if (engine.status.video || engine.status.connectMode || engine.game.online || event.player === engine.game.me || event.isMine?.() || event.isOnline?.()) return false;
		// A cancelled skill backup may restart the same event; it is not a final decision.
		if (!event.result || typeof event.result !== "object" || event.result.cancel === true) return false;
		pending.delete(event);
		completed.add(event);
		record(event);
		return true;
	} catch {
		// Quota errors and recording callbacks must never change the native AI's outcome.
		return false;
	}
}
