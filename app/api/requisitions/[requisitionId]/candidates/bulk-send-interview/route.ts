import { NextRequest, NextResponse } from "next/server";
import { ChannelType } from "@prisma/client";
import { sendInterviewLink } from "@/lib/interview/send";

export const dynamic = "force-dynamic";

const MAX_BULK_SIZE = 500;
const VALID_CHANNELS = new Set<ChannelType>([ChannelType.LINKEDIN, ChannelType.EMAIL, ChannelType.WHATSAPP]);

// Trigger E — bulk execute. Sends the interview link to each candidate on their
// auto-picked channel, or on `channel` if the recruiter forced one (candidates
// lacking it are skipped + flagged, never silently dropped). Processed
// sequentially (mirrors bulk-stage) so one bad candidate can't exhaust the pool;
// per-task outcomes let the UI show exactly what sent / skipped / failed.
// Body: { taskIds: string[], channel?: ChannelType }
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const taskIds: unknown = raw.taskIds;
    const forced: ChannelType | undefined =
      raw.channel && VALID_CHANNELS.has(raw.channel) ? raw.channel : undefined;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
    }
    if (taskIds.length > MAX_BULK_SIZE) {
      return NextResponse.json({ error: `taskIds limit is ${MAX_BULK_SIZE}` }, { status: 400 });
    }
    if (!taskIds.every((id) => typeof id === "string" && id.length > 0)) {
      return NextResponse.json({ error: "taskIds must be non-empty strings" }, { status: 400 });
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const outcomes: Array<Record<string, unknown>> = [];

    for (const taskId of taskIds as string[]) {
      const r = await sendInterviewLink({ taskId, channelType: forced, allowResend: false, source: "BULK" });

      if (r.ok) {
        if (r.alreadySent) {
          skipped += 1;
          outcomes.push({ taskId, ok: true, skipped: true, reason: "already_sent" });
        } else if (r.noChannel) {
          skipped += 1;
          outcomes.push({ taskId, ok: true, skipped: true, reason: "no_channel", link: r.link });
        } else {
          sent += 1;
          outcomes.push({ taskId, ok: true, channelType: r.channelType, sentVia: r.sentVia });
        }
      } else if (r.code === "CHANNEL_NOT_SENDABLE") {
        // Forced-channel skip — flagged, not an error.
        skipped += 1;
        outcomes.push({ taskId, ok: false, skipped: true, code: r.code, error: r.error });
      } else {
        failed += 1;
        outcomes.push({ taskId, ok: false, code: r.code, error: r.error });
      }
    }

    return NextResponse.json({ sent, skipped, failed, outcomes });
  } catch (err) {
    console.error("[bulk-send-interview]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
