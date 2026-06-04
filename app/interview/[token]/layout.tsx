import type { Metadata } from "next";

// Standalone candidate surface — lives OUTSIDE the (app) route group, so it
// inherits only the root layout (html/body/theme) and gets NO AppShell / no
// navigation into the recruiter app (§9, "Level 1"). `referrer: no-referrer`
// emits <meta name="referrer" content="no-referrer"> so the capability token in
// the URL doesn't leak via the Referer header to SCAI / LiveKit.
export const metadata: Metadata = {
  title: "Interview",
  referrer: "no-referrer",
};

export default function InterviewTokenLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
