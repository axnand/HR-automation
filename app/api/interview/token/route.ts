import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { getEffectiveInterviewQuestions } from "@/lib/interview/questions";

export const dynamic = "force-dynamic";

// POST /api/interview/token
//   { accessToken }          → preferred (Phase 3): the candidate capability URL
//                              segment. Resolves the session, reuses its roomId,
//                              marks it IN_PROGRESS. The only identifier the
//                              candidate browser ever sends (§9).
//   { sessionId }            → recruiter-side / legacy: same behavior, keyed by id.
//   { roomId?, name? }       → legacy ad-hoc path (no session record) for quick
//                              testing via /interview?name=...
//
// The SCAI API key never reaches the browser — this runs server-side only.
// Returns the minted LiveKit JWT plus the resolved sessionId (an opaque handle
// the candidate page uses to mark the session ended; the capability token, not
// this id, is what grants access). See docs/interview-flow.md §3.1 / §9.
export async function POST(req: NextRequest) {
  try {
    const { sessionId, accessToken, name, roomId } = await req.json();

    const apiUrl = process.env.SCAI_API_URL;
    const apiKey = process.env.SCAI_API_KEY;
    const orgId = process.env.SCAI_ORG_ID;

    if (!apiUrl || !apiKey || !orgId) {
      return NextResponse.json(
        { error: "SCAI credentials not configured" },
        { status: 500 }
      );
    }

    // ── Resolve the room from a capability token / session, or fall back to ad-hoc ──
    let room: string;
    let candidateName = name || "";
    let resolvedSessionId: string | null = null;
    let questionsSnapshot: unknown = null;
    let candidatePhone: string | null = null;
    let jobTitle: string | null = null;
    let department: string | null = null;

    if (accessToken || sessionId) {
      const sessionSelect = {
        id: true, roomId: true, status: true, expiresAt: true, questionsSnapshot: true,
        task: {
          select: {
            candidateName: true,
            candidateProfile: { select: { name: true } },
            contact: { select: { phone: true } },
            job: { select: { department: true, requisition: { select: { title: true, department: true, config: true } } } },
          },
        },
      } as const;
      const session = accessToken
        ? await prisma.interviewSession.findUnique({ where: { accessToken }, select: sessionSelect })
        : await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: sessionSelect });

      if (!session) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      // Link expiry — column exists from Phase 3; enforced here when set (the
      // expiry-setting policy itself is a fast-follow, so this is a no-op until
      // expiresAt gets populated). §9.
      if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
        await prisma.interviewSession
          .updateMany({ where: { id: session.id, status: { in: ["PENDING", "SENT"] } }, data: { status: "EXPIRED" } })
          .catch(() => {});
        return NextResponse.json({ error: "This interview link has expired" }, { status: 410 });
      }
      // Don't let a finished interview be re-joined (single-use-ish; Phase 1).
      if (session.status === "COMPLETED" || session.status === "ANALYZED" || session.status === "EXPIRED") {
        return NextResponse.json(
          { error: `Interview already ${session.status.toLowerCase()}` },
          { status: 409 }
        );
      }
      room = session.roomId;
      resolvedSessionId = session.id;
      candidateName = session.task.candidateName || session.task.candidateProfile?.name || candidateName;
      questionsSnapshot = session.questionsSnapshot;
      // Fallback: if the session was created before questions were configured,
      // fetch the current live questions so the call still gets them.
      if (!Array.isArray(questionsSnapshot) || questionsSnapshot.length === 0) {
        try {
          const liveQuestions = await getEffectiveInterviewQuestions(
            session.task.job?.requisition?.config ?? null
          );
          if (liveQuestions.length > 0) questionsSnapshot = liveQuestions;
        } catch {
          // best-effort; don't block the call
        }
      }
      candidatePhone = session.task.contact?.phone || null;
      jobTitle = session.task.job?.requisition?.title || session.task.job?.department || null;
      department = session.task.job?.requisition?.department || session.task.job?.department || null;
    } else {
      room = roomId || `interview_${randomUUID()}`;
    }

    // Org-wide interview defaults (Phase 2). The agent name is configurable in
    // Settings → Interview; fall back to the historical default if unset.
    const interviewCfg = await prisma.interviewConfig.findUnique({
      where: { id: "global" },
      select: { defaultAgentName: true },
    });
    const agentName = interviewCfg?.defaultAgentName?.trim() || "HR-agent-practice";

    const body = {
      pid: `pid_${randomUUID()}`,
      name: agentName,
      room,
      agent_dispatch: true,
      agent_metadata: {
        outlet_id: "hirro",
        outlet_name: "Hirro",
        agent_name: agentName,
        country_code: "",
        lob: "hccbckinddemo",
        source: "RECRUITMENT_LIVE_TRANSCRIPT",
        ...(candidateName && { candidate_name: candidateName }),
        ...(candidatePhone && { candidate_phone: candidatePhone }),
        ...(jobTitle && { job_title: jobTitle }),
        ...(department && { department }),
        // Phase 2: inject the snapshotted question list so the SCAI agent knows
        // what to ask. The field name was decided 2026-06-02 (§8, §2 Phase 2).
        // Sent as a single string prompt (numbered list) rather than an array —
        // the SCAI agent consumes `questions` as a plain-text instruction.
        // Only included when there are questions to send.
        ...(Array.isArray(questionsSnapshot) && questionsSnapshot.length > 0 && {
          questions: (questionsSnapshot as Array<Record<string, unknown>>)
            .map((q, i) => {
              const order = typeof q.order === "number" ? q.order : i + 1;
              const mustAsk = q.mustAsk ? " (must ask)" : "";
              return `${order}. ${q.text}${mustAsk}`;
            })
            .join("\n"),
        }),
      },
      enable_recording: false,
    };

    const response = await fetch(
      `${apiUrl}/auth/generate_room_token?hydrate-saas=false`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
          organizationId: orgId,
          lob: "hccbckinddemo",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("SCAI token API error:", response.status, text);
      if (resolvedSessionId) {
        await prisma.interviewSession
          .update({ where: { id: resolvedSessionId }, data: { status: "FAILED" } })
          .catch(() => {});
      }
      return NextResponse.json(
        { error: "Failed to generate room token" },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Mark the session live now that the token is minted and the candidate is
    // about to join. Only advance from PENDING/SENT so we don't downgrade a row
    // that's already further along.
    if (resolvedSessionId) {
      await prisma.interviewSession
        .updateMany({
          where: { id: resolvedSessionId, status: { in: ["PENDING", "SENT"] } },
          data: { status: "IN_PROGRESS", startedAt: new Date() },
        })
        .catch((e) => console.error("[interview/token] failed to mark IN_PROGRESS:", e));
    }

    return NextResponse.json({
      token: data.token,
      roomId: room,
      candidateName,
      sessionId: resolvedSessionId,
    });
  } catch (err) {
    console.error("Interview token route error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
