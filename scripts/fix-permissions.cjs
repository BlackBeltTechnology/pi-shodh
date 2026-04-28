/**
 * fix-permissions.cjs
 *
 * Postinstall script. Runs every time the package is installed (npm install,
 * pi install, etc.). Ensures the bundled shodh-memory binaries have the
 * execute bit set on unix-like systems.
 *
 * Why this exists:
 *   npm sometimes strips the execute bit from files extracted out of a
 *   package tarball, depending on how the publisher's filesystem and
 *   `npm publish` interact. Without the +x bit, `child_process.spawn`
 *   on the binary fails with EACCES. This is the same class of issue
 *   node-pty solves with its postinstall in pi-agent-dashboard
 *   (packages/server/scripts/fix-pty-permissions.cjs).
 *
 * Strategy:
 *   - Locate ../binaries/ relative to this script.
 *   - chmod 0o755 every file under each platform subdir.
 *   - Skip win32 (.exe doesn't need a unix exec bit).
 *   - Silent no-op if the binaries dir is missing (e.g. someone is
 *     working inside a checkout of the source repo before fetching).
 *
 * Hoist note: unlike the dashboard's case (where node-pty may live in
 * a hoisted node_modules far from the postinstall script), our binaries
 * are co-located with this script INSIDE our own package, so a simple
 * relative path is correct in all install layouts (top-level, nested,
 * monorepo workspace, pi-installed git package, etc.).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (os.platform() === "win32") {
	// .exe needs no chmod; nothing to do.
	process.exit(0);
}

const binariesDir = path.join(__dirname, "..", "binaries");

let entries;
try {
	entries = fs.readdirSync(binariesDir, { withFileTypes: true });
} catch (err) {
	if (err && err.code === "ENOENT") {
		// Binaries not present (source checkout, --ignore-scripts on the
		// fetch step, etc.). Nothing to fix; not an error here.
		process.exit(0);
	}
	process.stderr.write(`[pi-shodh fix-permissions] readdir ${binariesDir} failed: ${err.message}\n`);
	process.exit(0);
}

let fixed = 0;
for (const entry of entries) {
	if (!entry.isDirectory()) continue;
	if (entry.name.startsWith("win32-")) continue;

	const platformDir = path.join(binariesDir, entry.name);
	let files;
	try {
		files = fs.readdirSync(platformDir, { withFileTypes: true });
	} catch (err) {
		process.stderr.write(`[pi-shodh fix-permissions] readdir ${platformDir} failed: ${err.message}\n`);
		continue;
	}

	for (const file of files) {
		if (!file.isFile()) continue;
		const target = path.join(platformDir, file.name);
		try {
			fs.chmodSync(target, 0o755);
			fixed++;
		} catch (err) {
			if (err && err.code !== "ENOENT") {
				process.stderr.write(
					`[pi-shodh fix-permissions] chmod ${target} failed: ${err.message}\n`,
				);
			}
		}
	}
}

if (fixed > 0 && process.env.PI_SHODH_VERBOSE) {
	process.stdout.write(`[pi-shodh fix-permissions] chmod +x on ${fixed} binar${fixed === 1 ? "y" : "ies"}\n`);
}
