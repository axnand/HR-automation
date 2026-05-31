import { NextRequest, NextResponse } from "next/server";
import { DuplicateKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseAndValidateUrls } from "@/lib/validators";
import { enqueueTaskBatch } from "@/lib/queue";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { orderedPair, type DuplicatePairInput as PairInput } from "@/lib/duplicate-pair";

export const dynamic = "force-dynamic";

function withinBatchPairs(urlToTaskIds: Map<string, string[]>, requisitionId: string): PairInput[] {
  const pairs: PairInput[] = [];
  for (const [url, ids] of urlToTaskIds.entries()) {
    for (let i = 0; i < ids.length - 1; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairs.push(orderedPair(requisitionId, ids[i], ids[j], DuplicateKind.LINKEDIN_URL, url));
      }
    }
  }
  return pairs;
}

async function crossRunPairs(
  prismaClient: typeof prisma,
  requisitionId: string,
  previousJobIds: string[],
  urlToTaskIds: Map<string, string[]>,
  valid: string[],
): Promise<PairInput[]> {
  const keptBoth = await prismaClient.duplicatePair.findMany({
    where: { requisitionId, status: "RESOLVED_KEPT_BOTH", kind: DuplicateKind.LINKEDIN_URL },
    include: { taskA: { select: { url: true } }, taskB: { select: { url: true } } },
  });
  const suppressed = new Set(keptBoth.flatMap((p) => [p.taskA.url, p.taskB.url]));
  const urlsToCheck = valid.filter((u) => !suppressed.has(u));
  if (urlsToCheck.length === 0) return [];

  const prevDone = await prismaClient.task.findMany({
    where: {
      jobId: { in: previousJobIds },
      url: { in: urlsToCheck },
      status: "DONE",
    },
    select: { id: true, url: true },
  });
  const pairs: PairInput[] = [];
  for (const prev of prevDone) {
    for (const newId of urlToTaskIds.get(prev.url) ?? []) {
      pairs.push(orderedPair(requisitionId, newId, prev.id, DuplicateKind.LINKEDIN_URL, prev.url));
    }
  }
  return pairs;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);
    const runs = await prisma.job.findMany({
      where: { requisitionId },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ runs });
  } catch (error) {
    console.error("[Runs] GET failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);
    const body = await req.json();
    const rawUrls: string = body?.urls || "";

    const { valid, invalid } = parseAndValidateUrls(rawUrls);
    if (valid.length === 0) {
      return NextResponse.json(
        { error: "No valid LinkedIn URLs found.", invalidUrls: invalid },
        { status: 400 }
      );
    }

    const requisition = await prisma.requisition.findUnique({ where: { id: requisitionId } });
    if (!requisition) {
      return NextResponse.json({ error: "Requisition not found" }, { status: 404 });
    }

    // Snapshot the requisition config onto the run so later edits don't rewrite history.
    const runConfig = requisition.config || "{}";

    const run = await prisma.job.create({
      data: {
        requisitionId,
        title: requisition.title,
        department: requisition.department,
        totalTasks: valid.length,
        status: "PENDING",
        config: runConfig,
      },
    });

    const BATCH_SIZE = 100;
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      await prisma.task.createMany({
        data: batch.map(url => ({ jobId: run.id, url, status: "PENDING" })),
      });
    }

    // bump the requisition's updatedAt so it sorts to top of the list
    await prisma.requisition.update({
      where: { id: requisitionId },
      data: { updatedAt: new Date() },
    });

    const createdTasks = await prisma.task.findMany({
      where: { jobId: run.id },
      select: { id: true, url: true, source: true },
    });
    await enqueueTaskBatch(createdTasks.map((t) => ({ id: t.id, source: t.source })));

    // Build URL -> new task IDs map
    const urlToNewTaskIds = new Map<string, string[]>();
    for (const t of createdTasks) {
      const arr = urlToNewTaskIds.get(t.url) ?? [];
      arr.push(t.id);
      urlToNewTaskIds.set(t.url, arr);
    }

    const previousJobs = await prisma.job.findMany({
      where: { requisitionId, id: { not: run.id } },
      select: { id: true },
    });
    const previousJobIds = previousJobs.map((j) => j.id);

    const pairsToCreate: PairInput[] = [
      ...withinBatchPairs(urlToNewTaskIds, requisitionId),
      ...(previousJobIds.length > 0
        ? await crossRunPairs(prisma, requisitionId, previousJobIds, urlToNewTaskIds, valid)
        : []),
    ];

    if (pairsToCreate.length > 0) {
      await prisma.duplicatePair.createMany({ data: pairsToCreate, skipDuplicates: true });
    }

    return NextResponse.json({
      runId: run.id,
      totalTasks: valid.length,
      invalidUrls: invalid.length > 0 ? invalid : undefined,
      duplicatesDetected: pairsToCreate.length > 0 ? pairsToCreate.length : undefined,
    });
  } catch (error) {
    console.error("[Runs] POST failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
