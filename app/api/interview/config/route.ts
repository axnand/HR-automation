import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/interview/config — returns the org-wide InterviewConfig singleton.
export async function GET() {
  try {
    const cfg = await prisma.interviewConfig.findUnique({
      where: { id: "global" },
    });
    return NextResponse.json(
      cfg ?? {
        id: "global",
        globalQuestions: [],
        defaultAgentName: "HR-Recruiter-Agent",
        defaultMessageTemplate: {},
      }
    );
  } catch (err) {
    console.error("[interview/config GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/interview/config  { globalQuestions?, defaultAgentName?, defaultMessageTemplate? }
// Partial update — only supplied keys are written.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    const cfg = await prisma.interviewConfig.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        globalQuestions: body.globalQuestions ?? [],
        defaultAgentName: body.defaultAgentName ?? "HR-Recruiter-Agent",
        defaultMessageTemplate: body.defaultMessageTemplate ?? {},
      },
      update: {
        ...(body.globalQuestions !== undefined && { globalQuestions: body.globalQuestions }),
        ...(body.defaultAgentName !== undefined && { defaultAgentName: body.defaultAgentName }),
        ...(body.defaultMessageTemplate !== undefined && { defaultMessageTemplate: body.defaultMessageTemplate }),
      },
    });

    return NextResponse.json(cfg);
  } catch (err) {
    console.error("[interview/config PUT]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
