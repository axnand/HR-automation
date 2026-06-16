/**
 * User management CLI — create, list, reset-password, or delete recruiter accounts.
 *
 * Usage:
 *   npx tsx scripts/create-user.ts create --email you@salescode.ai --name "Your Name" --password secret [--role ADMIN]
 *   npx tsx scripts/create-user.ts list
 *   npx tsx scripts/create-user.ts reset-password --email you@salescode.ai --password newSecret
 *   npx tsx scripts/create-user.ts delete --email you@salescode.ai
 */

import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

const BCRYPT_COST = 12;

async function main() {
  const [, , command, ...rest] = process.argv;

  function arg(name: string): string | undefined {
    const idx = rest.indexOf(`--${name}`);
    return idx !== -1 ? rest[idx + 1] : undefined;
  }

  switch (command) {
    case "create": {
      const email = arg("email");
      const password = arg("password");
      const name = arg("name");
      const roleRaw = arg("role")?.toUpperCase();
      const role = (roleRaw === "ADMIN" || roleRaw === "RECRUITER" || roleRaw === "VIEWER")
        ? roleRaw
        : "RECRUITER" as const;

      if (!email || !password) {
        console.error("Usage: create --email <email> --password <password> [--name <name>] [--role ADMIN|RECRUITER|VIEWER]");
        process.exit(1);
      }

      const passwordHash = await hash(password, BCRYPT_COST);
      const user = await prisma.user.create({
        data: { email: email.toLowerCase().trim(), name: name ?? null, passwordHash, role },
        select: { id: true, email: true, name: true, role: true },
      });
      console.log("✓ Created user:", user);
      break;
    }

    case "list": {
      const users = await prisma.user.findMany({
        select: { id: true, email: true, name: true, role: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      if (!users.length) { console.log("No users yet."); break; }
      console.table(users.map(u => ({ ...u, createdAt: u.createdAt.toISOString().slice(0, 10) })));
      break;
    }

    case "reset-password": {
      const email = arg("email");
      const password = arg("password");
      if (!email || !password) {
        console.error("Usage: reset-password --email <email> --password <newPassword>");
        process.exit(1);
      }
      const passwordHash = await hash(password, BCRYPT_COST);
      await prisma.user.update({
        where: { email: email.toLowerCase().trim() },
        data: { passwordHash },
      });
      console.log("✓ Password updated for", email);
      break;
    }

    case "delete": {
      const email = arg("email");
      if (!email) { console.error("Usage: delete --email <email>"); process.exit(1); }
      await prisma.user.delete({ where: { email: email.toLowerCase().trim() } });
      console.log("✓ Deleted", email);
      break;
    }

    default:
      console.error("Commands: create | list | reset-password | delete");
      process.exit(1);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
