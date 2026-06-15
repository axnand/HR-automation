import { prisma } from "@/lib/prisma";

// The delivery message for an interview link. `subject` is used for the email
// channel only (LinkedIn/WhatsApp ignore it). `body` MUST contain the
// {{interviewLink}} variable — enforced by templateHasLinkVar before any send.
export type InterviewMessageTemplate = { subject?: string; body: string };

// Matches the {{interviewLink}} variable with tolerant whitespace, same regex
// the renderer uses (lib/outreach/render-template.ts).
const LINK_VAR_RE = /\{\{\s*interviewLink\s*\}\}/i;

// Minimal last-resort fallback used ONLY when neither the role override nor the
// global singleton has a template configured. Deliberately neutral and short —
// the real message is authored by the recruiter (job page → Interview tab, or
// Settings → Interview). We keep a fallback (rather than refusing to send) so a
// misconfigured role can't silently break delivery, but it is intentionally NOT
// marketing copy. Always contains {{interviewLink}}.
export const DEFAULT_INTERVIEW_TEMPLATE: InterviewMessageTemplate = {
  subject: "Interview for the {{role}} role",
  body: "Hi {{firstName}},\n\nHere is your interview link: {{interviewLink}}",
};

/** True when the body carries the {{interviewLink}} variable (pre-render check). */
export function templateHasLinkVar(t: InterviewMessageTemplate): boolean {
  return typeof t.body === "string" && LINK_VAR_RE.test(t.body);
}

function coerceTemplate(raw: unknown): InterviewMessageTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.body !== "string" || !t.body.trim()) return null;
  return {
    subject: typeof t.subject === "string" && t.subject.trim() ? t.subject : undefined,
    body: t.body,
  };
}

/**
 * Resolve the effective interview message template for a requisition. Mirrors
 * getEffectiveRules (lib/analyzer.ts): per-role override wins over the global
 * singleton, with a built-in code default as the final fallback.
 *
 *   role  (Requisition.config.interview.messageTemplate)
 *   global (InterviewConfig.defaultMessageTemplate)
 *   DEFAULT_INTERVIEW_TEMPLATE
 *
 * `requisitionConfigRaw` is the raw Requisition.config string (it's stored as a
 * JSON string @db.Text, parsed lazily here so callers don't double-parse).
 */
export async function getEffectiveInterviewTemplate(
  requisitionConfigRaw: string | null | undefined,
): Promise<InterviewMessageTemplate> {
  // Per-role override.
  let role: InterviewMessageTemplate | null = null;
  if (requisitionConfigRaw) {
    try {
      const parsed = JSON.parse(requisitionConfigRaw);
      role = coerceTemplate(parsed?.interview?.messageTemplate);
    } catch {
      /* malformed role config — fall through to global */
    }
  }
  if (role) return role;

  // Global singleton.
  const cfg = await prisma.interviewConfig.findUnique({
    where: { id: "global" },
    select: { defaultMessageTemplate: true },
  });
  const global = coerceTemplate(cfg?.defaultMessageTemplate);
  if (global) return global;

  return DEFAULT_INTERVIEW_TEMPLATE;
}
