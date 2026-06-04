import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSignedDownloadUrl } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Generates a short-lived presigned URL and redirects the browser to it.
// S3 keys are never sent to the client; the browser only ever sees the signed URL.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string; fileId: string }> },
) {
  const { taskId, fileId } = await params;

  const file = await prisma.candidateFile.findFirst({
    where: { id: fileId, taskId, deletedAt: null },
  });
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  const url = await getSignedDownloadUrl(file.storageKey, 300); // 5-minute window
  return NextResponse.redirect(url);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string; fileId: string }> },
) {
  const { taskId, fileId } = await params;

  const file = await prisma.candidateFile.findFirst({
    where: { id: fileId, taskId, deletedAt: null },
  });
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  await prisma.candidateFile.update({
    where: { id: fileId },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
