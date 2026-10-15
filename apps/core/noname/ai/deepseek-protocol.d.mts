export interface DeepSeekUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
}
export interface DeepSeekSnapshot {
	kind: "decision" | "advice" | "plan";
	event: string;
	player: Record<string, unknown>;
	state: Record<string, unknown>;
	candidates: { id: string; label: string; [key: string]: unknown }[];
	prompt?: string;
}
export interface DeepSeekProtocolReply {
	choice: string | null;
	advice: string;
	source: "deepseek";
	model: string;
	plan?: string;
	memory?: string;
	identityBeliefs?: { id: string; role: "zhu" | "zhong" | "fan" | "nei" | "unknown"; confidence: number; reason: string }[];
	usage?: DeepSeekUsage;
}
export class DeepSeekProtocolError extends Error {
	constructor(status: number, code: string, message: string);
	status: number;
	code: string;
	model?: string;
	usage?: DeepSeekUsage;
	requestId?: string;
	durationMs?: number;
}
export const MAX_DEEPSEEK_SNAPSHOT_BYTES: number;
export const MAX_DEEPSEEK_RESPONSE_BYTES: number;
export const SYSTEM_PROMPT: string;
export function boundedSnapshot(input: unknown): DeepSeekSnapshot;
export function buildDeepSeekPayload(snapshot: DeepSeekSnapshot, model: string): Record<string, unknown>;
export function readUsage(input: unknown): DeepSeekUsage | null;
export function validateCompletion(completion: unknown, snapshot: DeepSeekSnapshot, model: string): DeepSeekProtocolReply;
