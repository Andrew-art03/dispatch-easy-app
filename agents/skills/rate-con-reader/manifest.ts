import { defineManifest } from "../../secrets.ts";

/**
 * Extracts fields from a rate confirmation. Output is validated against a schema (rule 3); nothing extracted can trigger an action.
 *
 * secrets: [] — and that is the truth, not a placeholder. This skill reaches the
 * model through `agents/models.ts`, which owns ANTHROPIC_API_KEY; the key is
 * never handed to the skill. An empty allowlist means any `readSecret` call from
 * here trips the kill switch (rule 41), which is exactly what we want today.
 *
 * When this skill genuinely needs a credential, adding the name here is a
 * reviewable one-line diff. That visibility is the control.
 */
export const RATE_CON_READER = defineManifest({
  name: "rate-con-reader",
  secrets: [],
});
