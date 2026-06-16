import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  findWorkEmail, findPersonalEmail, findPhone,
  AirscaleError, type EnrichType,
} from "@/lib/airscale";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const body = await req.json().catch(() => ({}));
  const type: EnrichType = ["work_email", "personal_email", "phone", "all"].includes(body.type)
    ? body.type
    : "work_email";

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, url: true, contact: true },
  });

  if (!task)    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!task.url) return NextResponse.json({ error: "Task has no LinkedIn URL" }, { status: 400 });

  try {
    // Fetch only what was requested
    const [workEmail, personalEmail, phone] = await Promise.all([
      type === "work_email"     || type === "all" ? findWorkEmail(task.url)    : Promise.resolve(null),
      type === "personal_email" || type === "all" ? findPersonalEmail(task.url): Promise.resolve(null),
      type === "phone"          || type === "all" ? findPhone(task.url)        : Promise.resolve(null),
    ]);

    const hasData = workEmail || personalEmail || phone;
    if (!hasData) {
      const label = type === "all" ? "contact information" : type.replace("_", " ");
      return NextResponse.json({ ok: false, error: `No ${label} found for this profile` });
    }

    // Upsert — only overwrite fields that were fetched (preserve existing values)
    const contact = await prisma.candidateContact.upsert({
      where: { taskId },
      create: {
        taskId,
        workEmail:     workEmail ?? task.contact?.workEmail ?? null,
        personalEmail: personalEmail ?? task.contact?.personalEmail ?? null,
        phone:         phone ?? task.contact?.phone ?? null,
        email:         task.contact?.email ?? null,
        linkedinEmail: task.contact?.linkedinEmail ?? null,
        salary:        task.contact?.salary ?? null,
        source:        "AIRSCALE",
        enrichedAt:    new Date(),
      },
      update: {
        ...(workEmail     !== null ? { workEmail }     : {}),
        ...(personalEmail !== null ? { personalEmail } : {}),
        ...(phone         !== null ? { phone }         : {}),
        source:     "AIRSCALE",
        enrichedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true, contact });
  } catch (err: any) {
    if (err instanceof AirscaleError) {
      const status = err.statusCode === 402 ? 402 : err.statusCode === 504 ? 504 : 500;
      return NextResponse.json({ ok: false, error: err.message }, { status });
    }
    console.error("[Enrich] Error:", err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
