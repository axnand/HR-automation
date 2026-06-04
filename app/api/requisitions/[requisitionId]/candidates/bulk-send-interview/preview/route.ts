import { NextRequest, NextResponse } from "next/server";
import { ChannelType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { pickInterviewChannel } from "@/lib/interview/channel";

export const dynamic = "force-dynamic";

const MAX_BULK_SIZE = 500;
const VALID_CHANNELS = new Set<ChannelType>([ChannelType.LINKEDIN, ChannelType.EMAIL, ChannelType.WHATSAPP]);

// Trigger E — bulk preview. SIDE-EFFECT-FREE: computes the per-candidate channel
// breakdown + skip flags for the confirmation dialog. No sessions are minted (it
// only reads via pickInterviewChannel), so opening the dialog never creates rows.
// Body: { taskIds: string[], channel?: ChannelType }  (channel = force-one-channel)
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const taskIds: unknown = raw.taskIds;
    const forced: ChannelType | null = raw.channel && VALID_CHANNELS.has(raw.channel) ? raw.channel : null;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
    }
    if (taskIds.length > MAX_BULK_SIZE) {
      return NextResponse.json({ error: `taskIds limit is ${MAX_BULK_SIZE}` }, { status: 400 });
    }
    if (!taskIds.every((id) => typeof id === "string" && id.length > 0)) {
      return NextResponse.json({ error: "taskIds must be non-empty strings" }, { status: 400 });
    }

    const ids = taskIds as string[];
    const names = await prisma.task.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, candidateName: true },
    });
    const nameById = new Map(names.map((n) => [n.id, n.candidateName]));

    const byChannel: Record<ChannelType, number> = { LINKEDIN: 0, EMAIL: 0, WHATSAPP: 0 };
    let skipped = 0;
    const items: Array<{
      taskId: string;
      candidateName: string | null;
      channelType: ChannelType | null;
      reason: string | null;
    }> = [];

    for (const taskId of ids) {
      const { picked, candidates } = await pickInterviewChannel(taskId);
      let channelType: ChannelType | null = null;
      let reason: string | null = null;

      if (forced) {
        const c = candidates.find((x) => x.channelType === forced) ?? null;
        if (c?.sendable) channelType = forced;
        else reason = c?.reason ?? `No open ${forced} conversation`;
      } else {
        channelType = picked?.channelType ?? null;
        if (!channelType) reason = "No open channel";
      }

      if (channelType) byChannel[channelType] += 1;
      else skipped += 1;

      items.push({ taskId, candidateName: nameById.get(taskId) ?? null, channelType, reason });
    }

    return NextResponse.json({ total: items.length, byChannel, skipped, items });
  } catch (err) {
    console.error("[bulk-send-interview/preview]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
