/**
 * ShodhServer — manages the shodh-memory binary lifecycle and exposes a
 * typed HTTP client for the REST API.
 *
 * Why a class: lifecycle (start/stop/health) and request state (apiKey,
 * baseUrl, AbortController for shutdown) need to live somewhere. Closing
 * over them in the factory function works for one-instance use, but a
 * class makes testing and readability easier.
 *
 * Lifecycle:
 *   1. constructor(config)    – store config, no side effects
 *   2. await server.start()   – spawn binary if not already running, poll /health
 *   3. server.remember/recall – REST calls with X-API-Key
 *   4. await server.stop()    – SIGTERM the spawned process (no-op if attached)
 *
 * Failure modes are handled by returning null and logging; the caller is
 * always responsible for treating "server unreachable" as a soft failure
 * (we never want to crash a pi turn because shodh is down).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ProactiveContextRequest,
	ProactiveContextResponse,
	RecallRequest,
	RecallResponse,
	RememberRequest,
	RememberResponse,
	ShodhConfig,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Derive a stable, readable, and unique userId from a project directory.
 *
 * Format: `pi-<basename>-<8charHash>`
 *   - basename gives at-a-glance recognition in shodh's TUI / API
 *   - 8-char SHA-256 prefix of the absolute path disambiguates collisions
 *     (e.g. two `~/projects/api` checked out in different roots)
 *   - sanitized to [a-z0-9-]+ so it's safe in URLs, tags, filenames
 *
 * Examples:
 *   /home/skrot1/BME/szakdoga          -> pi-szakdoga-3f2a1c4d
 *   /tmp/foo bar/Project (1)           -> pi-project-1-9b2e4a8f
 *   (empty / unresolvable cwd)         -> pi (the legacy single-namespace id)
 */
export function deriveUserId(cwd: string | undefined): string {
	if (!cwd) return "pi";
	const abs = resolve(cwd);
	const rawName = basename(abs).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	const name = rawName || "project";
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
	return `pi-${name}-${hash}`;
}

/**
 * Default config — read env, fall back to local dev defaults.
 *
 * @param cwd  Working directory to derive a per-project namespace from.
 *             When omitted, falls back to the legacy global "pi" id so the
 *             function stays callable in unit tests / standalone scripts.
 */
export function defaultConfig(cwd?: string): ShodhConfig {
	return {
		baseUrl: process.env.SHODH_API_URL ?? "http://127.0.0.1:3030",
		apiKey: process.env.SHODH_API_KEY ?? "sk-shodh-dev-local-testing-key",
		// Per-project namespace by default; user can override with SHODH_USER_ID.
		// Same shodh server, separate userIds = naturally scoped recall.
		userId: process.env.SHODH_USER_ID ?? deriveUserId(cwd),
		dataPath: process.env.SHODH_DATA_PATH ?? join(homedir(), ".cache", "shodh-memory", "data"),
		spawnServer: process.env.SHODH_SPAWN !== "0",
		binaryDir: process.env.SHODH_BINARY_DIR,
		quiet: process.env.SHODH_QUIET === "1",
	};
}

/** Resolve the absolute path of the bundled platform binary. */
export function resolveBinaryPath(config: ShodhConfig): string | null {
	const baseDir = resolveBinaryDir(config);
	const entry = process.platform === "win32" ? "shodh-memory.bat" : "shodh-memory";
	const full = join(baseDir, entry);
	return existsSync(full) ? full : null;
}

/** Directory containing the platform's binary bundle. */
export function resolveBinaryDir(config: ShodhConfig): string {
	const platformKey = `${process.platform}-${process.arch}`;
	return config.binaryDir ?? join(__dirname, "..", "binaries", platformKey);
}

/**
 * Pick the bundled ONNX Runtime shared library that ships next to the
 * shodh binary. We pin shodh to this exact lib via ORT_DYLIB_PATH to
 * bypass shodh's cache-resolution path — some hosts have stale
 * `~/.cache/shodh-memory/onnxruntime/` from older shodh installs that
 * panic with `OrtGetApiBase not present` when loaded against v0.2.0.
 */
export function resolveOnnxRuntimePath(config: ShodhConfig): string | null {
	const dir = resolveBinaryDir(config);
	const names =
		process.platform === "win32"
			? ["onnxruntime.dll"]
			: process.platform === "darwin"
				? ["libonnxruntime.dylib"]
				: ["libonnxruntime.so"];
	for (const n of names) {
		const full = join(dir, n);
		if (existsSync(full)) return full;
	}
	return null;
}

export class ShodhServer {
	/**
	 * Mutable on purpose: the factory function constructs the server before
	 * we know the session's cwd, then session_start calls setUserId() with
	 * a per-project namespace. Other config fields (baseUrl, apiKey, paths)
	 * are stable for the process lifetime.
	 */
	config: ShodhConfig;
	private child: ChildProcess | null = null;
	/** Set to true once /health responded ok. */
	private ready = false;

	constructor(config: Partial<ShodhConfig> = {}) {
		this.config = { ...defaultConfig(), ...config };
	}

	/**
	 * Update the active userId. Call from session_start to switch to a
	 * per-project namespace. No-op if SHODH_USER_ID is set in the env
	 * (explicit user override always wins).
	 */
	setUserId(userId: string): void {
		if (process.env.SHODH_USER_ID) return;
		this.config = { ...this.config, userId };
	}

	// -------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------

	/**
	 * Ensure a shodh server is reachable. If one is already up at baseUrl
	 * (manually started, Docker, etc.) we attach to it. Otherwise we
	 * spawn the bundled binary and wait for /health.
	 *
	 * Returns true on success, false on any failure (server stays "down"
	 * from the extension's perspective; calls will fail gracefully).
	 */
	async start(timeoutMs = 8000): Promise<boolean> {
		// 1. If a server is already responding, attach to it (no spawn).
		if (await this.pingHealth(800)) {
			this.ready = true;
			return true;
		}

		if (!this.config.spawnServer) {
			return false;
		}

		// 2. Locate the bundled binary.
		const binary = resolveBinaryPath(this.config);
		if (!binary) {
			return false;
		}

		// 3. Ensure the data directory exists (RocksDB will refuse otherwise).
		try {
			mkdirSync(this.config.dataPath, { recursive: true });
		} catch {
			/* tolerate – server will surface its own error */
		}

		// 4. Spawn. The wrapper script (`shodh-memory` / .bat) sets
		// LD_LIBRARY_PATH and execs `shodh server`. Detach so it survives
		// the parent if pi crashes; we still kill it on graceful shutdown.
		const url = new URL(this.config.baseUrl);
		const onnxPath = resolveOnnxRuntimePath(this.config);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			SHODH_API_KEY: this.config.apiKey,
			SHODH_API_KEYS: this.config.apiKey,
			SHODH_DEV_API_KEY: this.config.apiKey,
			SHODH_HOST: url.hostname,
			SHODH_PORT: url.port || "3030",
			SHODH_MEMORY_PATH: this.config.dataPath,
		};
		// Pin ONNX Runtime to the bundled lib (overrides shodh's cache lookup).
		if (onnxPath) env.ORT_DYLIB_PATH = onnxPath;
		try {
			this.child = spawn(binary, [], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			});
		} catch {
			return false;
		}

		// Drain stdout/stderr so the child doesn't block on full pipes.
		// We don't echo by default to keep pi's TUI clean; users can opt
		// in via SHODH_QUIET=0.
		const verbose = !this.config.quiet;
		this.child.stdout?.on("data", (chunk) => {
			if (verbose) process.stderr.write(`[shodh] ${chunk}`);
		});
		this.child.stderr?.on("data", (chunk) => {
			if (verbose) process.stderr.write(`[shodh] ${chunk}`);
		});

		// 5. Poll /health until ready or timeout.
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.child.exitCode !== null) {
				// Process died early — don't keep polling.
				this.child = null;
				return false;
			}
			if (await this.pingHealth(400)) {
				this.ready = true;
				return true;
			}
			await sleep(200);
		}

		// 6. Timed out.
		await this.stop();
		return false;
	}

	/** Send SIGTERM to the spawned process. No-op if we attached to an external one. */
	async stop(): Promise<void> {
		this.ready = false;
		if (!this.child) return;
		try {
			this.child.kill("SIGTERM");
			// Give it a beat to flush; force-kill if it lingers.
			await Promise.race([
				new Promise<void>((res) => this.child?.once("exit", () => res())),
				sleep(2000),
			]);
			if (this.child && this.child.exitCode === null) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* tolerate */
		}
		this.child = null;
	}

	isReady(): boolean {
		return this.ready;
	}

	private async pingHealth(timeoutMs: number): Promise<boolean> {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), timeoutMs);
			const res = await fetch(`${this.config.baseUrl}/health`, {
				headers: { "X-API-Key": this.config.apiKey },
				signal: ctrl.signal,
			});
			clearTimeout(t);
			return res.ok;
		} catch {
			return false;
		}
	}

	// -------------------------------------------------------------------
	// HTTP client — typed wrappers for the endpoints we actually use.
	//
	// All requests:
	//   - Include X-API-Key
	//   - Honor an optional AbortSignal (from ctx.signal in pi handlers)
	//   - Return null on any failure (network, non-2xx, parse) so callers
	//     can use `if (!result) return;` without try/catch noise.
	// -------------------------------------------------------------------

	async remember(req: RememberRequest, signal?: AbortSignal): Promise<RememberResponse | null> {
		return this.post<RememberResponse>("/api/remember", req, signal);
	}

	async recall(req: RecallRequest, signal?: AbortSignal): Promise<RecallResponse | null> {
		return this.post<RecallResponse>("/api/recall", req, signal);
	}

	async proactiveContext(
		req: ProactiveContextRequest,
		signal?: AbortSignal,
	): Promise<ProactiveContextResponse | null> {
		return this.post<ProactiveContextResponse>("/api/proactive_context", req, signal);
	}

	private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
		if (!this.ready) return null;
		try {
			const res = await fetch(`${this.config.baseUrl}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": this.config.apiKey,
				},
				body: JSON.stringify(body),
				signal,
			});
			if (!res.ok) return null;
			return (await res.json()) as T;
		} catch {
			return null;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
