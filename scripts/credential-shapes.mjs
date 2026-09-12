// Shared credential detection for the two EZ-002 safety rails:
//   assert-no-secret-source.mjs  -- tracked source, BEFORE a build (check:env)
//   assert-no-service-role.mjs   -- build output, AFTER a build (check:bundle)
//
// These live together on purpose. When the two rails carried their own copies of
// these patterns, tightening one silently left the other loose -- which is the
// failure mode a rail is supposed to prevent, not reproduce.

// A file is binary if it carries a NUL in its first 8 KiB. readFileSync(p,"utf8")
// does NOT throw on binary input -- it happily returns replacement characters --
// so an exception was never the right way to skip images and fonts.
export const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

// PER-LINE EXEMPTION -- the `secret-rail:allow` pragma (rewritten in P-1C-4).
//
// The pragma is honoured ONLY as a standalone comment line, and it exempts ONLY
// the single line that follows it. It is never a same-line substring. Before
// P-1C-4 any line merely CONTAINING the text was dropped from the scan, so a real
// credential on a line that also said `secret-rail:allow` passed check:env --
// the exemption mechanism was itself a bypass. Now the pragma has to sit on its
// own line, which makes every exemption a visible, greppable diff line with a
// reason after it, and a credential can never hide behind it on the same line.
//
// Both the pragma line and the exempted line are replaced by EMPTY lines rather
// than removed, so line numbers in any later report still match the file.
export const ALLOW_PRAGMA = /^\s*(?:\/\/|#|\/\*|\*)\s*secret-rail:allow\b/;

export const stripExemptLines = (text) => {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ALLOW_PRAGMA.test(lines[i])) {
      out.push("");          // the pragma line itself
      if (i + 1 < lines.length) {
        out.push("");        // exactly one following line
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
};

const isServiceRoleJwt = (jwt) => {
  const payload = jwt.split(".")[1];
  if (!payload) return false;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json).role === "service_role";
  } catch {
    return false;
  }
};

// WHY THESE MATCH VALUES, NOT WORDS.
// A first version banned the literal strings "service_role"/"sb_secret". It fired on
// five files -- all of them Supabase SDK code, e.g. the client's own key-type detector
// `e.startsWith("sb_publishable_") || e.startsWith("sb_secret_")`. Zero real keys. A
// rail that cries wolf gets switched off, so these match credential SHAPES.
//
// NOT flagged, deliberately: the anon/publishable key. VITE_* values are inlined into
// the browser bundle by design and tenant isolation rests on RLS, not on hiding it.
// service_role bypasses RLS entirely, which is why only it is a stop condition.
export const findCredentialValues = (text) => {
  const hits = [];

  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) hits.push("sb_secret_ key value");

  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
    if (isServiceRoleJwt(jwt)) {
      hits.push("JWT with role=service_role");
      break;
    }
  }

  if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'`]?[^"'`\s]{8,}/.test(text))
    hits.push("SUPABASE_SERVICE_ROLE_KEY assigned a literal");

  return hits;
};

// Source-only rule. Anything named VITE_* is inlined into the browser bundle by
// Vite, so a VITE_ name containing SERVICE / SECRET / ROLE is a contradiction in
// terms: it is either mis-named or it is a real secret about to be published.
// Caught here by NAME, before a build exists for check:bundle to scan.
//
// ANY OCCURRENCE, not just an assignment. The first cut required a trailing "=",
// secret-rail:allow  next line quotes a detected NAME as a documentation example
// which caught `VITE_X_SECRET=v` in a .env file but sailed straight past
// secret-rail:allow  next line quotes a detected NAME as a documentation example
// `import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY` in a .ts file -- source READS
// these names, it does not assign them, so the assignment form missed the very
// case this rail exists for. Found by planting that exact line before trusting it.
export const findPublishedSecretNames = (text) => {
  const hits = [];
  for (const m of text.match(/\bVITE_[A-Z0-9_]*(?:SERVICE|SECRET|ROLE)[A-Z0-9_]*\b/g) ?? []) {
    hits.push(`${m} — a VITE_ name is published to the browser`);
  }
  return [...new Set(hits)];
};
