import { NextRequest, NextResponse } from "next/server";
import { runInterviewTranscriptTick } from "@/lib/interview/transcript-tick";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runInterviewTranscriptTick();
  return NextResponse.json(result);
}
