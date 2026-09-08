import { defineManifest } from "../../secrets.ts";

/**
 * Drafts a message to a broker. Rule 21: a human taps before anything a broker could read as a bid; this skill never sends.
 *
 * secrets: [] — and that is the truth, not a placeholder. This skill reaches the
 * model through `agents/models.ts`, which owns ANTHROPIC_API_KEY; the key is
 * never handed to the skill. An empty allowlist means any `readSecret` call from
 * here trips the kill switch (rule 41), which is exactly what we want today.
 *
 * When this skill genuinely needs a credential, adding the name here is a
 * reviewable one-line diff. That visibility is the control.
 */
export const BROKER_DRAFT = defineManifest({
  name: "broker-draft",
  secrets: [],
});
