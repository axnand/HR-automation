"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";

// Public candidate interview page. The URL is /interview/<accessToken> — a
// capability URL: possession of the unguessable token grants access to exactly
// this one interview and nothing else (§9). The candidate browser only ever
// sends the accessToken; the server returns a LiveKit JWT scoped to one room
// plus an opaque sessionId used solely to mark the session ended on disconnect.
export default function InterviewTokenPage() {
  const { token: accessToken } = useParams<{ token: string }>();

  const [token, setToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";

  useEffect(() => {
    let cancelled = false;
    async function fetchToken() {
      try {
        setLoading(true);
        const res = await fetch("/api/interview/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start interview");
        if (!cancelled) {
          setToken(data.token);
          setSessionId(data.sessionId ?? null);
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchToken();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  function markEnded() {
    setEnded(true);
    // Fire-and-forget; the worker (Phase 4) is the source of truth for COMPLETED.
    if (sessionId) {
      fetch(`/api/interview/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ended: true }),
      }).catch(() => {});
    }
  }

  if (loading) {
    return (
      <Centered>
        <div className="text-muted-foreground tracking-wider font-mono">
          Connecting to your interview…
        </div>
      </Centered>
    );
  }

  if (error || !token) {
    return (
      <Centered>
        <h2 className="text-xl font-semibold text-destructive mb-1">
          Could not start the interview
        </h2>
        <p className="text-muted-foreground">{error ?? "No token returned"}</p>
      </Centered>
    );
  }

  if (ended) {
    return (
      <Centered>
        <h2 className="text-xl font-semibold mb-1">Interview ended</h2>
        <p className="text-muted-foreground">
          Thanks — you can close this tab. Your responses are being processed.
        </p>
      </Centered>
    );
  }

  return (
    <InterviewRoom
      token={token}
      serverUrl={serverUrl}
      onClose={markEnded}
      onDisconnected={markEnded}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-1 max-w-md px-6">{children}</div>
    </div>
  );
}
