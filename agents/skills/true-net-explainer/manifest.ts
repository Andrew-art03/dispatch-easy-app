import { defineManifest } from "../../secrets.ts";

/**
 * Explains a True Net score in plain language. Rule 14: it may explain a score, it may never change one — the math is deterministic TypeScript (rule 2).
 *
 * secrets: [] — and that is the truth, not a placeholder. This skill reaches the
 * model through `agents/models.ts`, which owns ANTHROPIC_API_KEY; the key is
 * never handed to the skill. An empty allowlist means any `readSecret` call from
 * here trips the kill switch (rule 41), which is exactly what we want today.
 *
 * When this skill genuinely needs a credential, adding the name here is a
 * reviewable one-line diff. That visibility is the control.
 */
export const TRUE_NET_EXPLAINER = defineManifest({
  name: "true-net-explainer",
  secrets: [],
});
