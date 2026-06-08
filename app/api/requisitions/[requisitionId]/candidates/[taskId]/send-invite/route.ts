import { NextRequest, NextResponse } from "next/server";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { sendLinkedInInviteForTask } from "@/lib/outreach/send-linkedin-invite";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  try {
    const { requisitionId: rawReqId, taskId } = await params;
    const requisitionId = await resolveRequisitionId(rawReqId);

    const result = await sendLinkedInInviteForTask(taskId, requisitionId);

    if (result.ok) {
      return NextResponse.json({ ok: true, invitationId: result.invitationId });
    }

    // Map the shared result kinds to the HTTP statuses this endpoint has
    // always returned.
    let status: number;
    switch (result.kind) {
      case "not_found": status = 404; break;
      case "wrong_stage": status = 409; break;
      case "no_provider_id": status = 422; break;
      case "no_channel":
      case "no_account": status = 400; break;
      case "send_failed":
        status = result.statusCode && result.statusCode < 500 ? result.statusCode : 500;
        break;
      default: status = 500;
    }
    return NextResponse.json({ error: result.message }, { status });
  } catch (error: any) {
    console.error("[send-invite] failed:", error);
    const message = error?.message || "Internal server error";
    const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
