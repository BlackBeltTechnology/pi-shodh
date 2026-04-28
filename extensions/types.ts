/**
 * Shared types for the pi-shodh extension.
 *
 * Mirrors the shapes used by shodh-memory's REST API (see openapi.yaml in
 * varun29ankuS/shodh-memory) without depending on the upstream package —
 * we only import what we actually use.
 */

/**
 * Memory types supported by shodh. The ordering here matches the importance
 * weights in the shodh hook script (memory-hook.ts → importanceForType):
 *   Decision (0.80) > Error (0.75) > Learning (0.70) > Discovery (0.65)
 *   > Pattern (0.60) > Task (0.55) > Context/Conversation/Observation (low).
 *
 * The "Surprise" memory bucket maps to Learning/Discovery — high arousal
 * encoding for things the model failed to predict (per SuRe, Fountas 2025).
 */
export type ShodhMemoryType =
	| "Observation"
	| "Decision"
	| "Learning"
	| "Error"
	| "Discovery"
	| "Pattern"
	| "Context"
	| "Task"
	| "Conversation";

export interface ShodhConfig {
	/** Base URL of the shodh server. Default: env SHODH_API_URL || http://127.0.0.1:3030 */
	baseUrl: string;
	/** API key. Default: env SHODH_API_KEY || dev key. */
	apiKey: string;
	/** User identifier. Default: env SHODH_USER_ID || "pi". */
	userId: string;
	/**
	 * Storage path for the shodh server's RocksDB. Default:
	 * `~/.cache/shodh-memory/data` (avoids re-creating across sessions).
	 */
	dataPath: string;
	/** Whether to spawn the bundled binary (true) or assume an external server (false). */
	spawnServer: boolean;
	/**
	 * Override for the platform binaries dir. Used only for testing /
	 * advanced setups. Defaults to `<package>/binaries/<platform>-<arch>`.
	 */
	binaryDir?: string;
	/** Quiet mode — suppress info-level UI notifications. */
	quiet: boolean;
}

export interface RememberRequest {
	user_id: string;
	content: string;
	memory_type?: ShodhMemoryType;
	tags?: string[];
	/** 0.0..1.0; if omitted, server auto-scores. */
	importance?: number;
	/** Surprise level if known by the caller; surfaces in retrieval scoring. */
	emotional_arousal?: number;
	/** Source classification: "system", "user", "ai_generated", etc. */
	source_type?: string;
}

export interface RememberResponse {
	id?: string;
	memory_id?: string;
	success?: boolean;
}

export interface RecallRequest {
	user_id: string;
	query: string;
	limit?: number;
	mode?: "semantic" | "associative" | "hybrid";
}

export interface RecalledMemory {
	id: string;
	experience?: { content: string; memory_type?: string; tags?: string[] };
	/** Some endpoints flatten content to top level; tolerate both. */
	content?: string;
	memory_type?: string;
	tags?: string[];
	importance?: number;
	score?: number;
	created_at?: string;
}

export interface RecallResponse {
	memories: RecalledMemory[];
	count?: number;
}

export interface ProactiveContextRequest {
	user_id: string;
	context: string;
	max_results?: number;
	/** Auto-store the context itself as an Observation memory. */
	auto_ingest?: boolean;
}

export interface ProactiveContextResponse {
	memories: Array<RecalledMemory & { score: number; relevance_reason?: string }>;
	memory_count: number;
	latency_ms?: number;
	ingested_memory_id?: string | null;
}
