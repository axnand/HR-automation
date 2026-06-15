import { ChannelType } from "@prisma/client";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import {
  getEffectiveInterviewTemplate,
  templateHasLinkVar,
  DEFAULT_INTERVIEW_TEMPLATE,
} from "./templates";

/** Tolerant JSON.parse for the Task.result / analysisResult string columns. */
export function safeParseJson(raw: string | null | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export type RenderedInterviewMessage = {
  subject: string | null; // non-null only when forChannel === "EMAIL"
  body: string;
  hasLinkVar: boolean; // false → the effective template body lacks {{interviewLink}}
};

/**
 * Render the interview delivery message from the effective template (role →
 * global → default), substituting the candidate vars + the minted link. Shared
 * by the composer preview (trigger B) and the delivery primitive so what the
 * recruiter previews is exactly what gets sent.
 *
 * `linkAsToken: true` is the composer-preview mode: every var is resolved EXCEPT
 * {{interviewLink}}, which is preserved verbatim so the recruiter sees (and can
 * move) the link token. The real link is substituted at send time (send.ts).
 */
export async function renderInterviewMessage(params: {
  requisitionConfigRaw: string | null | undefined;
  profile: any;
  analysis: any;
  link: string;
  forChannel: ChannelType | null;
  linkAsToken?: boolean;
}): Promise<RenderedInterviewMessage> {
  const template = await getEffectiveInterviewTemplate(params.requisitionConfigRaw);
  const hasLinkVar = templateHasLinkVar(template);
  // In token mode, set interviewLink to the literal token so renderTemplate
  // replaces {{interviewLink}} with itself — i.e. leaves it intact for display.
  const interviewLink = params.linkAsToken ? "{{interviewLink}}" : params.link;
  const vars = { ...buildVars(params.profile ?? {}, params.analysis ?? {}), interviewLink };

  const body = renderTemplate(template.body, vars);

  let subject: string | null = null;
  if (params.forChannel === "EMAIL") {
    const subjTemplate = template.subject ?? DEFAULT_INTERVIEW_TEMPLATE.subject ?? "Interview invitation";
    subject = renderTemplate(subjTemplate, vars);
  }

  return { subject, body, hasLinkVar };
}
