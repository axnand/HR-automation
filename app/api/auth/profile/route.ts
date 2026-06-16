import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { compare, hash } from "bcryptjs";

const BCRYPT_COST = 12;

// PATCH /api/auth/profile
// Accepts any combination of: { name?, email?, currentPassword?, newPassword? }
// Email / password changes require currentPassword to be verified first.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, email, currentPassword, newPassword } = body;
  const changingEmail = email && email.toLowerCase().trim() !== session.user.email.toLowerCase();
  const changingPassword = !!newPassword;

  // Email or password change requires current password verification.
  if (changingEmail || changingPassword) {
    if (!currentPassword) {
      return NextResponse.json(
        { error: "Current password is required to change email or password." },
        { status: 400 },
      );
    }
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { passwordHash: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const valid = await compare(currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
    }
  }

  // Build the update payload.
  const data: Record<string, string> = {};
  if (name !== undefined) data.name = name.trim() || "";
  if (changingEmail) data.email = email.toLowerCase().trim();
  if (changingPassword) {
    if (newPassword.length < 8) {
      return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 });
    }
    data.passwordHash = await hash(newPassword, BCRYPT_COST);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // Guard against email already taken.
  if (data.email) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
    }
  }

  const updated = await prisma.user.update({
    where: { email: session.user.email },
    data,
    select: { id: true, email: true, name: true, role: true },
  });

  return NextResponse.json({
    user: updated,
    // Tell the client if it needs to re-sign-in (email changed → JWT stale).
    requiresRelogin: !!data.email || !!data.passwordHash,
  });
}
