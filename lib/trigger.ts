import { runOutreachTick } from "@/lib/channels/outreach-tick";

/**
 * Trigger the process-tasks endpoint.
 * Used by after() callbacks and the safety-net cron.
 */
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  // NEXTAUTH_URL is runtime (not build-time), so it works in worker processes
  // and on preview deployments where NEXT_PUBLIC_APP_URL may not be baked in.
  if (process.env.NEXTAUTH_URL) {
    return process.env.NEXTAUTH_URL;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export async function triggerProcessing(): Promise<void> {
  const base = getBaseUrl();
  const url = `${base}/api/process-tasks`;
  console.log(`[Trigger] Calling ${url} (CRON_SECRET set: ${!!process.env.CRON_SECRET})`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
    });
    const body = await res.text();
    console.log(`[Trigger] Response: ${res.status} - ${body}`);
  } catch (err) {
    console.error("[Trigger] Failed to trigger processing:", err);
  }
}

export function triggerOutreach(): void {
  runOutreachTick().catch((err) => console.error("[Trigger] Outreach tick failed:", err));
}
