"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Send, Copy, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SendInterviewDialog } from "./SendInterviewDialog";

// Shape of one SCAI transcript message.
type TranscriptMessage = {
  role: "assistant" | "user";
  content: string;
  metadata?: Record<string, unknown>;
};

type TranscriptData = {
  transcript?: { messages?: TranscriptMessage[] };
  summary?: {
    summary?: string;
    sentiment?: string;
  };
};

type Session = {
  id: string;
  status: string;
  sentVia: string | null;
  accessToken: string | null;
  sentAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  score: number | null;
  recommendation: string | null;
  questionsSnapshot: Array<{ id: string; order: number; text: string; mustAsk?: boolean; scope?: string }> | null;
  transcript: TranscriptData | null;
  createdAt: string;
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-muted text-muted-foreground",
  SENT: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  IN_PROGRESS: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  COMPLETED: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  ANALYZED: "bg-emerald-600/20 text-emerald-700 dark:text-emerald-300",
  EXPIRED: "bg-muted text-muted-foreground line-through",
  FAILED: "bg-destructive/15 text-destructive",
};

const CHANNEL_LABEL: Record<string, string> = {
  LINKEDIN: "LinkedIn",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  LINK_ONLY: "Link only",
};

const SENTIMENT_STYLE: Record<string, string> = {
  POSITIVE: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  NEUTRAL: "bg-muted text-muted-foreground",
  NEGATIVE: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// §10 / Phase 6 — the Interviews panel. Makes the link↔candidate association
// visible and testable; shows transcript + summary for COMPLETED sessions.
export function InterviewsPanel({
  taskId,
  requisitionId,
}: {
  taskId: string;
  requisitionId: string | null;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interview/sessions?taskId=${taskId}`);
      const data = await res.json();
      if (res.ok) setSessions(data.sessions ?? []);
    } catch {
      /* leave previous state */
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  function linkFor(s: Session): string | null {
    if (!s.accessToken) return null;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/interview/${s.accessToken}`;
  }

  async function copy(s: Session) {
    const url = linkFor(s);
    if (!url) {
      toast.error("No link for this session");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Interview link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Interviews</h3>
        <button
          onClick={() => setComposerOpen(true)}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80"
        >
          <Send className="h-3 w-3" />
          Send
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No interviews yet.</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => {
            const url = linkFor(s);
            const isCompleted = s.status === "COMPLETED" || s.status === "ANALYZED";
            const isExpanded = expandedId === s.id;
            const messages = s.transcript?.transcript?.messages ?? [];
            const summary = s.transcript?.summary?.summary;
            const sentiment = s.transcript?.summary?.sentiment;
            const questions = s.questionsSnapshot ?? [];

            return (
              <li key={s.id} className="rounded-lg border border-border p-2.5 space-y-1.5">
                {/* Header row */}
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide",
                      STATUS_STYLE[s.status] ?? "bg-muted",
                    )}
                  >
                    {s.status.replace(/_/g, " ")}
                  </span>
                  <div className="flex items-center gap-2">
                    {sentiment && (
                      <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded uppercase", SENTIMENT_STYLE[sentiment] ?? "bg-muted text-muted-foreground")}>
                        {sentiment}
                      </span>
                    )}
                    {s.sentVia && (
                      <span className="text-[10px] text-muted-foreground">{CHANNEL_LABEL[s.sentVia] ?? s.sentVia}</span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] text-muted-foreground">
                  {s.sentAt ? `Sent ${fmt(s.sentAt)}` : `Created ${fmt(s.createdAt)}`}
                  {s.score != null && <span className="ml-1 text-foreground font-medium">· {Math.round(s.score)}%</span>}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => copy(s)}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                    Copy link
                  </button>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open
                    </a>
                  )}
                  {isCompleted && (messages.length > 0 || summary) && (
                    <button
                      onClick={() => toggleExpand(s.id)}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground ml-auto"
                    >
                      {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      {isExpanded ? "Hide" : "Show"} transcript
                    </button>
                  )}
                </div>

                {/* Expanded transcript + questions */}
                {isExpanded && isCompleted && (
                  <div className="mt-2 pt-2 border-t border-border space-y-3">
                    {/* SCAI summary */}
                    {summary && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</p>
                        <p className="text-xs text-foreground leading-relaxed">{summary}</p>
                      </div>
                    )}

                    {/* Questions that were asked */}
                    {questions.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Questions ({questions.length})
                        </p>
                        <ol className="space-y-1">
                          {questions.map((q, i) => (
                            <li key={q.id} className="flex gap-1.5 text-xs text-muted-foreground">
                              <span className="font-mono shrink-0">{i + 1}.</span>
                              <span>{q.text}</span>
                              {q.mustAsk && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0 self-start mt-0.5">must</span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {/* Transcript thread */}
                    {messages.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Transcript · {messages.length} turn{messages.length !== 1 ? "s" : ""}
                        </p>
                        <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                          {messages.map((m, i) => (
                            <div
                              key={i}
                              className={cn(
                                "rounded-md px-2.5 py-2 text-xs leading-relaxed",
                                m.role === "assistant"
                                  ? "bg-muted/60 text-foreground"
                                  : "bg-primary/8 text-foreground border border-primary/15",
                              )}
                            >
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground block mb-0.5">
                                {m.role === "assistant" ? "Agent" : "Candidate"}
                              </span>
                              {m.content}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <SendInterviewDialog
        taskId={taskId}
        requisitionId={requisitionId}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        onSent={load}
      />
    </section>
  );
}
