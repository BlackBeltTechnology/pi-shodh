/**
 * pi-shodh extension entry point.
 *
 * Wires the three pieces together:
 *   - ShodhServer        — binary lifecycle + REST client
 *   - hooks              — session_start, before_agent_start, tool_result, message_end, session_shutdown
 *   - tools              — shodh_remember / shodh_recall (LLM-callable)
 *
 * Configuration via env vars (see shodh-server.ts → defaultConfig):
 *   SHODH_API_URL    base URL of the server (default http://127.0.0.1:3030)
 *   SHODH_API_KEY    API key (default = dev key, fine for local use)
 *   SHODH_USER_ID    namespace for memories (default: per-project, derived from cwd)
 *   SHODH_DATA_PATH  RocksDB storage location (default ~/.cache/shodh-memory/data)
 *   SHODH_SPAWN=0    skip spawning the bundled binary (attach to external server)
 *   SHODH_QUIET=1    suppress shodh stdout/stderr in the pi UI
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installHooks } from "./hooks.ts";
import { ShodhServer } from "./shodh-server.ts";
import { registerRecallTool } from "./tools/recall.ts";
import { registerRememberTool } from "./tools/remember.ts";

export default function (pi: ExtensionAPI): void {
	const server = new ShodhServer();

	registerRememberTool(pi, server);
	registerRecallTool(pi, server);
	installHooks(pi, server);

	pi.registerCommand("shodh-status", {
		description: "Show shodh memory server status",
		handler: async (_args, ctx) => {
			const url = server.config.baseUrl;
			const ns = server.config.userId;
			const ready = server.isReady();
			ctx.ui.notify(
				ready
					? `shodh: online @ ${url}  ns=${ns}`
					: `shodh: offline (set SHODH_API_URL or check binary)`,
				ready ? "info" : "error",
			);
		},
	});
}
