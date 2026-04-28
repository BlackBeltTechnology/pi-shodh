/**
 * `shodh_recall` — explicit memory retrieval tool for the LLM.
 *
 * Most retrieval is automatic via `before_agent_start` (proactive_context),
 * but the model can explicitly query when the user references "before",
 * "last time", "we agreed", etc.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { RecalledMemory } from "../types.ts";
import type { ShodhServer } from "../shodh-server.ts";

const RecallParams = Type.Object({
	query: Type.String({
		description: "Natural-language search query. Be specific — entities, file names, or topics work best.",
	}),
	limit: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Max memories to return (default 5)." }),
	),
	mode: Type.Optional(
		StringEnum(["semantic", "associative", "hybrid"] as const),
	),
});

export type RecallInput = Static<typeof RecallParams>;

/** Pull a content string out of either flat or nested shodh response shapes. */
function memoryContent(m: RecalledMemory): string {
	return m.experience?.content ?? m.content ?? "(no content)";
}
function memoryType(m: RecalledMemory): string {
	return m.experience?.memory_type ?? m.memory_type ?? "Memory";
}

export function registerRecallTool(pi: ExtensionAPI, server: ShodhServer): void {
	pi.registerTool({
		name: "shodh_recall",
		label: "Recall",
		description:
			"Search the persistent memory store. Use when the user references something from " +
			"a previous session ('last time', 'we agreed', 'before', 'remember when…') or " +
			"when you suspect prior context exists that wasn't auto-surfaced.",
		promptSnippet: "Search the persistent memory store by natural-language query.",
		promptGuidelines: [
			"Use shodh_recall before answering questions that reference 'before', 'last time', or 'we agreed'.",
		],
		parameters: RecallParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
			if (!server.isReady()) {
				return {
					content: [{ type: "text", text: "Memory unavailable (shodh server not running)." }],
					details: { error: "server-not-ready" },
				};
			}

			const resp = await server.recall(
				{
					user_id: server.config.userId,
					query: params.query,
					limit: params.limit ?? 5,
					mode: params.mode ?? "hybrid",
				},
				signal,
			);

			if (!resp || !resp.memories || resp.memories.length === 0) {
				return {
					content: [{ type: "text", text: `No memories found for: ${params.query}` }],
					details: { count: 0 },
				};
			}

			const lines = resp.memories.map((m, i) => {
				const score = m.score != null ? `${Math.round(m.score * 100)}%` : "?";
				const type = memoryType(m);
				const content = memoryContent(m);
				return `${i + 1}. [${type} · ${score}] ${content}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Found ${resp.memories.length} memor${resp.memories.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`,
					},
				],
				details: {
					count: resp.memories.length,
					memories: resp.memories.map((m) => ({
						id: m.id,
						content: memoryContent(m),
						memory_type: memoryType(m),
						score: m.score,
					})),
				},
			};
		},
	});
}
