/**
 * `shodh_remember` — explicit memory storage tool for the LLM.
 *
 * The LLM should call this when something surprised it (see system-prompt.ts).
 * The tool is intentionally narrow: content + memory_type + tags. We don't
 * expose every shodh field — adding params is a tax on the model's choice.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ShodhServer } from "../shodh-server.ts";

const RememberParams = Type.Object({
	content: Type.String({
		description:
			"One-sentence summary of the surprising fact. Be concrete — include the *what* and *why-it-matters*.",
	}),
	memory_type: StringEnum([
		"Decision",
		"Learning",
		"Error",
		"Discovery",
		"Pattern",
		"Task",
		"Observation",
	] as const),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "2-4 short tags for retrieval (e.g. 'auth', 'rust', 'preference').",
			maxItems: 8,
		}),
	),
	importance: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description:
				"Override auto-importance (0-1). Use only if the default for memory_type is wrong for this case.",
		}),
	),
});

export type RememberInput = Static<typeof RememberParams>;

export function registerRememberTool(pi: ExtensionAPI, server: ShodhServer): void {
	pi.registerTool({
		name: "shodh_remember",
		label: "Remember",
		description:
			"Store a surprising fact in long-term memory. Call ONLY when the new information " +
			"would have failed your prediction (contradicted context, revealed a non-obvious " +
			"preference, exposed a constraint). Skip confirmations, echoes, and predictable details.",
		promptSnippet: "Persist a memory the model would not have predicted from current context.",
		promptGuidelines: [
			"Use shodh_remember for surprises only — facts that violate your expectations.",
			"Use shodh_remember with concise one-sentence content; the surprising delta, not the raw quote.",
		],
		parameters: RememberParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
			if (!server.isReady()) {
				return {
					content: [{ type: "text", text: "Memory unavailable (shodh server not running)." }],
					details: { error: "server-not-ready" },
				};
			}

			const resp = await server.remember(
				{
					user_id: server.config.userId,
					content: params.content,
					memory_type: params.memory_type,
					tags: params.tags ?? [],
					importance: params.importance,
					emotional_arousal: params.memory_type === "Error" ? 0.7 : 0.3,
					source_type: "ai_generated",
				},
				signal,
			);

			if (!resp || (!resp.id && !resp.memory_id)) {
				return {
					content: [{ type: "text", text: "Memory store failed." }],
					details: { error: "store-failed" },
				};
			}

			const id = resp.id ?? resp.memory_id!;
			return {
				content: [
					{
						type: "text",
						text: `Stored ${params.memory_type} memory: "${params.content}" (id=${id.slice(0, 8)})`,
					},
				],
				details: {
					id,
					memory_type: params.memory_type,
					tags: params.tags ?? [],
				},
			};
		},
	});
}
