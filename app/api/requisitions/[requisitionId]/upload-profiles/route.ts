import { NextRequest, NextResponse } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { DuplicateKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueTaskBatch } from "@/lib/queue";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { uploadPdfToS3 } from "@/lib/s3";
import { extractResumeInfo } from "@/lib/extract-resume";
import { orderedPair } from "@/lib/duplicate-pair";
import JSZip from "jszip";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse/lib/pdf-parse") as (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

export const dynamic = "force-dynamic";
// Required for file uploads in Next.js App Router
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  const { requisitionId: rawId } = await params;
  const requisitionId = await resolveRequisitionId(rawId);

  // Verify requisition exists and pull its config
  const requisition = await prisma.requisition.findUnique({
    where: { id: requisitionId },
  });

  if (!requisition) {
    return NextResponse.json({ error: "Requisition not found" }, { status: 404 });
  }

  // ── Parse multipart form data ──
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
  }

  const files = formData.getAll("files") as File[];
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  // ── Collect all individual PDFs from uploads ──
  // Each entry: { name, buffer, source }
  const pdfs: { name: string; buffer: Buffer; source: "resume" | "zip_import" }[] = [];

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fname = file.name.toLowerCase();

    if (fname.endsWith(".zip")) {
      // Unzip and find all PDFs inside
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(buffer);
      } catch (err) {
        console.warn(`[UploadProfiles] Failed to unzip "${file.name}":`, err);
        continue;
      }

      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (!path.toLowerCase().endsWith(".pdf")) continue;

        try {
          const pdfBuffer = Buffer.from(await entry.async("arraybuffer"));
          // Use just the filename, not the full path inside the zip
          const baseName = path.split("/").pop() || path;
          pdfs.push({ name: baseName, buffer: pdfBuffer, source: "zip_import" });
        } catch (err) {
          console.warn(`[UploadProfiles] Failed to read zip entry "${path}":`, err);
        }
      }
    } else if (fname.endsWith(".pdf")) {
      pdfs.push({ name: file.name, buffer, source: "resume" });
    }
  }

  if (pdfs.length === 0) {
    return NextResponse.json(
      { error: "No valid PDFs found. Upload PDF files or a ZIP containing PDFs." },
      { status: 400 }
    );
  }

  // ── Parse text from each PDF, upload original to S3, regex-extract info ──
  type ParsedProfile = {
    name: string;
    text: string;
    contentHash: string;
    source: "resume" | "zip_import";
    s3Key: string;
    extractedInfo: ReturnType<typeof extractResumeInfo>;
  };
  const parsedProfiles: ParsedProfile[] = [];
  const skippedUnreadable: string[] = [];
  const skippedParseError: string[] = [];
  const skippedS3Error: { name: string; reason: string }[] = [];

  for (const pdf of pdfs) {
    let text: string;
    try {
      const parsed = await pdfParse(pdf.buffer);
      text = parsed.text?.trim() ?? "";
    } catch (err: any) {
      console.warn(`[UploadProfiles] Failed to parse PDF "${pdf.name}":`, err.message);
      skippedParseError.push(pdf.name);
      continue;
    }

    if (text.length < 50) {
      // Too short — likely a scanned image PDF with no selectable text
      console.warn(`[UploadProfiles] PDF "${pdf.name}" yielded too little text (${text.length} chars) — skipping`);
      skippedUnreadable.push(pdf.name);
      continue;
    }

    // Upload the original PDF to S3 under a unique key
    const s3Key = `resumes/${requisitionId}/${randomUUID()}.pdf`;
    try {
      await uploadPdfToS3(s3Key, pdf.buffer);
    } catch (err: any) {
      console.error(`[UploadProfiles] S3 upload failed for "${pdf.name}":`, err.message);
      skippedS3Error.push({ name: pdf.name, reason: err.message });
      continue;
    }

    const extractedInfo = extractResumeInfo(text);
    const contentHash = createHash("sha256").update(text).digest("hex");

    parsedProfiles.push({
      name: pdf.name,
      text,
      contentHash,
      source: pdf.source,
      s3Key,
      extractedInfo,
    });
  }

  if (parsedProfiles.length === 0) {
    // Report the actual reason(s) instead of a catch-all message
    if (skippedS3Error.length > 0) {
      return NextResponse.json(
        {
          error: "Failed to store PDFs in S3. Check bucket permissions and credentials.",
          details: skippedS3Error[0].reason,
        },
        { status: 500 }
      );
    }
    if (skippedUnreadable.length > 0 && skippedParseError.length === 0) {
      return NextResponse.json(
        { error: "Could not extract readable text from any PDF. Make sure they are text-based PDFs (not scanned images)." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "None of the uploaded PDFs could be processed." },
      { status: 400 }
    );
  }

  const skipped = [...skippedUnreadable, ...skippedParseError, ...skippedS3Error.map(s => s.name)];

  // ── Create 1 Job for the whole upload session ──
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const sessionLabel = `Resume Upload — ${today}`;

  const job = await prisma.job.create({
    data: {
      requisitionId,
      title: requisition.title,
      department: requisition.department || "",
      totalTasks: parsedProfiles.length,
      status: "PENDING",
      // snapshot the requisition's current config so analysis uses the right JD + rules
      config: requisition.config ?? "{}",
    },
  });

  // Bump requisition updatedAt so it floats to top
  await prisma.requisition
    .update({ where: { id: requisitionId }, data: { updatedAt: new Date() } })
    .catch(() => {});

  // ── Create 1 Task per parsed PDF ──
  const BATCH_SIZE = 50;
  for (let i = 0; i < parsedProfiles.length; i += BATCH_SIZE) {
    const batch = parsedProfiles.slice(i, i + BATCH_SIZE);
    await prisma.task.createMany({
      data: batch.map((p) => {
        const nameParts = (p.extractedInfo.name || "").split(/\s+/).filter(Boolean);
        const firstName = nameParts[0] || "";
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";
        const publicId = p.extractedInfo.linkedinUrl
          ? p.extractedInfo.linkedinUrl.split("/").findLast((s) => s !== "") || ""
          : "";

        const finalSourceFileName = p.extractedInfo.isLinkedInExport 
          ? `${p.name} [LinkedIn Export]`
          : p.name;

        return {
          jobId: job.id,
          // Prefer the LinkedIn URL we pulled out of the PDF; fall back to a synthetic one
          url: p.extractedInfo.linkedinUrl || `resume://${encodeURIComponent(p.name)}`,
          source: p.source,
          sourceFileName: finalSourceFileName,
          sourceFileUrl: p.s3Key,
          status: "PENDING",
          // Pre-store extracted text + regex-extracted structured info so the processor skips Unipile.
          // Mirror canonical fields (first_name/last_name/headline/location/public_identifier) so
          // the candidate UI — which was built around Unipile's shape — renders without special-casing.
          contentHash: p.contentHash,
          result: JSON.stringify({
            resumeText: p.text,
            sourceFileName: finalSourceFileName,
            extractedInfo: p.extractedInfo,
            first_name: firstName,
            last_name: lastName,
            headline: p.extractedInfo.currentDesignation || "",
            location: p.extractedInfo.currentLocation || "",
            public_identifier: publicId,
            // Mirror Unipile's work_experience shape so computeCareerStats can score tenure/stability
            work_experience: p.extractedInfo.workExperience,
          }),
        };
      }),
    });
  }

  console.log(
    `[UploadProfiles] Created job ${job.id} with ${parsedProfiles.length} resume tasks for requisition ${requisitionId}. Skipped: ${skipped.length}`
  );

  // ── Enqueue tasks into pg-boss ──
  const createdTasks = await prisma.task.findMany({
    where: { jobId: job.id },
    select: { id: true, contentHash: true, source: true },
  });
  await enqueueTaskBatch(createdTasks.map((t) => ({ id: t.id, source: t.source })));
  console.log(`[UploadProfiles] Enqueued ${createdTasks.length} tasks for job ${job.id.slice(-6)}`);

  // ── Duplicate pair detection ──
  const hashToNewTaskIds = new Map<string, string[]>();
  for (const t of createdTasks) {
    if (!t.contentHash) continue;
    const arr = hashToNewTaskIds.get(t.contentHash) ?? [];
    arr.push(t.id);
    hashToNewTaskIds.set(t.contentHash, arr);
  }

  const pairsToCreate: {
    requisitionId: string; taskAId: string; taskBId: string; kind: DuplicateKind; matchValue: string;
  }[] = [];

  // Within-submission: same PDF uploaded more than once in this batch
  for (const [hash, ids] of hashToNewTaskIds.entries()) {
    for (let i = 0; i < ids.length - 1; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairsToCreate.push(orderedPair(requisitionId, ids[i], ids[j], DuplicateKind.RESUME_HASH, hash));
      }
    }
  }

  // Cross-run: same hash already DONE in a previous job
  const uploadedHashes = parsedProfiles.map((p) => p.contentHash);
  const previousJobs = await prisma.job.findMany({
    where: { requisitionId, id: { not: job.id } },
    select: { id: true },
  });
  const previousJobIds = previousJobs.map((j) => j.id);

  if (previousJobIds.length > 0) {
    const keptBoth = await prisma.duplicatePair.findMany({
      where: { requisitionId, status: "RESOLVED_KEPT_BOTH", kind: DuplicateKind.RESUME_HASH },
      include: { taskA: { select: { contentHash: true } }, taskB: { select: { contentHash: true } } },
    });
    const suppressed = new Set(
      keptBoth.flatMap((p) => [p.taskA.contentHash, p.taskB.contentHash].filter((h): h is string => Boolean(h)))
    );
    const hashesToCheck = uploadedHashes.filter((h) => !suppressed.has(h));

    if (hashesToCheck.length > 0) {
      const prevDone = await prisma.task.findMany({
        where: {
          jobId: { in: previousJobIds },
          contentHash: { in: hashesToCheck },
          status: "DONE",
        },
        select: { id: true, contentHash: true },
      });
      for (const prev of prevDone) {
        if (!prev.contentHash) continue;
        for (const newId of hashToNewTaskIds.get(prev.contentHash) ?? []) {
          pairsToCreate.push(orderedPair(requisitionId, newId, prev.id, DuplicateKind.RESUME_HASH, prev.contentHash));
        }
      }
    }
  }

  if (pairsToCreate.length > 0) {
    await prisma.duplicatePair.createMany({ data: pairsToCreate, skipDuplicates: true });
  }

  return NextResponse.json({
    message: "Profiles queued for analysis",
    jobId: job.id,
    sessionLabel,
    totalProfiles: parsedProfiles.length,
    skipped: skipped.length > 0 ? skipped : undefined,
    duplicatesDetected: pairsToCreate.length > 0 ? pairsToCreate.length : undefined,
  });
}
