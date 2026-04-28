#!/usr/bin/env node
/**
 * fetch-binaries.mjs
 *
 * Two roles:
 *
 *   1. MAINTAINER (`npm run fetch-binaries` / `prepack`)
 *      Downloads the shodh-memory release archives for *all* supported
 *      platforms into ./binaries/<platform>-<arch>/. The result is what
 *      ships in the npm tarball (see package.json "files").
 *
 *   2. END USER (`postinstall`, via `--ensure-current`)
 *      Downloads ONLY the current host's binaries if they aren't already
 *      present. This handles `pi install git:...` where the git tree
 *      excludes binaries via .gitignore.
 *
 * Modes (CLI):
 *   node scripts/fetch-binaries.mjs                     # all platforms (maintainer)
 *   node scripts/fetch-binaries.mjs --tag v0.2.0        # pinned tag, all platforms
 *   node scripts/fetch-binaries.mjs --only linux-x64,darwin-arm64
 *   node scripts/fetch-binaries.mjs --ensure-current    # current host only, idempotent
 *   node scripts/fetch-binaries.mjs --quiet             # silence success lines
 *
 * Dependencies (runtime):
 *   - Node 22+ (uses native fetch, no curl)
 *   - `tar` on PATH. tar ships with macOS, Linux, and Windows 10 1803+
 *     and on modern systems handles BOTH tar.gz AND zip via libarchive,
 *     so we can drop the unzip dependency.
 *
 * No npm deps. Pure Node + one POSIX tool.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	chmodSync,
	existsSync,
	writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const BIN_ROOT = join(PKG_ROOT, "binaries");

const REPO = "varun29ankuS/shodh-memory";
const DEFAULT_TAG = "v0.2.0"; // Pinned default. CI/maintainers can override with --tag latest.

/**
 * Map node `${process.platform}-${process.arch}` triples to release asset
 * metadata. The `entry` field is what runtime code spawns; the wrapper
 * sets LD_LIBRARY_PATH and execs the real binary, so the rest of the
 * extracted bundle (shodh, shodh-memory-server, libonnxruntime.*) must
 * stay co-located.
 *
 * Keep keys in sync with extensions/shodh-server.ts (runtime path lookup).
 */
const PLATFORMS = {
	"linux-x64": { asset: "shodh-memory-linux-x64.tar.gz", entry: "shodh-memory", archive: "tar.gz" },
	"linux-arm64": { asset: "shodh-memory-linux-arm64.tar.gz", entry: "shodh-memory", archive: "tar.gz" },
	"darwin-x64": { asset: "shodh-memory-macos-x64.tar.gz", entry: "shodh-memory", archive: "tar.gz" },
	"darwin-arm64": { asset: "shodh-memory-macos-arm64.tar.gz", entry: "shodh-memory", archive: "tar.gz" },
	"win32-x64": { asset: "shodh-memory-windows-x64.zip", entry: "shodh-memory.bat", archive: "zip" },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = { tag: DEFAULT_TAG, only: null, ensureCurrent: false, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--tag") args.tag = argv[++i];
		else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim());
		else if (a === "--ensure-current") args.ensureCurrent = true;
		else if (a === "--quiet") args.quiet = true;
		else if (a === "--help" || a === "-h") {
			process.stdout.write(
				"Usage: node scripts/fetch-binaries.mjs " +
					"[--tag vX.Y.Z|latest] [--only platform-arch[,...]] [--ensure-current] [--quiet]\n",
			);
			process.exit(0);
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function makeLogger(quiet) {
	return {
		info: (msg) => {
			if (!quiet) process.stdout.write(`${msg}\n`);
		},
		warn: (msg) => process.stderr.write(`${msg}\n`),
		error: (msg) => process.stderr.write(`${msg}\n`),
	};
}

// ---------------------------------------------------------------------------
// Tool / platform detection
// ---------------------------------------------------------------------------

function hasCommand(cmd) {
	// `which` is more reliable than `--version`: many tools (e.g. unzip) don't
	// recognise --version and exit non-zero, which would falsely report them
	// as missing. We just want to know if the command exists on PATH.
	const probe = process.platform === "win32" ? "where" : "which";
	const r = spawnSync(probe, [cmd], { stdio: "pipe" });
	return r.status === 0;
}

function ensureExtractTools(log, needsZip) {
	if (!hasCommand("tar")) {
		log.error(
			"`tar` is required on PATH. macOS/Linux ship it; Windows 10 1803+ does too. " +
				"On older Windows, install Git for Windows (which provides tar) or run via WSL.",
		);
		process.exit(1);
	}
	// We try tar for both .tar.gz and .zip first (bsdtar / libarchive
	// handles zip; GNU tar does not). When tar can't open a zip, we fall
	// back to unzip. Only error out up front if a zip platform is targeted
	// AND neither tool can handle zip on this host.
	if (needsZip && !hasCommand("unzip")) {
		// Don't fail yet — bsdtar may still work. Just warn.
		log.info(
			"[pi-shodh] note: `unzip` not found; will rely on bsdtar/libarchive for .zip extraction.",
		);
	}
}

function currentPlatformKey() {
	const key = `${process.platform}-${process.arch}`;
	if (!PLATFORMS[key]) {
		return null;
	}
	return key;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function resolveTag(tag, log) {
	if (tag !== "latest") return tag;
	const url = `https://api.github.com/repos/${REPO}/releases/latest`;
	const res = await fetch(url, { headers: { "User-Agent": "pi-shodh-fetch" } });
	if (!res.ok) {
		throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
	}
	const data = await res.json();
	if (!data.tag_name) throw new Error("No tag_name in GitHub release response");
	log.info(`Resolved 'latest' to ${data.tag_name}`);
	return data.tag_name;
}

async function downloadFile(url, destPath) {
	const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "pi-shodh-fetch" } });
	if (!res.ok || !res.body) {
		throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
	}
	// Stream the response to disk to avoid buffering ~75MB in memory.
	const fileStream = (await import("node:fs")).createWriteStream(destPath);
	await new Promise((res2, rej) => {
		Readable.fromWeb(res.body).pipe(fileStream).on("finish", res2).on("error", rej);
	});
}

// ---------------------------------------------------------------------------
// Extract + install
// ---------------------------------------------------------------------------

async function downloadAndExtract(platformKey, spec, tag, log) {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${spec.asset}`;
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-shodh-fetch-"));
	const archivePath = join(tmpDir, spec.asset);
	const extractDir = join(tmpDir, "extract");
	mkdirSync(extractDir, { recursive: true });

	log.info(`\n→ ${platformKey}`);
	log.info(`  Downloading ${url}`);
	await downloadFile(url, archivePath);

	log.info(`  Extracting`);
	extractArchive(archivePath, extractDir, spec.archive, platformKey);

	// Some release archives wrap their contents in a single top-level dir;
	// detect & flatten so the runtime always finds spec.entry at the root
	// of binaries/<platform>-<arch>/.
	const payloadRoot = resolvePayloadRoot(extractDir, spec.entry);
	if (!payloadRoot) {
		throw new Error(
			`Could not locate entry script ${spec.entry} inside archive for ${platformKey}`,
		);
	}

	const targetDir = join(BIN_ROOT, platformKey);
	rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });

	// Copy the entire bundle (binaries + shared library + wrapper).
	// cpSync is cross-FS safe; renameSync would EXDEV on /tmp -> repo dir.
	cpSync(payloadRoot, targetDir, { recursive: true });

	// Restore exec bits across the bundle. npm/tar may strip them on
	// extraction. Skipped for win32 (.exe / .bat / .dll need no chmod).
	if (!platformKey.startsWith("win32")) {
		for (const file of readdirSync(targetDir, { withFileTypes: true })) {
			if (!file.isFile()) continue;
			try {
				chmodSync(join(targetDir, file.name), 0o755);
			} catch {
				/* tolerate; postinstall hook will retry on user machines */
			}
		}
	}

	const sizeMB = (dirSize(targetDir) / 1024 / 1024).toFixed(1);
	log.info(`  ✓ ${targetDir} (${sizeMB} MB total, entry=${spec.entry})`);

	rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Extract an archive. Tries bsdtar first (handles tar.gz AND zip), falls
 * back to GNU tar for tarballs, then to `unzip` for zip files. This makes
 * the script robust on Linux (GNU tar, no zip support), macOS (bsdtar),
 * and Windows (bsdtar via Win10+).
 */
function extractArchive(archivePath, destDir, archiveType, platformKey) {
	// First attempt: tar -xf — works for tarballs everywhere, and for zip
	// where tar is libarchive-based (macOS, FreeBSD, Win10+).
	const tarResult = spawnSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "pipe" });
	if (tarResult.status === 0) return;

	if (archiveType === "zip") {
		// Fall back to unzip for hosts where tar is GNU (Linux distros).
		if (!hasCommand("unzip")) {
			throw new Error(
				`Cannot extract ${platformKey} zip archive: neither bsdtar nor unzip succeeded. ` +
					`Install \`unzip\` or use a host with bsdtar (macOS, BSD, Win10+).`,
			);
		}
		const unzipResult = spawnSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "pipe" });
		if (unzipResult.status !== 0) {
			throw new Error(
				`unzip failed for ${platformKey} (exit ${unzipResult.status}): ${unzipResult.stderr?.toString() ?? ""}`,
			);
		}
		return;
	}

	throw new Error(
		`tar extract failed for ${platformKey} (exit ${tarResult.status}): ${tarResult.stderr?.toString() ?? ""}`,
	);
}

function resolvePayloadRoot(root, entryName, depth = 0) {
	if (depth > 3) return null;
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isFile() && entry.name === entryName) return root;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const nested = resolvePayloadRoot(join(root, entry.name), entryName, depth + 1);
			if (nested) return nested;
		}
	}
	return null;
}

function dirSize(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isFile()) total += statSync(p).size;
		else if (entry.isDirectory()) total += dirSize(p);
	}
	return total;
}

// ---------------------------------------------------------------------------
// Mode: --ensure-current
// ---------------------------------------------------------------------------

function isPlatformInstalled(platformKey) {
	const dir = join(BIN_ROOT, platformKey);
	const spec = PLATFORMS[platformKey];
	if (!spec) return false;
	return existsSync(join(dir, spec.entry));
}

// ---------------------------------------------------------------------------
// Stamp
// ---------------------------------------------------------------------------

async function writeStamp(tag, platforms, mode) {
	const stampPath = join(BIN_ROOT, "VERSION.json");
	let existing = {};
	try {
		existing = JSON.parse((await import("node:fs/promises")).readFileSync?.(stampPath, "utf8") ?? "{}");
	} catch {
		/* ignore */
	}
	const stamp = {
		tag,
		fetchedAt: new Date().toISOString(),
		platforms: Array.from(new Set([...(existing.platforms ?? []), ...platforms])).sort(),
		mode,
		repo: REPO,
	};
	mkdirSync(BIN_ROOT, { recursive: true });
	await writeFile(stampPath, JSON.stringify(stamp, null, 2) + "\n");
	return stampPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const log = makeLogger(args.quiet);

	let targets;
	let mode;

	if (args.ensureCurrent) {
		mode = "ensure-current";
		const key = currentPlatformKey();
		if (!key) {
			log.warn(
				`[pi-shodh] No bundled shodh-memory binary for ${process.platform}/${process.arch}. ` +
					`The extension will load but will not be able to spawn a server. ` +
					`Supported: ${Object.keys(PLATFORMS).join(", ")}.`,
			);
			// Exit 0 — refusing the install is harsher than letting the
			// extension report a clear runtime error later.
			return;
		}
		if (isPlatformInstalled(key)) {
			log.info(`[pi-shodh] ${key} binary already present, skipping fetch.`);
			return;
		}
		log.info(`[pi-shodh] Binary missing for ${key}; fetching from ${REPO} ${args.tag}...`);
		targets = [key];
	} else {
		mode = args.only ? "selected" : "all";
		targets = args.only ?? Object.keys(PLATFORMS);
		const unknown = targets.filter((t) => !PLATFORMS[t]);
		if (unknown.length) {
			log.error(`Unknown platform(s): ${unknown.join(", ")}`);
			log.error(`Known: ${Object.keys(PLATFORMS).join(", ")}`);
			process.exit(1);
		}
	}

	const needsZip = targets.some((k) => PLATFORMS[k]?.archive === "zip");
	ensureExtractTools(log, needsZip);

	const tag = await resolveTag(args.tag, log);
	log.info(`Fetching shodh-memory ${tag} from ${REPO} (${mode})`);

	mkdirSync(BIN_ROOT, { recursive: true });

	const failed = [];
	for (const key of targets) {
		try {
			await downloadAndExtract(key, PLATFORMS[key], tag, log);
		} catch (err) {
			log.error(`  ✗ ${key}: ${err.message}`);
			failed.push(key);
		}
	}

	const stampPath = await writeStamp(
		tag,
		targets.filter((k) => !failed.includes(k)),
		mode,
	);
	log.info(`Wrote ${stampPath}`);

	if (failed.length) {
		log.error(`\nFailed: ${failed.join(", ")}`);
		// In ensure-current mode, a failure means the user has no binary
		// at all — surface that loudly but don't fail the npm install,
		// because users can manually rerun `npm run fetch-binaries`.
		if (args.ensureCurrent) {
			log.error(
				`[pi-shodh] Could not download binary. Check network/proxy. ` +
					`The extension will fail to spawn the server until you re-run install.`,
			);
			return;
		}
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`${err.stack ?? err.message}\n`);
	process.exit(1);
});
