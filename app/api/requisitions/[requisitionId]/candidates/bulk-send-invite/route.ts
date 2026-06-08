// ─── Bulk send LinkedIn invite ───────────────────────────────────────────────
//
// Recruiter selects N SHORTLISTED candidates and clicks "Send LinkedIn invite".
// For each we run the shared sendLinkedInInviteForTask — sends the connection
// request via Unipile, advances stage → CONTACT_REQUESTED, and creates the
// ChannelThread (INVITE_PENDING) + first ThreadMessage. Non-SHORTLISTED tasks
// are skipped (reported, not failed).
//
// Each task is an external LinkedIn API call, so we process SEQUENTIALLY (never
// in parallel — a burst of concurrent invites risks the account) and cap the
// batch low. NOTE: this does NOT enforce the channel's daily cap — it sends to
// everything selected. Keep batches within your LinkedIn daily limits; for
// hands-off, cap-respecting sending use "Fan out to channels" + the worker.
//
// Body:    { taskIds: string[] }
// Response (always 200): { sent, skipped, failed, outcomes:[{taskId, ok, ...}] }

import { NextRequest, NextResponse } from "next/server";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { sendLinkedInInviteForTask } from "@/lib/outreach/send-linkedin-invite";

export const dynamic = "force-dynamic";

const MAX_BULK_SIZE = 50; // external API calls — keep batches small

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> },
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);

    const body = (await req.json()) as { taskIds?: unknown };
    const { taskIds } = body;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
    }
    if (taskIds.length > MAX_BULK_SIZE) {
      return NextResponse.json(
        { error: `taskIds limit is ${MAX_BULK_SIZE} (external LinkedIn calls); got ${taskIds.length}` },
        { status: 400 },
      );
    }
    if (!taskIds.every(id => typeof id === "string" && id.length > 0)) {
      return NextResponse.json({ error: "taskIds must be an array of non-empty strings" }, { status: 400 });
    }

    // Sequential — never fire concurrent LinkedIn invites from one account.
    let sent = 0;
    const outcomes: Array<Record<string, unknown>> = [];
    for (const taskId of taskIds as string[]) {
      const r = await sendLinkedInInviteForTask(taskId, requisitionId);
      if (r.ok) {
        sent++;
        outcomes.push({ taskId, ok: true, invitationId: r.invitationId, threadCreated: r.threadCreated });
      } else {
        outcomes.push({ taskId, ok: false, kind: r.kind, error: r.message });
      }
    }

    const skipped = outcomes.filter(o => o.kind === "wrong_stage" || o.kind === "not_found").length;
    const failed = outcomes.length - sent - skipped;
    return NextResponse.json({ sent, skipped, failed, outcomes });
  } catch (err) {
    console.error("[bulk-send-invite] failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
