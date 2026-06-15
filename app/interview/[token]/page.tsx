"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, Check, Download, RefreshCw } from "lucide-react";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { exportTranscript } from "@/components/interview/TranscriptionView";
import type { ExportableSegment } from "@/components/interview/TranscriptionView";

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
  const [savedTranscript, setSavedTranscript] = useState<ExportableSegment[]>([]);

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
        <div className="flex flex-col items-center gap-5">
          <div className="relative w-14 h-14">
            {/* Track ring */}
            <div
              className="absolute inset-0 rounded-full"
              style={{ border: "2px solid rgba(1,183,172,0.12)" }}
            />
            {/* Spinning arc */}
            <div
              className="absolute inset-0 rounded-full animate-spin"
              style={{
                border: "2px solid transparent",
                borderTopColor: "#01B7AC",
                borderRightColor: "rgba(1,183,172,0.35)",
              }}
            />
            {/* Inner glow dot */}
            <div
              className="absolute inset-0 m-auto w-2 h-2 rounded-full"
              style={{ background: "#01B7AC", boxShadow: "0 0 8px rgba(1,183,172,0.8)" }}
            />
          </div>
          <p className="text-sm font-mono tracking-widest" style={{ color: "rgba(0,212,204,0.7)" }}>
            CONNECTING TO YOUR INTERVIEW…
          </p>
        </div>
      </Centered>
    );
  }

  if (error || !token) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center"
            style={{
              background: "rgba(244,63,94,0.08)",
              border: "1px solid rgba(244,63,94,0.28)",
              boxShadow: "0 0 24px rgba(244,63,94,0.1)",
            }}
          >
            <AlertCircle className="w-6 h-6 text-rose-400" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xl font-semibold text-white">Could not start interview</h2>
            <p className="text-slate-500 text-sm max-w-xs text-center">{error ?? "No token returned"}</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-slate-300 transition-colors hover:text-white mt-1"
            style={{ border: "1px solid rgba(8,65,87,0.7)", background: "rgba(8,65,87,0.2)" }}
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
        </div>
      </Centered>
    );
  }

  if (ended) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-5">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center"
            style={{
              background: "rgba(1,183,172,0.08)",
              border: "1px solid rgba(1,183,172,0.28)",
              boxShadow: "0 0 28px rgba(1,183,172,0.14)",
            }}
          >
            <Check className="w-7 h-7" strokeWidth={2.5} style={{ color: "#01B7AC" }} />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold text-white">Interview complete</h2>
            <p className="text-slate-400 text-sm max-w-xs text-center leading-relaxed">
              Thanks — you can close this tab. Your responses have been recorded and are being processed.
            </p>
          </div>
          {savedTranscript.length > 0 && (
            <button
              onClick={() => exportTranscript(savedTranscript)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-slate-300 transition-colors hover:text-white"
              style={{ border: "1px solid rgba(8,65,87,0.7)", background: "rgba(8,65,87,0.2)" }}
            >
              <Download className="w-4 h-4" />
              Export Transcript
            </button>
          )}
        </div>
      </Centered>
    );
  }

  return (
    <InterviewRoom
      token={token}
      serverUrl={serverUrl}
      onClose={markEnded}
      onDisconnected={markEnded}
      onTranscriptReady={setSavedTranscript}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="h-screen w-screen flex items-center justify-center"
      style={{ background: "radial-gradient(ellipse at 30% 20%, #0d2d3e 0%, #071d2b 40%, #050f18 100%)" }}
    >
      <div className="text-center max-w-md px-6">{children}</div>
    </div>
  );
}
