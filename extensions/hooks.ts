/**
 * Lifecycle hooks — pi-event handlers that mirror the Claude Code hook
 * semantics described in shodh's docs. The mapping:
 *
 *     Claude Code hook       │  pi event
 *     ───────────────────────┼─────────────────────────────────
 *     SessionStart           │  session_start
 *     UserPromptSubmit       │  before_agent_start
 *     PreToolUse             │  (covered by before_agent_start surfacing)
 *     PostToolUse            │  tool_result  (Bash error capture)
 *     (assistant text)       │  message_end  (decision/insight extraction)
 *     Stop                   │  session_shutdown
 *
 * The high-level loop:
 *
 *   start  ──────► spawn binary, fetch context_summary, attach status widget
 *   prompt ──────► proactive_context(prompt) → suffix the system prompt
 *   bash err ────► remember(Error, arousal=0.7)   ← high-surprise encoding
 *   asst end ────► auto-detect surprises in assistant text → remember(Pattern/Discovery)
 *   shutdown ────► graceful kill of binary
 *
 * Auto-store rules in `message_end` are deliberately conservative: the
 * canonical "store on surprise" path is the explicit `shodh_remember`
 * tool driven by the system-prompt directive. The auto rules here are a
 * safety net for the obvious cases (errors, "decided to / chose to"
 * statements) so something gets captured even when the model forgets
 * to call the tool.
 */

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import type { RecalledMemory } from "./types.ts";
import { deriveUserId, type ShodhServer } from "./shodh-server.ts";
import { SURPRISE_DIRECTIVE } from "./system-prompt.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull text from a memory regardless of whether the API flattened it. */
function memoryContent(m: RecalledMemory): string {
	return m.experience?.content ?? m.content ?? "";
}
function memoryType(m: RecalledMemory): string {
	return m.experience?.memory_type ?? m.memory_type ?? "Memory";
}

/** Extract the first text block from an assistant message. */
function assistantText(message: MessageEndEvent["message"]): string {
	if (message.role !== "assistant") return "";
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Word-boundary error detection adapted from shodh's hook script (with the
 * same false-positive guards). We use it to decide whether a Bash result
 * deserves an Error memory.
 */
const ERROR_PATTERNS = [
	/\berror\[E\d+\]/i,
	/\bError:/,
	/\bFAILED\b/,
	/\bexit code [1-9]\d*/,
	/\bpanic(?:ked)?\b/i,
	/\bcommand not found\b/i,
	/\bpermission denied\b/i,
	/\bsyntax error\b/i,
	/\bSegmentation fault\b/,
	/\bfatal:/i,
	/\bAborted\b/,
];
const ERROR_FALSE_POSITIVES = [
	/\b0 errors?\b/i,
	/\bno errors?\b/i,
	/\bsucceeded\b/i,
	/\berror-free\b/i,
	/\bwithout errors?\b/i,
	/\berrors?: 0\b/i,
];
function isErrorOutput(text: string): boolean {
	for (const fp of ERROR_FALSE_POSITIVES) if (fp.test(text)) return false;
	for (const p of ERROR_PATTERNS) if (p.test(text)) return true;
	return false;
}

/**
 * Heuristics for assistant-text auto-storage. Conservative — only fires
 * on phrases that strongly imply a *decision* or *generalisable insight*.
 * The model is supposed to do the bulk of storage via shodh_remember;
 * this is the safety net.
 */
const DECISION_CUE = /\b(decided to|chose to|will use|going with|the approach is|opted for)\b/i;
const INSIGHT_CUE = /\b(turns out|root cause|the bug was|the fix is|key insight|important:)\b/i;

interface AutoCapture {
	type: "Decision" | "Discovery";
	content: string;
}
function detectAutoCapture(text: string): AutoCapture | null {
	if (text.length < 60) return null;
	const decisionMatch = text.match(DECISION_CUE);
	if (decisionMatch) {
		return { type: "Decision", content: extractAroundMatch(text, decisionMatch.index!, 200) };
	}
	const insightMatch = text.match(INSIGHT_CUE);
	if (insightMatch) {
		return { type: "Discovery", content: extractAroundMatch(text, insightMatch.index!, 200) };
	}
	return null;
}
function extractAroundMatch(text: string, idx: number, budget: number): string {
	// Pull the sentence-ish window around the cue.
	const start = Math.max(0, text.lastIndexOf(".", idx) + 1);
	const end = Math.min(text.length, text.indexOf(".", idx + 1) + 1 || idx + budget);
	return text.slice(start, end).trim().slice(0, budget);
}

// ---------------------------------------------------------------------------
// Hook installer
// ---------------------------------------------------------------------------

/** Track which user prompts we've already auto-stored to avoid duplicates within a turn. */
interface HookState {
	storedAssistantSnippets: Set<string>;
}

export function installHooks(pi: ExtensionAPI, server: ShodhServer): void {
	const state: HookState = {
		storedAssistantSnippets: new Set(),
	};

	// -----------------------------------------------------------------------
	// session_start — analog of Claude Code's SessionStart hook
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Switch to a per-project memory namespace BEFORE starting the server,
		// so subsequent remember/recall calls go to the right userId. The
		// shodh server itself is shared across projects — only the userId
		// (memory namespace) differs. SHODH_USER_ID env var overrides this.
		server.setUserId(deriveUserId(ctx.cwd));

		ctx.ui.setStatus("shodh", "starting…");
		const ok = await server.start();
		if (!ok) {
			ctx.ui.setStatus(
				"shodh",
				"offline (binary not running — run `shodh init` or set SHODH_API_URL)",
			);
			return;
		}
		ctx.ui.setStatus("shodh", `memory online (ns=${server.config.userId})`);
	});

	// -----------------------------------------------------------------------
	// before_agent_start — analog of UserPromptSubmit
	//
	// Two jobs:
	//   1. Inject the surprise-driven memory directive into the system prompt
	//      (idempotent across handlers — chained via event.systemPrompt).
	//   2. Surface relevant past memories for this prompt and append them
	//      as a <shodh-memory> block, mirroring the Claude Code hook output.
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		// Reset per-turn dedup
		state.storedAssistantSnippets.clear();

		// Always extend the system prompt with the surprise directive.
		// Handlers chain via event.systemPrompt — we only append our part once.
		let nextSystemPrompt = event.systemPrompt;
		if (!nextSystemPrompt.includes("Memory: store only what surprised you")) {
			nextSystemPrompt = `${nextSystemPrompt}\n\n${SURPRISE_DIRECTIVE}`;
		}

		// Surface relevant memories (best-effort; never block the turn).
		if (!server.isReady() || !event.prompt || event.prompt.length < 10) {
			return { systemPrompt: nextSystemPrompt };
		}

		const resp = await server.proactiveContext(
			{
				user_id: server.config.userId,
				context: event.prompt.slice(0, 1500),
				max_results: 3,
				auto_ingest: false,
			},
			ctx.signal,
		);

		const memories = resp?.memories ?? [];
		if (memories.length === 0) {
			return { systemPrompt: nextSystemPrompt };
		}

		const lines = memories.map((m) => {
			const score = m.score != null ? `${Math.round(m.score * 100)}%` : "?";
			return `• [${memoryType(m)} · ${score}] ${memoryContent(m)}`;
		});
		const block = `\n\n<shodh-memory>\n${lines.join("\n")}\n</shodh-memory>`;

		ctx.ui.notify(`shodh: surfaced ${memories.length} memories`, "info");

		return { systemPrompt: `${nextSystemPrompt}${block}` };
	});

	// -----------------------------------------------------------------------
	// tool_result — analog of PostToolUse
	//
	// We focus on Bash errors because:
	//   - Errors are the highest-value implicit memories (high arousal in
	//     shodh's importance model — see hook script's classifyEmotion).
	//   - Edit/Write outcomes are usually predictable; storing them
	//     wholesale floods the store with noise (see "memory is the
	//     residual of surprise" essay).
	// -----------------------------------------------------------------------
	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (!server.isReady()) return;

		if (isBashToolResult(event)) {
			// content is an array of blocks; grab the text we care about.
			const textBlock = event.content.find((b) => b.type === "text");
			const text = textBlock && "text" in textBlock ? textBlock.text : "";
			if (!text || !isErrorOutput(text)) return;

			const command = (event.input as { command?: string })?.command ?? "(unknown)";
			await server.remember(
				{
					user_id: server.config.userId,
					content: `Command failed: ${command.slice(0, 120)} → ${text.slice(0, 240)}`,
					memory_type: "Error",
					tags: ["tool:bash", "auto-capture", "error"],
					importance: 0.75,
					emotional_arousal: 0.7,
					source_type: "system",
				},
				ctx.signal,
			);
		}
	});

	// -----------------------------------------------------------------------
	// message_end — extra capture from assistant turns (safety net)
	//
	// The primary path for storing surprises is the model calling
	// shodh_remember explicitly. This handler catches obvious decisions
	// and insights the model might have phrased without invoking the tool.
	// -----------------------------------------------------------------------
	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (!server.isReady()) return;
		if (event.message.role !== "assistant") return;

		const text = assistantText(event.message);
		if (!text) return;

		const capture = detectAutoCapture(text);
		if (!capture) return;

		// Dedup within turn
		const key = `${capture.type}:${capture.content.slice(0, 80)}`;
		if (state.storedAssistantSnippets.has(key)) return;
		state.storedAssistantSnippets.add(key);

		await server.remember(
			{
				user_id: server.config.userId,
				content: capture.content,
				memory_type: capture.type,
				tags: ["assistant-text", "auto-capture"],
				importance: capture.type === "Decision" ? 0.7 : 0.6,
				emotional_arousal: 0.4,
				source_type: "ai_generated",
			},
			ctx.signal,
		);
	});

	// -----------------------------------------------------------------------
	// session_shutdown — analog of Stop
	// -----------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		ctx.ui.setStatus("shodh", "stopping…");
		await server.stop();
	});
}
