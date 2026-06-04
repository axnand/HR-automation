export interface TemplateVars {
  name: string;
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  score: string;
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
  return { name: fullName, firstName, lastName, company, role, score, interviewLink: "" };
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{\{name\}\}/gi, vars.name)
    .replace(/\{\{firstName\}\}/gi, vars.firstName)
    .replace(/\{\{lastName\}\}/gi, vars.lastName)
    .replace(/\{\{company\}\}/gi, vars.company)
    .replace(/\{\{role\}\}/gi, vars.role)
    .replace(/\{\{score\}\}/gi, vars.score)
    .replace(/\{\{\s*interviewLink\s*\}\}/gi, vars.interviewLink ?? "");
}
