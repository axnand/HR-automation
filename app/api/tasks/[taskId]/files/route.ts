import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { uploadToS3 } from "@/lib/s3";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const files = await prisma.candidateFile.findMany({
    where: { taskId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, mimeType: true, fileSize: true, uploadedBy: true, createdAt: true },
  });
  return NextResponse.json({ files });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "File type not allowed. Accepted: PDF, Word (.doc/.docx), JPEG, PNG, WebP" },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "File too large. Maximum size is 20 MB" }, { status: 400 });
  }

  // Sanitize filename to be S3-safe but still human-readable
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const storageKey = `candidate-attachments/${taskId}/${randomUUID()}_${safeName}`;

  try {
    await uploadToS3(storageKey, buffer, file.type);
  } catch (err: any) {
    console.error("[Files] S3 upload failed:", err.message);
    return NextResponse.json({ error: "Failed to store file" }, { status: 500 });
  }

  const record = await prisma.candidateFile.create({
    data: {
      taskId,
      fileName: file.name,
      mimeType: file.type,
      storageKey,
      fileSize: buffer.length,
      uploadedBy: (formData.get("uploadedBy") as string | null) ?? "",
    },
    select: { id: true, fileName: true, mimeType: true, fileSize: true, uploadedBy: true, createdAt: true },
  });

  return NextResponse.json({ file: record }, { status: 201 });
}
