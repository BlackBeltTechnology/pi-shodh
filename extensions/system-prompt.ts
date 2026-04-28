/**
 * Surprise-driven memory directive injected into the system prompt.
 *
 * Theoretical basis (loaded via web research, not training):
 *
 *   1. SuRe (Fountas et al., 2511.22367, Nov 2025) — "Surprise-prioritised
 *      Replay" formalises memory selection as ranking by per-token
 *      Negative Log-Likelihood. The most surprising sequences are the
 *      ones worth replaying / consolidating.
 *
 *   2. "Memory is the residual of surprise" (brgsk.xyz) — applies
 *      Friston's free-energy principle to agent memory: don't store
 *      what your world model predicted; store the prediction errors.
 *
 *   3. Nemori (arXiv:2508.03341) — predict-then-calibrate: compare each
 *      episode against a prediction from existing knowledge, store only
 *      the gap.
 *
 * The directive below tells the model to call `shodh_remember` *only*
 * when it would have failed to predict the new fact. Skip confirmations,
 * predictable updates, and routine acknowledgments. This is the cheapest
 * possible approximation of SuRe in a tool-using-agent setting: instead
 * of computing NLL across stored sequences, the model self-rates whether
 * an utterance was surprising relative to its current context.
 */

export const SURPRISE_DIRECTIVE = `
## Memory: store only what surprised you

This session is connected to a persistent memory store via the \`shodh_remember\` and \`shodh_recall\` tools. Past memories may already be surfaced as <shodh-memory>...</shodh-memory> blocks in your context — use them.

**When to call \`shodh_remember\`:** after each user turn, briefly check whether anything in the new information would have *failed your prediction* — contradicted prior context, revealed a non-obvious preference, exposed a constraint you didn't have, or violated an assumption you were operating on. If yes, store it. The right memory_type:
  - \`Decision\`  — the user/you chose an approach, picked a tool, set a constraint
  - \`Discovery\` — a non-obvious fact about the codebase, system, or domain
  - \`Learning\`  — a generalisable lesson (next time X, do Y)
  - \`Error\`     — something that failed and the cause
  - \`Pattern\`   — a recurring behaviour or convention worth remembering

**When NOT to call it:**
  - The user confirmed something you already inferred
  - You're echoing back what was just said
  - The fact is recoverable by reading a file (store the *insight*, not the file contents)
  - It's a transient detail (line numbers, exact timestamps, ephemeral state)

**The rule:** memory is the residual of surprise. If your prior model already covered it, skip the tool call. If you'd have predicted differently, store it — concisely, in one sentence — with the right type and 2-4 tags.

You may also call \`shodh_recall\` at any time to search past memories before answering. Prefer recall when the user references something from "before", "last time", or "we agreed" — search first, then answer.
`.trim();
