// EZ Trucking — model config. One switch, two brains, and an explicit allowlist.
// Plan A (default): Ollama, local, free. Plan B/C: flip one env var to Anthropic. See 10-CAPACITY-AND-DEPLOY-PLAN.md.
//
// Andrew's ask, 2026-09-04: your Ollama store on this PC has a lot of other models in it —
// some assigned real jobs (qwen3:14b, the local QA model per Grok's agent brief), most with no
// job at all, and four (`ALIENTELLIGENCE/businessadministrator`, `innovategy/voicehero`,
// `nudnikwiz/RoxyLive`, `valkyriesys/eudaimonia-dryad3-vision`) that are unreviewed third-party
// community pulls — rule 30 says nothing unreviewed gets used. You asked to wall them off in
// their own folder so they can't do anything the project doesn't know about.
//
// A model file sitting in ~/.ollama/models isn't running code — it's inert weights. Nothing
// happens with it until something asks Ollama to load it by name. So the actual wall isn't a
// folder on disk (Ollama doesn't cleanly support split model stores without running a second
// daemon — real complexity, and not something to touch while a download is mid-pull in that
// same directory right now). The real wall is here: every model name this app can ever ask for
// is a literal string in this file, checked against ALLOWED_MODELS below before use. There is no
// code path anywhere in agents/ that builds a model name from a variable, an env var, or model
// output — so the four unreviewed community models, and everything else in your Ollama store,
// are structurally unreachable from this project, regardless of what's sitting next to them on
// disk. This assertion is the belt-and-suspenders proof of that, not just a comment claiming it.

export type Lane = "fast" | "money";

interface LaneConfig {
  baseURL: string;
  authToken: string; // Ollama ignores the value; Anthropic needs a real key
  model: string;
}

// The only model identifiers this codebase is allowed to ask Ollama or Anthropic for. Anything
// not in this set — including every one of the "other" models on Andrew's machine — is refused.
const ALLOWED_MODELS = new Set([
  "qwen3.5:4b", // FAST lane, Plan A
  "qwen3.5:9b", // MONEY lane, Plan A
  "qwen3:14b", // local QA model only (Grok's agent brief) — never used by the app's runtime lanes
  "claude-haiku-4-5", // FAST lane, Plan B/C
  "claude-sonnet-5", // MONEY lane, Plan B/C
]);

function assertAllowedModel(model: string): string {
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error(
      `models.ts: "${model}" is not in ALLOWED_MODELS. Every model this app can call is a literal ` +
        `in this file — if you're trying to add one, add it here first, on purpose, not by editing ` +
        `around this check.`
    );
  }
  return model;
}

const usingOllama = !process.env["EZ_FORCE_CLOUD"]; // Plan A is the default; set EZ_FORCE_CLOUD=1 for Plan C

function laneConfig(lane: Lane): LaneConfig {
  if (usingOllama) {
    return {
      baseURL: "http://localhost:11434",
      authToken: "ollama",
      model: assertAllowedModel(lane === "fast" ? "qwen3.5:4b" : "qwen3.5:9b"),
    };
  }
  // Plan B/C — Anthropic. small=Haiku for FAST, strong=Sonnet for MONEY (06-AGENT-REGISTRY §"Which model?").
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("EZ_FORCE_CLOUD is set but ANTHROPIC_API_KEY is missing.");
  return {
    baseURL: "https://api.anthropic.com",
    authToken: apiKey,
    model: assertAllowedModel(lane === "fast" ? "claude-haiku-4-5" : "claude-sonnet-5"),
  };
}

export const FAST = laneConfig("fast");
export const MONEY = laneConfig("money");

// Local QA config (Grok's agent brief, reconciled 2026-09-03): runs on Andrew's PC only, to grade
// Claude Code's own work during development. Never imported by guardrails.ts, never reachable
// from a driver-facing skill — it's a separate export specifically so nothing in the app's
// runtime path can pick it up by accident.
export const QA_ONLY: LaneConfig = {
  baseURL: "http://localhost:11434",
  authToken: "ollama",
  model: assertAllowedModel("qwen3:14b"),
};

// Plan B failover (EZ-104, not wired yet): a health check pings localhost:11434 every
// minute; if it's unreachable for 3+ minutes, this flips usingOllama's effective value
// to false at request time instead of requiring a restart. Left as a TODO here on
// purpose — build it right before the first non-family paying driver, not before.
