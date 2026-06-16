import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = (credentials?.email as string | undefined)?.toLowerCase().trim();
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, passwordHash: true, role: true },
        });
        if (!user) return null;

        const valid = await compare(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role };
      },
    }),
  ],

  callbacks: {
    jwt({ token, user }) {
      // Persist role into the JWT on sign-in so middleware can read it without a DB round-trip.
      if (user) token.role = (user as any).role;
      return token;
    },
    session({ session, token }) {
      if (session.user) (session.user as any).role = token.role;
      return session;
    },
  },

  pages: {
    signIn: "/login",
  },

  // JWT sessions stored in a secure HTTP-only cookie — no DB session table needed.
  // maxAge: 30 days — user stays logged in for a month without re-entering credentials.
  // updateAge: 24 h — cookie is silently refreshed once per day to extend the expiry,
  //   so active users never get bumped out mid-day.
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,   // 30 days in seconds
    updateAge: 24 * 60 * 60,      // refresh the cookie every 24 h of activity
  },
});
