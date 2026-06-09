import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
    const includeArchived = searchParams.get("includeArchived") === "1";

    const where = includeArchived ? {} : { archived: false };

    const [requisitions, total] = await Promise.all([
      prisma.requisition.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          jobs: {
            select: {
              id: true,
              status: true,
              totalTasks: true,
              processedCount: true,
              failedCount: true,
              createdAt: true,
              _count: {
                select: {
                  tasks: {
                    where: {
                      deletedAt: null,
                      OR: [{ result: { not: null } }, { analysisResult: { not: null } }],
                    },
                  },
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      prisma.requisition.count({ where }),
    ]);

    const shaped = requisitions.map(r => {
      const runs = r.jobs;
      const totalCandidates = runs.reduce((s, j) => s + j.totalTasks, 0);
      const analyzedCount = runs.reduce((s, j) => s + j._count.tasks, 0);
      const activeRun = runs.find(j => j.status === "PENDING" || j.status === "PROCESSING");
      const lastRun = runs[0] || null;

      return {
        id: r.id,
        title: r.title,
        department: r.department,
        recruiterName: r.recruiterName,
        startDate: r.startDate,
        archived: r.archived,
        isActive: r.isActive,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        runCount: runs.length,
        totalCandidates,
        analyzedCount,
        activeRunStatus: activeRun?.status || null,
        activeRunProgress: activeRun
          ? { processed: activeRun.processedCount, total: activeRun.totalTasks }
          : null,
        lastRunAt: lastRun?.createdAt || null,
      };
    });

    return NextResponse.json({
      requisitions: shaped,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[Requisitions] GET failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const title = (body?.title || "").trim();
    const department = (body?.department || "").trim();
    const recruiterName = (body?.recruiterName || "").trim();
    const startDate = body?.startDate ? new Date(body.startDate) : null;

    if (!title) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const config = body?.config ? JSON.stringify(body.config) : null;

    const requisition = await prisma.requisition.create({
      data: { title, department, recruiterName, ...(startDate ? { startDate } : {}), config },
    });

    return NextResponse.json(requisition);
  } catch (error) {
    console.error("[Requisitions] POST failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
