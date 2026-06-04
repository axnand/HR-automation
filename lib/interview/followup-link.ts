import { getBaseUrl } from "@/lib/trigger";
import { getOrCreateOpenInterviewSession } from "./session";

const LINK_VAR_RE = /\{\{\s*interviewLink\s*\}\}/i;

/**
 * Trigger C — make {{interviewLink}} work inside scheduled followups run by the
 * worker (docs/interview-flow.md §6). If ANY template in this thread's channel
 * config uses the variable, reuse-or-create the candidate's interview session
 * and inject the minted /interview/<accessToken> link into `vars`, so the
 * worker renders a real link instead of an empty string.
 *
 * Cheap by default: a sync regex over the serialized config gates the async
 * mint, so threads whose templates don't use the link pay almost nothing. The
 * mint is advisory-locked + idempotent (getOrCreateOpenInterviewSession), so it
 * reuses one session/link across every followup. Mutates `vars.interviewLink`.
 *
 * Note: the session is left in its current state (PENDING) — it flips to
 * IN_PROGRESS when the candidate actually joins (the token route), which is what
 * Phase 4's transcript poll keys off. We intentionally don't optimistically mark
 * it SENT here, since the worker's downstream send can still fail/retry.
 */
export async function injectInterviewLinkForConfig(
  taskId: string,
  config: unknown,
  vars: { interviewLink: string },
): Promise<void> {
  if (vars.interviewLink) return; // already injected upstream

  let configStr: string;
  try {
    configStr = JSON.stringify(config ?? {});
  } catch {
    return;
  }
  if (!LINK_VAR_RE.test(configStr)) return;

  const { session } = await getOrCreateOpenInterviewSession(taskId);
  vars.interviewLink = `${getBaseUrl()}/interview/${session.accessToken}`;
}
