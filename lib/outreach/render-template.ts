export interface TemplateVars {
  name: string;
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  score: string;
  reason: string; // rejection/archive reason, empty string when not applicable
  // Phase 3 — the candidate interview URL. Empty for non-interview templates;
  // interview senders override it with the minted /interview/<accessToken> link.
  // See docs/interview-flow.md §6 (trigger C).
  interviewLink: string;
}

export function buildVars(profile: any, analysis: any): TemplateVars {
  const startTime = Date.now(); // Start time logging

  const fullName =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    analysis?.candidateInfo?.name ||
    profile?.extractedInfo?.name ||
    "there";

  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] ?? "there";
  const lastName = parts.slice(1).join(" ");

  const company =
    analysis?.candidateInfo?.currentOrg ||
    profile?.extractedInfo?.currentOrg ||
    "";

  const role =
    analysis?.candidateInfo?.currentDesignation ||
    profile?.extractedInfo?.currentDesignation ||
    profile?.headline ||
    "";

  const score =
    analysis?.scorePercent != null ? `${Math.round(analysis.scorePercent)}%` : "";

  const duration = Date.now() - startTime; // Calculate duration
  console.log(`buildVars processing took ${duration}ms`); // Log duration

  // interviewLink defaults to "" — only interview senders have a link to inject
  // (they spread { ...vars, interviewLink }). Non-interview templates never
  // contain {{interviewLink}}, so the empty default is a harmless no-op there.
  return { name: fullName, firstName, lastName, company, role, score, reason: "", interviewLink: "" };
}

// Maps common spaced/alternate spellings to their canonical camelCase key.
// Add new aliases here whenever a new variable is introduced in TemplateVars.
const VAR_ALIASES: Record<string, keyof TemplateVars> = {
  "first name": "firstName",
  "last name": "lastName",
  "full name": "name",
  "rejection reason": "reason",
  "archive reason": "reason",
  "interview link": "interviewLink",
  "interviewlink": "interviewLink",
};

/**
 * Normalises free-form variable tokens written by recruiters (e.g. "first name",
 * "First Name") to the canonical camelCase key used internally, so a typo in
 * spacing/casing never reaches a candidate unsubstituted.
 */
function normalizeTemplate(template: string): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw: string) => {
    const trimmed = raw.trim();
    const alias = VAR_ALIASES[trimmed.toLowerCase()];
    // Resolve alias OR at minimum strip surrounding whitespace so downstream
    // regexes (which don't allow spaces) can still match canonical names.
    return `{{${alias ?? trimmed}}}`;
  });
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  const normalized = normalizeTemplate(template);
  const rendered = normalized
    .replace(/\{\{name\}\}/gi, vars.name)
    .replace(/\{\{firstName\}\}/gi, vars.firstName)
    .replace(/\{\{lastName\}\}/gi, vars.lastName)
    .replace(/\{\{company\}\}/gi, vars.company)
    .replace(/\{\{role\}\}/gi, vars.role)
    .replace(/\{\{score\}\}/gi, vars.score)
    .replace(/\{\{reason\}\}/gi, vars.reason)
    .replace(/\{\{\s*interviewLink\s*\}\}/gi, vars.interviewLink ?? "");

  // Safety guard: any remaining {{...}} token is unknown — block the send
  // rather than deliver a literal placeholder to the candidate.
  const unreplaced = rendered.match(/\{\{[^}]+\}\}/g);
  if (unreplaced) {
    throw new Error(
      `renderTemplate: unreplaced variable(s) ${unreplaced.join(", ")} — fix the template before sending`
    );
  }

  return rendered;
}
