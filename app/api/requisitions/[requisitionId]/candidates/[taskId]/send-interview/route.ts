import { NextRequest, NextResponse } from "next/server";
import { ChannelType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBaseUrl } from "@/lib/trigger";
import { getOrCreateOpenInterviewSession } from "@/lib/interview/session";
import { pickInterviewChannel, toPublicChannel } from "@/lib/interview/channel";
import { renderInterviewMessage, safeParseJson } from "@/lib/interview/render";
import { sendInterviewLink } from "@/lib/interview/send";

export const dynamic = "force-dynamic";

// Trigger B — manual "Send Interview". GET returns everything the composer needs
// (auto-picked channel pre-selected, the per-channel sendable breakdown, and the
// rendered message text the recruiter can edit); POST performs the send.
// See docs/interview-flow.md §6.

// GET → composer preview. Reuses-or-creates the open session so it can show the
// real /interview/<accessToken> link inside the rendered text.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  const { taskId } = await params;
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        deletedAt: true,
        candidateName: true,
        result: true,
        analysisResult: true,
        job: { select: { requisition: { select: { config: true } } } },
      },
    });
    if (!task || task.deletedAt) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    const { session } = await getOrCreateOpenInterviewSession(taskId);
    const link = `${getBaseUrl()}/interview/${session.accessToken}`;

    const { picked, candidates } = await pickInterviewChannel(taskId);
    const forChannel = picked?.channelType ?? null;

    // Render with forChannel: "EMAIL" so the composer always has a subject ready
    // if the recruiter switches to Email; the body is channel-agnostic.
    // linkAsToken: keep {{interviewLink}} as a visible token in the editor — the
    // real link is substituted at send time. The recruiter sees the candidate's
    // name etc. filled in, with a clear placeholder for where the link lands.
    const { subject, body, hasLinkVar } = await renderInterviewMessage({
      requisitionConfigRaw: task.job?.requisition?.config ?? null,
      profile: safeParseJson(task.result),
      analysis: safeParseJson(task.analysisResult),
      link,
      forChannel: "EMAIL",
      linkAsToken: true,
    });

    return NextResponse.json({
      candidateName: task.candidateName,
      link,
      sessionId: session.id,
      status: session.status,
      sentVia: session.sentVia,
      // Already delivered / mid-interview → the composer shows a "resend?" confirm.
      alreadySent: session.status === "SENT" || session.status === "IN_PROGRESS",
      picked: forChannel, // null → LINK_ONLY (copy link)
      channels: candidates.map(toPublicChannel),
      subject,
      body,
      hasLinkVar,
    });
  } catch (err) {
    console.error("[send-interview GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const VALID_CHANNELS = new Set<ChannelType>([ChannelType.LINKEDIN, ChannelType.EMAIL, ChannelType.WHATSAPP]);

// POST → deliver. Body: { channel?, text?, subject?, allowResend? }.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  const { taskId } = await params;
  try {
    const raw = await req.json().catch(() => ({}));
    const channel: ChannelType | undefined =
      raw.channel && VALID_CHANNELS.has(raw.channel) ? raw.channel : undefined;

    const result = await sendInterviewLink({
      taskId,
      channelType: channel,
      customText: typeof raw.text === "string" ? raw.text : undefined,
      customSubject: typeof raw.subject === "string" ? raw.subject : undefined,
      allowResend: raw.allowResend === true,
      source: "MANUAL",
    });

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND" ? 404 : result.code === "SEND_FAILED" ? 502 : 409;
      return NextResponse.json({ error: result.error, code: result.code, link: result.link }, { status });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[send-interview POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
