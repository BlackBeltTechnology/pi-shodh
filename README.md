# pi-shodh

Persistent, surprise-driven memory for [pi](https://github.com/mariozechner/pi-coding-agent) — backed by [shodh-memory](https://github.com/varun29ankuS/shodh-memory). Your pi sessions remember what mattered last time, surface relevant context automatically, and let the model store new insights through a single tool call.

```
┌─────────────────────────────────────────────────────────────┐
│  pi turn                                                     │
│                                                              │
│  user prompt ──► before_agent_start                          │
│                  ├─ inject "store on surprise" directive     │
│                  └─ /api/proactive_context  ──► <shodh>...   │
│                                                              │
│  model thinks ──► may call shodh_remember / shodh_recall     │
│                                                              │
│  bash error  ───► tool_result hook  ──► /api/remember(Error) │
│  decision    ───► message_end hook   ──► /api/remember(...)  │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP
                           ▼
              ┌─────────────────────────────┐
              │  shodh-memory binary        │
              │  (Rust, local, offline)     │
              │  ~/.cache/shodh-memory/data │
              └─────────────────────────────┘
```

---

## Table of Contents

- [Why](#why)
- [Install](#install)
- [How it works](#how-it-works)
  - [The four hooks](#the-four-hooks)
  - [The two tools](#the-two-tools)
  - [The system-prompt directive](#the-system-prompt-directive)
- [Configuration](#configuration)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Developer guide](#developer-guide)
- [Theoretical background](#theoretical-background)
- [License](#license)

---

## Why

Most agent memory systems store everything and over time become noise. pi-shodh is built on a different premise — drawn from neuroscience and recent LLM-memory research:

> **Memory is the residual of surprise.**
> Don't store what your world model already predicted. Store what violated your expectations.

The extension wires this idea into pi's lifecycle, so the model *should* only persist things it would have failed to predict — and recalls past surprises automatically when relevant. See [Theoretical background](#theoretical-background) for the papers that informed this.

Backed by **shodh-memory** — a local Rust binary with offline embeddings, Hebbian learning, and three-tier decay. No cloud, no API keys, no Docker required.

---

## Install

### From git

```bash
# project-local — only loads in this project
pi install -l git:github.com/<you>/pi-shodh

# global — all pi sessions
pi install git:github.com/<you>/pi-shodh

# pin to a tag or branch
pi install -l git:github.com/<you>/pi-shodh@v0.1.0
```

### From a local clone

```bash
git clone https://github.com/<you>/pi-shodh
cd pi-shodh
npm install
pi install -l "$PWD"            # project-local
# or: pi install "$PWD"          # global
```

### What `pi install` does

1. Resolves the package (git clone or local path)
2. Runs `npm install`
3. Runs `postinstall`:
   - `fetch-binaries.mjs --ensure-current` — downloads **only your platform's** binary (~75 MB) from [shodh's GitHub releases](https://github.com/varun29ankuS/shodh-memory/releases)
   - `fix-permissions.cjs` — chmod +x on the bundled files
4. Auto-discovers the extension via `package.json#pi.extensions`

Idempotent — re-running is fast (~150 ms) when binaries are already in place.

### Where things live

| Thing | Path |
|---|---|
| Extension settings (project) | `<your-project>/.pi/settings.json` |
| Extension settings (global) | `~/.pi/agent/settings.json` |
| Git-cloned package (project) | `<your-project>/.pi/git/github.com/<you>/pi-shodh/` |
| Git-cloned package (global) | `~/.pi/agent/git/github.com/<you>/pi-shodh/` |
| Downloaded binaries | `<package>/binaries/<platform>-<arch>/` |
| Memory database | `~/.cache/shodh-memory/data/` |

No Docker, no npm registry, no API keys.

### Verify

Inside pi after install:

```
/shodh-status
```

You should see `shodh: online @ http://127.0.0.1:3030`. If you see *offline*, check [Troubleshooting](#troubleshooting).

---

## How it works

### The four hooks

The extension subscribes to four pi events. Each one mirrors a [Claude Code hook](https://docs.anthropic.com/en/docs/claude-code/hooks) from the upstream shodh integration.

| pi event | What we do | Mirrors Claude Code hook |
|---|---|---|
| `session_start` | Spawn the bundled shodh binary, poll `/health`, set status widget | `SessionStart` |
| `before_agent_start` | (1) Append the surprise directive to the system prompt; (2) call `/api/proactive_context` and inject results as `<shodh-memory>` block | `UserPromptSubmit` |
| `tool_result` | Detect bash errors → store as `Error` memory with high arousal (0.7) so they surface later | `PostToolUse` |
| `message_end` | Scan assistant text for "decided to / turns out / the fix is" cues → safety-net auto-capture as `Decision` / `Discovery` | (no direct equivalent) |
| `session_shutdown` | SIGTERM the binary; SIGKILL fallback after 2s | `Stop` |

All hooks are **best-effort** — if the shodh server is unreachable, hooks return silently and the pi turn continues. Nothing in pi-shodh can crash a turn.

### The two tools

The model can call these explicitly (and the system prompt nudges it to):

#### `shodh_remember`

```typescript
{
  content: "User prefers TypeScript strict mode for all new projects",
  memory_type: "Decision",   // Decision | Learning | Error | Discovery | Pattern | Task | Observation
  tags: ["preferences", "typescript"],
  importance: 0.8            // optional override (0.0–1.0)
}
```

The directive in the system prompt says: **call this only when the new information would have failed your prediction**. Echoing back what the user said, restating obvious facts, or storing line numbers/timestamps is explicitly discouraged.

#### `shodh_recall`

```typescript
{
  query: "what did we decide about typescript settings",
  limit: 5,                  // optional, default 5
  mode: "hybrid"             // semantic | associative | hybrid
}
```

The model is nudged to call this when the user references "before", "last time", "we agreed", or "remember when…".

### The system-prompt directive

Every turn, before the agent loop starts, this gets appended to the system prompt:

```
## Memory: store only what surprised you

This session is connected to a persistent memory store via shodh_remember
and shodh_recall …

When to call shodh_remember: after each user turn, briefly check whether
anything in the new information would have failed your prediction —
contradicted prior context, revealed a non-obvious preference, exposed a
constraint you didn't have, or violated an assumption you were operating
on. If yes, store it. …

When NOT to call it:
  - The user confirmed something you already inferred
  - You're echoing back what was just said
  - The fact is recoverable by reading a file …

The rule: memory is the residual of surprise.
```

Full text: [`extensions/system-prompt.ts`](extensions/system-prompt.ts).

---

## Configuration

All knobs are environment variables (no config file). Defaults work for local single-user use.

| Env var | Default | What it does |
|---|---|---|
| `SHODH_API_URL` | `http://127.0.0.1:3030` | Where the shodh server lives. Set to a remote URL to share memories across machines/teams. |
| `SHODH_API_KEY` | `sk-shodh-dev-local-testing-key` | API key. The default is fine for local use; replace for shared/remote setups. |
| `SHODH_USER_ID` | _(per-project, derived from cwd)_ | Memory namespace. By default each project gets its own (e.g. `pi-szakdoga-5aa80885`); set this to share memories across projects or with teammates. |
| `SHODH_DATA_PATH` | `~/.cache/shodh-memory/data` | RocksDB storage. Persists across sessions/restarts. |
| `SHODH_SPAWN` | `1` | Set to `0` to *not* spawn the bundled binary (e.g. you've started shodh manually or in Docker). |
| `SHODH_QUIET` | `0` | Set to `1` to suppress shodh stdout/stderr in pi's status area. |
| `SHODH_BINARY_DIR` | _(auto)_ | Override the binaries directory. Almost never needed. |
| `ORT_DYLIB_PATH` | _(auto)_ | We set this automatically to our bundled ONNX runtime. Override only if you know what you're doing. |

### Sharing memories with team

Run shodh on a server, point everyone's pi at it:

```bash
export SHODH_API_URL=https://shodh.your-team.com
export SHODH_API_KEY=sk-team-key-…
export SHODH_USER_ID=alice            # or shared id for full team memory
export SHODH_SPAWN=0                  # don't try to spawn locally
```

### Per-project memory (default behaviour)

Every project automatically gets its own namespace. The userId is derived from the project's absolute path:

```
/home/you/projects/auth-service  ->  pi-auth-service-3f2a1c4d
/home/you/projects/website       ->  pi-website-9b2e4a8f
```

Format: `pi-<basename>-<8charHash>`. The basename gives at-a-glance recognition; the 8-char SHA-256 prefix of the absolute path disambiguates collisions (e.g. two `~/projects/api` directories under different parents).

All projects share the same shodh server and the same RocksDB — but recall is naturally scoped: when pi is in project A, queries hit project A's userId; in project B, they hit B's. No port conflicts, no per-project processes.

### Sharing memory across projects (override)

Set `SHODH_USER_ID` explicitly to opt out of per-project isolation:

```bash
# All projects share one global brain
export SHODH_USER_ID=pi

# Or share between specific projects only
cd ~/projects/auth-service && SHODH_USER_ID=pi-team-services pi
cd ~/projects/users-service && SHODH_USER_ID=pi-team-services pi
```

When `SHODH_USER_ID` is set in the environment, the per-project derivation is skipped entirely — user override always wins.

---

## Commands

| Slash command | What it does |
|---|---|
| `/shodh-status` | Show whether the server is online and the URL |

More may be added — see [Developer guide](#developer-guide) for how.

---

## Troubleshooting

### `/shodh-status` says **offline**

Check, in order:

1. **Did the binary install?**
   ```bash
   ls /path/to/pi-shodh/binaries/$(node -p 'process.platform + "-" + process.arch')/
   ```
   You should see `shodh-memory`, `shodh`, `shodh-memory-server`, `libonnxruntime.so` (or `.dylib`/`.dll`).

   If empty, run manually:
   ```bash
   cd /path/to/pi-shodh
   npm run fetch-binaries -- --only $(node -p 'process.platform + "-" + process.arch')
   ```

2. **Is something else on port 3030?**
   ```bash
   curl -sf http://127.0.0.1:3030/health && echo OK || echo "nothing there"
   lsof -i :3030
   ```

3. **Did the binary panic on startup?** Restart pi with `SHODH_QUIET=0` to see the server's logs in stderr.

### `Memory unavailable (shodh server not running)` from `shodh_remember`

Same root cause. The tool guards on `server.isReady()`, which is set after the spawn + health-check completes during `session_start`. If you see this:

- The pi session was started **before** the extension was installed — restart pi in the project where pi-shodh is installed
- OR the binary failed to launch — see the section above
- OR `SHODH_SPAWN=0` is set but no external server is reachable

### Stale ONNX runtime cache

Older shodh installs leave a stub `~/.cache/shodh-memory/onnxruntime/libonnxruntime.so` that newer shodh binaries panic on. pi-shodh works around this by setting `ORT_DYLIB_PATH` to our bundled runtime, but if you previously ran shodh some other way and see *OrtGetApiBase not present* errors:

```bash
rm -rf ~/.cache/shodh-memory/onnxruntime
```

### Binary install doesn't run on `pi install`

Try `--ignore-scripts` was used somewhere, or your network blocks GitHub releases. Fix:

```bash
cd /path/to/pi-shodh
npm run fetch-binaries     # downloads ALL platforms (~365 MB total)
# or
npm run fetch-binaries -- --only linux-x64
```

---

## Developer guide

### File map

```
extensions/
├── index.ts            # Factory function — wires everything together
├── shodh-server.ts     # Binary lifecycle + typed REST client class
├── types.ts            # Shared interfaces (memory shapes, request/response)
├── system-prompt.ts    # The "store on surprise" directive injected per-turn
├── hooks.ts            # All pi event handlers (session_start, before_agent_start, tool_result, message_end, session_shutdown)
└── tools/
    ├── remember.ts     # shodh_remember tool definition
    └── recall.ts       # shodh_recall tool definition

scripts/
├── fetch-binaries.mjs  # Download shodh binaries (maintainer + user fallback)
└── fix-permissions.cjs # chmod +x on bundled binaries (postinstall)

binaries/               # Populated by fetch-binaries.mjs (gitignored)
└── <platform>-<arch>/
    ├── shodh-memory             # bash wrapper (sets LD_LIBRARY_PATH)
    ├── shodh                    # the real Rust binary
    ├── shodh-memory-server      # secondary binary
    ├── shodh-tui                # tui dashboard
    └── libonnxruntime.so        # required shared library
```

### Adding a new memory tool

E.g. a `shodh_forget` tool that deletes memories by ID:

1. Create `extensions/tools/forget.ts` following the pattern in `recall.ts`:

   ```typescript
   import { Type, type Static } from "typebox";
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
   import type { ShodhServer } from "../shodh-server.ts";

   const ForgetParams = Type.Object({
     memory_id: Type.String({ description: "ID returned by shodh_remember" }),
   });

   export function registerForgetTool(pi: ExtensionAPI, server: ShodhServer): void {
     pi.registerTool({
       name: "shodh_forget",
       label: "Forget",
       description: "Delete a memory by ID",
       parameters: ForgetParams,
       async execute(_id, params, signal) {
         if (!server.isReady()) {
           return { content: [{ type: "text", text: "Memory unavailable" }], details: {} };
         }
         // call your endpoint
         // return { content: [{ type: "text", text: "Forgot ..." }], details: {} };
       },
     });
   }
   ```

2. Wire it in `extensions/index.ts`:

   ```typescript
   import { registerForgetTool } from "./tools/forget.ts";
   // ...
   registerForgetTool(pi, server);
   ```

3. Restart pi or use `/reload`.

### Adding a new REST endpoint to the client

`shodh-server.ts` only exposes the endpoints we use. To add e.g. `/api/forget`:

```typescript
// in extensions/types.ts
export interface ForgetRequest { user_id: string; memory_id: string; }
export interface ForgetResponse { success: boolean; }

// in extensions/shodh-server.ts, on ShodhServer class
async forget(req: ForgetRequest, signal?: AbortSignal): Promise<ForgetResponse | null> {
  return this.post<ForgetResponse>("/api/forget", req, signal);
}
```

The full shodh REST surface is documented at [varun29ankuS/shodh-memory/openapi.yaml](https://github.com/varun29ankuS/shodh-memory/blob/main/openapi.yaml).

### Adding a new hook

E.g. log every user prompt as a `Conversation` memory:

```typescript
// in extensions/hooks.ts, inside installHooks()
pi.on("input", async (event, ctx) => {
  if (!server.isReady()) return;
  if (event.source !== "interactive") return;
  await server.remember({
    user_id: server.config.userId,
    content: event.text.slice(0, 500),
    memory_type: "Conversation",
    tags: ["user-prompt"],
    importance: 0.25,
  }, ctx.signal);
});
```

Pi event reference: [extensions.md](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md).

### Tweaking the surprise directive

`extensions/system-prompt.ts` exports a single string `SURPRISE_DIRECTIVE`. Change it to:

- Add domain-specific tagging hints ("for Rust projects, prefer the `rust:` tag prefix")
- Encourage/discourage particular `memory_type` values
- Adjust verbosity ("store one-sentence summaries; never paste code")

The text gets appended to whatever pi already built for the system prompt. Keep it short — every byte costs context.

### Running the bundling for development

After editing extension code, no rebuild needed (jiti loads `.ts` directly). After editing `package.json`'s `files` or `scripts`, run:

```bash
npm pack --dry-run    # see what would ship in the npm tarball
```

To re-fetch all binaries (if shodh releases a new version):

```bash
# In package.json change DEFAULT_TAG in scripts/fetch-binaries.mjs, or:
npm run fetch-binaries -- --tag latest
```

### Testing without bothering the LLM

A standalone integration test:

```javascript
import { ShodhServer } from "./extensions/shodh-server.ts";

const server = new ShodhServer({ baseUrl: "http://127.0.0.1:33310" });
await server.start();
const r = await server.remember({
  user_id: "test", content: "hello", memory_type: "Observation",
});
console.log(r);
const recall = await server.recall({ user_id: "test", query: "hello" });
console.log(recall);
await server.stop();
```

Run with `node --import @mariozechner/jiti/register your-test.mjs`.

### Removing pi-shodh

```bash
pi remove /path/to/pi-shodh             # global
pi remove -l /path/to/pi-shodh          # project
```

To wipe stored memories:

```bash
rm -rf ~/.cache/shodh-memory/data
```

---

## Theoretical background

The "store on surprise" directive isn't just a heuristic — it's grounded in three converging lines of work:

1. **SuRe: Surprise-prioritised Replay** (Fountas et al., [arXiv:2511.22367](https://arxiv.org/abs/2511.22367), Nov 2025)
   Formalises memory selection in continual LLM learning as ranking by per-token Negative Log-Likelihood. The most surprising sequences are what's worth replaying. We approximate this in tool-using agents by asking the model to self-rate whether new information violated its expectations.

2. **Memory is the residual of surprise** ([brgsk.xyz](https://brgsk.xyz/memory-residual-of-surprise/))
   Applies Friston's free-energy principle: don't store what your world model predicted; store the prediction errors. The essay critiques the "store everything → vector-search later" pattern as fundamentally ungrounded in how memory works.

3. **Nemori: predict-then-calibrate** ([arXiv:2508.03341](https://arxiv.org/abs/2508.03341))
   Before extracting knowledge from an episode, predict what it should contain given existing memory. Store only the gap. We don't run a second LLM call to do this — we delegate the prediction to the same model in-context, via the system-prompt directive.

The shodh backend itself adds the *physiological* layer on top of this:

- **Hebbian learning** — connections used together strengthen
- **Activation decay** — unused memories fade
- **Spreading activation** — recalling one thing surfaces related things
- **Three-tier storage** — working / session / long-term, with importance-driven promotion

So pi-shodh is two ideas stacked: at the model layer, "store the surprise"; at the storage layer, "let usage shape recall".

---

## License

Apache-2.0, matching shodh-memory upstream. See [LICENSE](LICENSE) (TODO).
