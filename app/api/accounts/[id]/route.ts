import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET single account
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    return NextResponse.json({
      account: {
        ...account,
        apiKey: account.apiKey
          ? `${"•".repeat(Math.max(0, account.apiKey.length - 4))}${account.apiKey.slice(-4)}`
          : "",
      },
    });
  } catch (error) {
    console.error("Error fetching account:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT update account
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const { name, accountId, dsn, apiKey, status, dailyLimit } = body;

    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Build update data (only update provided fields)
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (accountId !== undefined) updateData.accountId = accountId;
    if (dsn !== undefined) updateData.dsn = dsn;
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (status !== undefined && ["ACTIVE", "DISABLED"].includes(status)) {
      updateData.status = status;
    }
    if (dailyLimit !== undefined) {
      updateData.dailyLimit = dailyLimit === null ? null : Math.max(1, Math.min(500, Number(dailyLimit)));
    }

    const updated = await prisma.account.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      message: "Account updated successfully",
      account: {
        id: updated.id,
        accountId: updated.accountId,
        name: updated.name,
        dsn: updated.dsn,
        status: updated.status,
      },
    });
  } catch (error) {
    console.error("Error updating account:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE account
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    if (existing.status === "BUSY") {
      return NextResponse.json(
        { error: "Cannot delete an account that is currently processing. Wait or disable it first." },
        { status: 409 }
      );
    }
    if (existing.deletedAt) {
      // Already soft-deleted — return idempotently. (Don't hard-delete here
      // either; we never hard-delete accounts so historical attribution on
      // ThreadMessage / ChannelThread is preserved.)
      return NextResponse.json({ message: "Account already deleted" });
    }

    // EC-9.6 — soft delete. Setting status=DISABLED also short-circuits the
    // worker's account-health check for any code path that doesn't yet check
    // deletedAt directly.
    await prisma.account.update({
      where: { id },
      data: { deletedAt: new Date(), status: "DISABLED" },
    });

    return NextResponse.json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Error deleting account:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
