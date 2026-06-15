import { prisma } from "@/lib/prisma";
import { sendInterviewLink } from "./send";

// Per-role delivery policy stored at Requisition.config.interview.trigger.
// Default MANUAL (drag does nothing extra) so a recruiter merely organizing the
// board never accidentally fires a link; a team opts into ON_INTERVIEW_STAGE.
// See docs/interview-flow.md §6 (trigger A).
export type InterviewTriggerPolicy = "MANUAL" | "ON_INTERVIEW_STAGE";

function resolveTrigger(requisitionConfigRaw: string | null | undefined): InterviewTriggerPolicy {
  if (!requisitionConfigRaw) return "MANUAL";
  try {
    const t = JSON.parse(requisitionConfigRaw)?.interview?.trigger;
    return t === "ON_INTERVIEW_STAGE" ? "ON_INTERVIEW_STAGE" : "MANUAL";
  } catch {
    return "MANUAL";
  }
}

/**
 * Trigger A — auto-send the interview link when a candidate enters the INTERVIEW
 * stage, IF the role opted in (config.interview.trigger === "ON_INTERVIEW_STAGE").
 *
 * Called fire-and-forget by applyStageTransition AFTER the pauseActive
 * transaction commits — never inside it (the Unipile send is a network call; the
 * stage move must not depend on it). A missing template or a send failure is
 * logged, never thrown: the drag has already succeeded and the recruiter's stage
 * intent is honored regardless (docs/interview-flow.md §6).
 */
export async function maybeAutoSendInterviewOnStage(taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { job: { select: { requisition: { select: { config: true } } } } },
  });

  if (resolveTrigger(task?.job?.requisition?.config) !== "ON_INTERVIEW_STAGE") return;

  const result = await sendInterviewLink({ taskId, allowResend: false, source: "STAGE_TRIGGER" });

  if (!result.ok) {
    console.warn(`[interview/auto-send] taskId=${taskId} not sent (${result.code}): ${result.error}`);
  } else if (result.alreadySent) {
    console.log(`[interview/auto-send] taskId=${taskId} skipped — already sent/in progress`);
  } else if (result.noChannel) {
    console.log(`[interview/auto-send] taskId=${taskId} → LINK_ONLY (no open channel; recruiter can copy the link)`);
  }
}
