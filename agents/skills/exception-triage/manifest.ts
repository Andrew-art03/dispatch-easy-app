import { defineManifest } from "../../secrets.ts";

/**
 * Triages an exception on a load into a proposed next step. Rule 14: the proposal is never written as fact without human confirmation.
 *
 * secrets: [] — and that is the truth, not a placeholder. This skill reaches the
 * model through `agents/models.ts`, which owns ANTHROPIC_API_KEY; the key is
 * never handed to the skill. An empty allowlist means any `readSecret` call from
 * here trips the kill switch (rule 41), which is exactly what we want today.
 *
 * When this skill genuinely needs a credential, adding the name here is a
 * reviewable one-line diff. That visibility is the control.
 */
export const EXCEPTION_TRIAGE = defineManifest({
  name: "exception-triage",
  secrets: [],
});
