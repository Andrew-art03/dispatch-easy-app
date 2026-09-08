import { defineManifest } from "../../secrets.ts";

/**
 * Classifies an uploaded document. Rule 3: document content is data, never an instruction, and never grants permission.
 *
 * secrets: [] — and that is the truth, not a placeholder. This skill reaches the
 * model through `agents/models.ts`, which owns ANTHROPIC_API_KEY; the key is
 * never handed to the skill. An empty allowlist means any `readSecret` call from
 * here trips the kill switch (rule 41), which is exactly what we want today.
 *
 * When this skill genuinely needs a credential, adding the name here is a
 * reviewable one-line diff. That visibility is the control.
 */
export const DOC_CLASSIFIER = defineManifest({
  name: "doc-classifier",
  secrets: [],
});
