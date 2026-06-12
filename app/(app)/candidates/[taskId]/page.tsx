"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight, ExternalLink, Briefcase, Building2, MapPin,
  GraduationCap, FileText, Send, Loader2, MessageSquare,
  ArrowRightLeft, Calendar, TrendingUp, Award, AlertCircle, CheckCircle2,
  XCircle, ChevronLeft, StickyNote, Pencil, Paperclip, Trash2, MoreHorizontal,
  Download, RotateCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { estimateCost, formatCost } from "@/lib/model-pricing";
import { getEffectiveRules } from "@/lib/analyzer";
import { cn } from "@/lib/utils";
import { STAGE_CONFIG } from "@/components/outreach/stage-config";

interface StageEvent {
  id: string;
  fromStage: string | null;
  toStage: string;
  actor: string;
  reason: string | null;
  createdAt: string;
}

interface OutreachMsg {
  id: string;
  channel: string;
  status: string;
  direction: string;
  renderedBody: string;
  inboundBody: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface Note {
  id: string;
  body: string;
  authorEmail: string;
  createdAt: string;
}

interface CandidateFile {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: string;
  createdAt: string;
}

interface TaskDetail {
  id: string;
  url: string;
  source: string;
  sourceFileName: string | null;
  hasResume: boolean;
  status: string;
  stage: string;
  createdAt: string;
  result: any;
  analysisResult: any;
  errorMessage: string | null;
  stageEvents: StageEvent[];
  outreachMessages: OutreachMsg[];
  job: {
    id: string;
    title: string;
    requisitionId: string | null;
    requisitionTitle: string;
    config: any;
  };
  contact: {
    email: string | null;
    linkedinEmail: string | null;
    personalEmail: string | null;
    workEmail: string | null;
    phone: string | null;
    salary: string | null;
    source: string | null;
    enrichedAt: string | null;
  } | null;
  overrides?: any[];
}

function getInitials(name: string) {
  return name.split(" ").slice(0, 2).map(n => n[0] ?? "").join("").toUpperCase();
}

const LinkedinIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
  </svg>
);

export default function CandidateDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteInput, setNoteInput] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState<"all" | "note" | "message" | "stage">("all");
  const [files, setFiles] = useState<CandidateFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const refreshTask = () => {
    fetch(`/api/tasks/${taskId}`)
      .then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(e.error)))
      .then(setTask)
      .catch(e => setError(typeof e === "string" ? e : "Failed to load candidate"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refreshTask();
    fetch(`/api/tasks/${taskId}/notes`)
      .then(r => r.json())
      .then(d => setNotes(d.notes ?? []))
      .catch(() => {});
    fetch(`/api/tasks/${taskId}/files`)
      .then(r => r.json())
      .then(d => setFiles(d.files ?? []))
      .catch(() => {});
  }, [taskId]);

  async function updateNote(noteId: string, body: string) {
    const res = await fetch(`/api/tasks/${taskId}/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, body } : n));
  }

  async function deleteNote(noteId: string) {
    const res = await fetch(`/api/tasks/${taskId}/notes/${noteId}`, { method: "DELETE" });
    if (res.ok) setNotes(prev => prev.filter(n => n.id !== noteId));
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/tasks/${taskId}/files`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Upload failed");
      setFiles(prev => [d.file, ...prev]);
    } catch (e: any) {
      alert(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function deleteFile(fileId: string) {
    const res = await fetch(`/api/tasks/${taskId}/files/${fileId}`, { method: "DELETE" });
    if (res.ok) setFiles(prev => prev.filter(f => f.id !== fileId));
  }

  async function saveNote() {
    if (!noteInput.trim()) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteInput }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setNotes(prev => [d.note, ...prev]);
      setNoteInput("");
    } catch { /* ignore */ } finally {
      setSavingNote(false);
    }
  }

  type EnrichType = "work_email" | "personal_email" | "phone" | "all";
  const [enrichingType, setEnrichingType] = useState<EnrichType | null>(null);
  const [enrichErrors, setEnrichErrors] = useState<Partial<Record<EnrichType, string>>>({});
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [reevaluating, setReevaluating] = useState(false);
  const [reevalResult, setReevalResult] = useState<{ delta: number; from: number; to: number } | null>(null);
  const [reevalError, setReevalError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    fetch("/api/airscale/credits")
      .then(r => r.json())
      .then(d => setCreditBalance(d.credits ?? null))
      .catch(() => {});
  }, []);

  async function handleEnrich(type: EnrichType) {
    setEnrichingType(type);
    setEnrichErrors(prev => { const n = { ...prev }; delete n[type]; return n; });
    try {
      const res = await fetch(`/api/tasks/${taskId}/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const d = await res.json();
      if (!d.ok) {
        setEnrichErrors(prev => ({ ...prev, [type]: d.error ?? "Not found" }));
        return;
      }
      refreshTask();
    } catch {
      setEnrichErrors(prev => ({ ...prev, [type]: "Network error" }));
    } finally {
      setEnrichingType(null);
    }
  }

  async function handleReevaluate() {
    setReevaluating(true);
    setReevalError(null);
    setReevalResult(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reevaluate`, { method: "POST" });
      const d = await res.json();
      if (!d.ok) {
        setReevalError(d.error ?? "Re-evaluation failed");
        return;
      }
      const from = d.before?.scorePercent ?? 0;
      const to = d.after?.scorePercent ?? 0;
      setReevalResult({ delta: Math.round((to - from) * 10) / 10, from, to });
      refreshTask();
    } catch {
      setReevalError("Network error");
    } finally {
      setReevaluating(false);
    }
  }

  async function updateCandidateInfo(key: string, value: string | number) {
    // Optimistic Update
    setTask(prev => {
      if (!prev) return prev;
      const analysis = prev.analysisResult || {};
      return {
        ...prev,
        analysisResult: {
          ...analysis,
          candidateInfo: { ...(analysis.candidateInfo || {}), [key]: value }
        }
      };
    });

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateInfo: { [key]: value } }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      alert("Failed to update candidate info");
      refreshTask(); // Revert on failure
    }
  }

  async function saveName() {
    const trimmed = nameInput.trim();
    if (!trimmed) { setEditingName(false); return; }
    setSavingName(true);
    // Optimistic update — patch all three local name sources so the header refreshes instantly
    setTask(prev => {
      if (!prev) return prev;
      const parts = trimmed.split(/\s+/);
      const newResult = prev.result
        ? { ...prev.result, first_name: parts[0] ?? "", last_name: parts.slice(1).join(" "),
            extractedInfo: prev.result.extractedInfo ? { ...prev.result.extractedInfo, name: trimmed } : prev.result.extractedInfo }
        : prev.result;
      return {
        ...prev,
        result: newResult,
        analysisResult: { ...prev.analysisResult, candidateInfo: { ...(prev.analysisResult?.candidateInfo ?? {}), name: trimmed } },
      };
    });
    setEditingName(false);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateInfo: { name: trimmed } }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      alert("Failed to update name");
      refreshTask();
    } finally {
      setSavingName(false);
    }
  }

  async function saveScoreOverride(paramKey: string, ruleKey: string, override: number, reason: string) {
    const res = await fetch(`/api/tasks/${taskId}/overrides`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paramKey, ruleKey, override, reason }),
    });
    if (!res.ok) throw new Error("Failed to save override");
    refreshTask();
  }

  async function removeScoreOverride(paramKey: string) {
    const res = await fetch(`/api/tasks/${taskId}/overrides?paramKey=${paramKey}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("Failed to remove override");
    refreshTask();
  }

  if (loading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="space-y-4 w-full max-w-lg px-8 animate-pulse">
          <div className="h-4 bg-muted rounded w-1/3" />
          <div className="h-8 bg-muted rounded w-1/2" />
          <div className="h-3 bg-muted rounded w-2/3" />
          <div className="h-48 bg-muted rounded mt-6" />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-muted-foreground">{error || "Candidate not found"}</p>
          <button onClick={() => window.close()} className="text-xs text-primary hover:underline">Close tab</button>
        </div>
      </div>
    );
  }

  const profile = task.result;
  const analysis = task.analysisResult;
  const jobConfig = task.job.config || {};

  const scrapedName = profile ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") : "";
  const extracted = profile?.extractedInfo || {};
  const name = scrapedName || extracted.name || analysis?.candidateInfo?.name || "Unknown";
  const headline = profile?.headline || profile?.occupation || extracted.currentDesignation || "";
  const location = analysis?.candidateInfo?.currentLocation || profile?.location || extracted.currentLocation || "";
  const info = analysis?.candidateInfo;

  const scorePercent = analysis?.scorePercent ?? 0;
  const scoreColor = scorePercent >= 70 ? "text-emerald-500" : scorePercent >= 40 ? "text-amber-500" : "text-rose-500";
  const scoreBgClass = scorePercent >= 70 ? "bg-emerald-500" : scorePercent >= 40 ? "bg-amber-500" : "bg-rose-500";
  const recommendationStyle =
    analysis?.recommendation === "Strong Fit"
      ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
      : analysis?.recommendation === "Moderate Fit"
      ? "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400"
      : "bg-rose-500/10 text-rose-600 border-rose-500/30 dark:text-rose-400";

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top Nav Bar */}
      <header className="shrink-0 bg-background/95 backdrop-blur border-b border-border z-20">
        <div className="flex items-center justify-between px-6 h-12">
          <div className="flex items-center gap-2 text-sm">
            {task.job.requisitionId ? (
              <Link
                href={`/jobs/${task.job.requisitionId}`}
                className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
                {task.job.requisitionTitle}
              </Link>
            ) : (
              <span className="text-muted-foreground flex items-center gap-1.5">
                <ChevronLeft className="h-4 w-4" />
                {task.job.requisitionTitle}
              </span>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <span className="font-semibold text-foreground">{name}</span>
          </div>
          <div className="flex items-center gap-2">
            {task.hasResume && (
              <a
                href={`/api/tasks/${task.id}/resume`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors px-3 py-1.5 rounded-md bg-primary/10 border border-primary/20"
              >
                <FileText className="h-3.5 w-3.5" />
                View Resume
              </a>
            )}
            {task.url && (
              <a
                href={task.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-md border border-border hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                LinkedIn
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Hero strip */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-5">
        <div className="flex items-center gap-5">
          <Avatar className="h-16 w-16 shrink-0 ring-2 ring-border">
            <AvatarImage
              src={profile?.profile_picture_url
                ? `/api/proxy-image?url=${encodeURIComponent(profile.profile_picture_url)}`
                : undefined}
              alt={name}
            />
            <AvatarFallback className="text-xl font-bold bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
              {getInitials(name)}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {editingName ? (
                <input
                  autoFocus
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.preventDefault(); saveName(); }
                    if (e.key === "Escape") { setNameInput(""); setEditingName(false); }
                  }}
                  disabled={savingName}
                  className="text-xl font-bold bg-background border border-primary/50 ring-2 ring-primary/20 outline-none rounded px-2 py-0.5 text-foreground tracking-tight min-w-[200px]"
                />
              ) : (
                <h1 className="text-xl font-bold text-foreground tracking-tight">{name}</h1>
              )}
              {analysis?.recommendation && (
                <Badge variant="outline" className={cn("text-xs font-semibold px-2.5 py-0.5", recommendationStyle)}>
                  {analysis.recommendation}
                </Badge>
              )}
              {task.url && (
                <a
                  href={task.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#0a66c2] hover:bg-[#0a66c2]/10 transition-colors inline-flex items-center justify-center rounded-md p-1"
                  title="View LinkedIn Profile"
                >
                  <LinkedinIcon className="h-5 w-5" />
                </a>
              )}
              {!editingName && (
                <button
                  onClick={() => { setNameInput(name); setEditingName(true); }}
                  className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Edit name"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-0.5 max-w-xl">
              <EditableField
                value={info?.currentDesignation || headline}
                onSave={v => updateCandidateInfo("currentDesignation", v)}
                className="text-sm text-muted-foreground w-full"
              />
            </div>
            <div className="flex items-center gap-5 mt-2 text-xs text-muted-foreground flex-wrap">
              {info?.currentOrg && (
                <span className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <EditableField
                    value={info.currentOrg}
                    onSave={v => updateCandidateInfo("currentOrg", v)}
                  />
                </span>
              )}
              {location && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <EditableField
                    value={location}
                    onSave={v => updateCandidateInfo("currentLocation", v)}
                  />
                </span>
              )}
              {info?.totalExperienceYears > 0 && (
                <span className="flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5 shrink-0" />
                  <EditableField
                    value={String(info.totalExperienceYears)}
                    suffix="yrs experience"
                    onSave={v => updateCandidateInfo("totalExperienceYears", parseFloat(v) || 0)}
                  />
                </span>
              )}
              {info?.stabilityAvgYears > 0 && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 shrink-0" />
                  {info.stabilityAvgYears} yrs avg tenure
                </span>
              )}
            </div>
          </div>

          {analysis && (
            <div className="shrink-0 flex items-center gap-4 pl-4 border-l border-border">
              <div className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <p className={cn("text-4xl font-black tabular-nums leading-none", scoreColor)}>
                    {scorePercent}%
                  </p>
                  <button
                    onClick={handleReevaluate}
                    disabled={reevaluating}
                    title="Re-evaluate against the current scoring rules (re-runs the AI on the saved profile — no LinkedIn re-scrape)"
                    aria-label="Re-evaluate profile"
                    className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RotateCw className={cn("h-3.5 w-3.5", reevaluating && "animate-spin")} />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 font-medium">
                  {analysis.totalScore} / {analysis.maxScore} pts
                </p>
                {reevalResult && (
                  <p className={cn(
                    "text-[11px] font-semibold mt-0.5 tabular-nums",
                    reevalResult.delta > 0 ? "text-emerald-500" : reevalResult.delta < 0 ? "text-rose-500" : "text-muted-foreground"
                  )}>
                    {reevalResult.delta > 0 ? "+" : ""}{reevalResult.delta}% vs last ({reevalResult.from}%→{reevalResult.to}%)
                  </p>
                )}
                {reevalError && (
                  <p className="text-[11px] font-medium mt-0.5 text-rose-500">{reevalError}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main content — 3-column scrollable */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full grid grid-cols-1 xl:grid-cols-[280px_1fr_300px] divide-x divide-border">

          {/* LEFT PANEL — Profile meta */}
          <aside className="overflow-y-auto p-4 space-y-4">

            {/* Contact & Enrichment */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Contact & Details</SectionLabel>
                {creditBalance !== null && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {creditBalance.toLocaleString()} credits
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {/* Work Email */}
                <ContactRevealCard
                  label="Work Email"
                  value={task.contact?.workEmail ?? null}
                  fallbackValue={task.contact?.email ?? null}
                  creditCost={1}
                  loading={enrichingType === "work_email"}
                  error={enrichErrors.work_email}
                  onReveal={() => handleEnrich("work_email")}
                  disabled={enrichingType !== null}
                />

                {/* Personal Email */}
                <ContactRevealCard
                  label="Personal Email"
                  value={task.contact?.personalEmail ?? null}
                  creditCost={1}
                  loading={enrichingType === "personal_email"}
                  error={enrichErrors.personal_email}
                  onReveal={() => handleEnrich("personal_email")}
                  disabled={enrichingType !== null}
                />

                {/* Phone */}
                <ContactRevealCard
                  label="Phone"
                  value={task.contact?.phone ?? null}
                  creditCost={2}
                  loading={enrichingType === "phone"}
                  error={enrichErrors.phone}
                  onReveal={() => handleEnrich("phone")}
                  disabled={enrichingType !== null}
                />

                {/* Salary (manual/note-sourced) */}
                {task.contact?.salary && (
                  <EditableField renderMode="statcard" label="Salary / Expected" value={task.contact.salary} onSave={() => Promise.resolve()} />
                )}

                {/* Reveal All */}
                {(!task.contact?.workEmail && !task.contact?.personalEmail && !task.contact?.phone) && (
                  <button
                    onClick={() => handleEnrich("all")}
                    disabled={enrichingType !== null}
                    className="w-full mt-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-primary/25 bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                  >
                    {enrichingType === "all"
                      ? <><Loader2 className="h-3 w-3 animate-spin" />Enriching all…</>
                      : <>🔓 Reveal All — 4 credits</>}
                  </button>
                )}

                {enrichErrors.all && (
                  <p className="text-[11px] text-destructive text-center">{enrichErrors.all}</p>
                )}
              </div>
            </section>

            {/* Quick stats */}
            {info && (
              <section>
                <SectionLabel>Profile Info</SectionLabel>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  {info.totalExperienceYears > 0 && (
                    <EditableField renderMode="statcard" label="Experience" value={String(info.totalExperienceYears)} onSave={v => updateCandidateInfo("totalExperienceYears", parseFloat(v) || 0)} />
                  )}
                  {info.companiesSwitched > 0 && (
                    <EditableField renderMode="statcard" label="Companies" value={String(info.companiesSwitched)} onSave={v => updateCandidateInfo("companiesSwitched", parseInt(v) || 0)} />
                  )}
                  {info.stabilityAvgYears > 0 && (
                    <EditableField renderMode="statcard" label="Avg Tenure" value={String(info.stabilityAvgYears)} onSave={v => updateCandidateInfo("stabilityAvgYears", parseFloat(v) || 0)} />
                  )}
                  {info.currentLocation && (
                    <EditableField renderMode="statcard" label="Location" value={info.currentLocation} span onSave={v => updateCandidateInfo("currentLocation", v)} />
                  )}
                  {info.btech && (
                    <EditableField renderMode="statcard" label="BTech / BE" value={info.btech} span onSave={v => updateCandidateInfo("btech", v)} />
                  )}
                  {info.graduation && (
                    <EditableField renderMode="statcard" label="Graduation" value={info.graduation} span onSave={v => updateCandidateInfo("graduation", v)} />
                  )}
                  {info.mba && (
                    <EditableField renderMode="statcard" label="MBA" value={info.mba} span onSave={v => updateCandidateInfo("mba", v)} />
                  )}
                  {info.graduationYear && (
                    <EditableField renderMode="statcard" label="Grad Year" value={String(info.graduationYear)} onSave={v => updateCandidateInfo("graduationYear", parseInt(v) || 0)} />
                  )}
                </div>
              </section>
            )}

            {/* Strengths */}
            {analysis?.strengths?.length > 0 && (
              <section>
                <SectionLabel icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}>
                  Strengths
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
                  {analysis.strengths.map((s: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                      <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
                      <span className="leading-relaxed">{s}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Gaps */}
            {analysis?.gaps?.length > 0 && (
              <section>
                <SectionLabel icon={<AlertCircle className="h-3.5 w-3.5 text-amber-500" />}>
                  Gaps
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
                  {analysis.gaps.map((g: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                      <span className="text-amber-500 mt-0.5 shrink-0">△</span>
                      <span className="leading-relaxed">{g}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Flags */}
            {analysis?.flags?.length > 0 && (
              <section>
                <SectionLabel icon={<XCircle className="h-3.5 w-3.5 text-rose-500" />}>
                  Red Flags
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3 space-y-2">
                  {analysis.flags.map((f: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                      <span className="text-rose-500 mt-0.5 shrink-0">✕</span>
                      <span className="leading-relaxed">{f}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>

          {/* CENTER PANEL — Main content */}
          <main className="overflow-y-auto p-5 space-y-5">

            {/* AI Summary */}
            {analysis?.experienceSummary && (
              <section>
                <SectionLabel icon={<TrendingUp className="h-3.5 w-3.5 text-primary" />}>
                  AI Summary
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
                  <p className="text-sm text-foreground leading-relaxed">{analysis.experienceSummary}</p>
                  {analysis.remarks && (
                    <p className="text-sm text-muted-foreground italic border-t border-primary/10 pt-3">{analysis.remarks}</p>
                  )}
                </div>
              </section>
            )}

            {/* Scoring breakdown */}
            {analysis && (
              <section>
                <SectionLabel icon={<Award className="h-3.5 w-3.5 text-primary" />}>
                  Scoring Breakdown
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-border bg-card overflow-hidden">
                  {(() => {
                    const effectiveRules = getEffectiveRules({
                      scoringRules: analysis.enabledRules || jobConfig.scoringRules,
                      customScoringRules: analysis.customScoringRules || jobConfig.customScoringRules || [],
                      builtInRuleDescriptions: jobConfig.builtInRuleDescriptions,
                      ruleDefinitions: jobConfig.ruleDefinitions,
                    }).filter((r: any) => r.enabled);
                    return effectiveRules.map((rule: any, idx: number) => {
                      return (
                        <ScoreOverrideRow
                          key={rule.key}
                          rule={rule}
                          analysis={analysis}
                          overrides={task.overrides || []}
                          idx={idx}
                          onSave={saveScoreOverride}
                          onRemove={removeScoreOverride}
                        />
                      );
                    });
                  })()}
                </div>
              </section>
            )}

            {/* Skills */}
            {analysis?.skillBreakdown && (
              <section>
                <SectionLabel>
                  Skills &mdash; {analysis.skillBreakdown.matchPercent}% Match
                </SectionLabel>
                <div className="mt-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap gap-2">
                    {(analysis.skillBreakdown.matchedSkills || []).map((s: string, i: number) => (
                      <span key={i} className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 font-medium">{s}</span>
                    ))}
                    {(analysis.skillBreakdown.missingSkills || []).map((s: string, i: number) => (
                      <span key={i} className="px-2.5 py-1 rounded-full text-xs bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/25 font-medium">{s}</span>
                    ))}
                  </div>
                  <div className="flex gap-4 mt-3 pt-3 border-t border-border/60">
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Matched
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-rose-500 inline-block" /> Missing
                    </span>
                  </div>
                </div>
              </section>
            )}

            {/* Work Experience */}
            {profile?.work_experience?.length > 0 && (
              <section>
                <SectionLabel icon={<Briefcase className="h-3.5 w-3.5 text-muted-foreground" />}>
                  Work Experience
                </SectionLabel>
                <div className="mt-3 space-y-3">
                  {profile.work_experience.map((exp: any, i: number) => (
                    <div key={i} className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">{exp.position || "Untitled Role"}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{exp.company || ""}</p>
                        </div>
                        {exp.start && (
                          <span className="text-xs text-muted-foreground/70 shrink-0 bg-muted/60 px-2 py-0.5 rounded-md">
                            {exp.start} – {exp.end || "Present"}
                          </span>
                        )}
                      </div>
                      {exp.description && (
                        <p className="text-xs text-muted-foreground mt-2.5 leading-relaxed line-clamp-3">{exp.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Education */}
            {profile?.education?.length > 0 && (
              <section>
                <SectionLabel icon={<GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />}>
                  Education
                </SectionLabel>
                <div className="mt-3 space-y-2">
                  {profile.education.map((edu: any, i: number) => (
                    <div key={i} className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <GraduationCap className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{edu.school || "Unknown School"}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{[edu.degree, edu.field_of_study].filter(Boolean).join(" · ")}</p>
                        {(edu.start_year || edu.end_year) && (
                          <p className="text-xs text-muted-foreground/60 mt-0.5">{edu.start_year} – {edu.end_year || "Present"}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* About */}
            {profile?.summary && (
              <section>
                <SectionLabel>About</SectionLabel>
                <div className="mt-3 rounded-xl border border-border bg-card p-4">
                  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{profile.summary}</p>
                </div>
              </section>
            )}

            {/* Debug */}
            {analysis?.__debug && (
              <details className="group">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1.5 select-none">
                  <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                  Debug Info
                </summary>
                <div className="mt-3 space-y-2 pl-4">
                  <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase mb-1">Model</p>
                    <p className="text-xs font-mono text-muted-foreground">{analysis.__debug.model}</p>
                  </div>
                  {analysis.__debug.usage && (() => {
                    const usage = analysis.__debug.usage;
                    const cost = estimateCost(usage.prompt_tokens, usage.completion_tokens, analysis.__debug.model);
                    return (
                      <div className="bg-muted/40 rounded-lg p-3">
                        <p className="text-[10px] text-muted-foreground font-medium uppercase mb-1">Token Usage</p>
                        <p className="text-xs font-mono text-muted-foreground">
                          Prompt: {usage.prompt_tokens} · Completion: {usage.completion_tokens} · Total: {usage.total_tokens}
                        </p>
                        {cost && <p className="text-xs font-mono text-emerald-400/80 mt-1">Cost: {formatCost(cost.totalCost)}</p>}
                      </div>
                    );
                  })()}
                </div>
              </details>
            )}
          </main>

          {/* RIGHT PANEL — Notes + Activity */}
          <aside className="overflow-y-auto p-4 space-y-4">

            {/* Notes */}
            <section>
              <SectionLabel icon={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}>
                Notes
              </SectionLabel>
              <div className="mt-3 space-y-2">
                <Textarea
                  value={noteInput}
                  onChange={e => setNoteInput(e.target.value)}
                  placeholder="Add a note about this candidate…"
                  rows={4}
                  className="text-sm resize-none bg-muted/30 border-border/60 focus:bg-background"
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
                  }}
                />
                <Button
                  size="sm"
                  className="w-full gap-1.5 text-xs h-8"
                  disabled={savingNote || !noteInput.trim()}
                  onClick={saveNote}
                >
                  {savingNote ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                  Save note
                </Button>

                {notes.length > 0 && (
                  <div className="space-y-2 pt-2">
                    {notes.map(n => (
                      <NoteCard key={n.id} note={n} onUpdate={updateNote} onDelete={deleteNote} />
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Attachments */}
            <section>
              <SectionLabel icon={<Paperclip className="h-3.5 w-3.5 text-muted-foreground" />}>
                Attachments
              </SectionLabel>
              <div className="mt-3 space-y-1.5">
                {/* Upload button */}
                <label className={cn(
                  "flex items-center justify-center gap-2 h-8 rounded-lg border border-dashed border-border/60",
                  "text-xs text-muted-foreground cursor-pointer transition-colors",
                  "hover:border-primary/40 hover:text-primary hover:bg-primary/5",
                  uploading && "opacity-50 pointer-events-none",
                )}>
                  <input
                    type="file"
                    className="hidden"
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) uploadFile(f);
                      e.target.value = "";
                    }}
                  />
                  {uploading
                    ? <><Loader2 className="h-3 w-3 animate-spin" />Uploading…</>
                    : <><Paperclip className="h-3 w-3" />Attach file</>}
                </label>

                {/* Original resume — read-only */}
                {task.hasResume && (
                  <a
                    href={`/api/tasks/${task.id}/resume`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 hover:bg-muted/40 transition-colors group"
                  >
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-foreground flex-1 truncate">Original Resume</span>
                    <Download className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                  </a>
                )}

                {/* Uploaded files */}
                {files.map(f => (
                  <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 group">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{f.fileName}</p>
                      <p className="text-[10px] text-muted-foreground/60">{formatFileSize(f.fileSize)}</p>
                    </div>
                    <a
                      href={`/api/tasks/${taskId}/files/${f.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                      title="Download"
                    >
                      <Download className="h-3 w-3" />
                    </a>
                    <button
                      onClick={() => deleteFile(f.id)}
                      className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 shrink-0 transition-all"
                      title="Remove"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}

                {!task.hasResume && files.length === 0 && !uploading && (
                  <p className="text-[11px] text-muted-foreground/50 text-center py-1">No attachments yet</p>
                )}
              </div>
            </section>

            {/* Activity */}
            {(() => {
              const allItems = buildTimeline(task.stageEvents ?? [], task.outreachMessages ?? [], notes);
              const filtered = timelineFilter === "all" ? allItems : allItems.filter(i => i.type === timelineFilter);
              if (allItems.length === 0) return null;
              return (
                <section>
                  <SectionLabel>Activity</SectionLabel>
                  <div className="mt-2 flex items-center gap-1 flex-wrap">
                    {(["all", "note", "message", "stage"] as const).map(f => {
                      const labels = { all: "All", note: "Notes", message: "Messages", stage: "Stages" };
                      const count = f === "all" ? allItems.length : allItems.filter(i => i.type === f).length;
                      const active = timelineFilter === f;
                      return (
                        <button
                          key={f}
                          onClick={() => setTimelineFilter(f)}
                          className={cn(
                            "px-2 py-1 rounded-md text-[10px] font-medium transition-colors border",
                            active
                              ? "bg-primary/10 text-primary border-primary/20"
                              : "bg-transparent text-muted-foreground border-transparent hover:bg-muted"
                          )}
                        >
                          {labels[f]} {count > 0 && <span className="ml-0.5 opacity-70">{count}</span>}
                        </button>
                      );
                    })}
                  </div>
                  <ol className="mt-3 relative border-l-2 border-border/50 space-y-4 pl-5">
                    {filtered.map((item, i) => (
                      <li key={i} className="relative">
                        <span className="absolute -left-[1.4rem] top-1 h-4 w-4 rounded-full border-2 border-background bg-muted flex items-center justify-center">
                          {item.type === "stage"
                            ? <ArrowRightLeft className="h-2 w-2 text-muted-foreground" />
                            : item.type === "note"
                            ? <StickyNote className="h-2 w-2 text-muted-foreground" />
                            : <Send className="h-2 w-2 text-muted-foreground" />}
                        </span>
                        <p className="text-xs font-semibold text-foreground leading-snug">{item.label}</p>
                        {item.sub && <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{item.sub}</p>}
                        <p className="text-[10px] text-muted-foreground/50 mt-0.5">{item.time}</p>
                      </li>
                    ))}
                  </ol>
                  {filtered.length === 0 && (
                    <p className="text-xs text-muted-foreground/50 mt-3">No {timelineFilter === "all" ? "" : timelineFilter} activity yet.</p>
                  )}
                </section>
              );
            })()}
          </aside>
        </div>
      </div>
    </div>
  );
}

function ContactRevealCard({
  label, value, fallbackValue, creditCost, loading, error, onReveal, disabled,
}: {
  label: string;
  value: string | null;
  fallbackValue?: string | null;
  creditCost: number;
  loading: boolean;
  error?: string;
  onReveal: () => void;
  disabled: boolean;
}) {
  const display = value ?? fallbackValue ?? null;
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!display) return;
    navigator.clipboard.writeText(display);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/20">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        {display && (
          <button
            onClick={copy}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        )}
      </div>
      <div className="px-3 py-2.5">
        {display ? (
          <p className="text-xs font-mono text-foreground break-all">{display}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 rounded bg-muted/60 w-24 blur-[3px]" />
              <div className="h-2.5 rounded bg-muted/40 w-16 blur-[3px]" />
            </div>
            {error && <p className="text-[10px] text-destructive">{error}</p>}
            <button
              onClick={onReveal}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:text-primary/80 disabled:opacity-40 transition-colors"
            >
              {loading
                ? <><Loader2 className="h-3 w-3 animate-spin" />Searching…</>
                : <>🔓 Reveal — {creditCost} credit{creditCost !== 1 ? "s" : ""}</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">{children}</p>
    </div>
  );
}

function StatCard({ label, value, span }: { label: string; value: string; span?: boolean }) {
  return (
    <div className={cn("bg-muted/20 rounded-[10px] p-2.5 items-start", span && "col-span-2")}>
      <p className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">{label}</p>
      <p className="text-[13px] font-semibold text-foreground leading-snug truncate">{value}</p>
    </div>
  );
}

function EditableField({
  value,
  onSave,
  renderMode = "text",
  label,
  span,
  className,
  suffix,
}: {
  value: string;
  onSave: (val: string) => Promise<void>;
  renderMode?: "text" | "statcard";
  label?: string;
  span?: boolean;
  className?: string;
  suffix?: React.ReactNode;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [val, setVal] = useState(value);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  const save = async () => {
    if (val === value) { setIsEditing(false); return; }
    setSaving(true);
    try {
      await onSave(val);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch {
      setVal(value);
    } finally {
      setSaving(false);
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <div className={cn(
        renderMode === "statcard" ? cn("bg-muted/20 rounded-[10px] p-2.5", span && "col-span-2") : "inline-flex w-full max-w-sm",
        className
      )}>
        {renderMode === "statcard" && label && <p className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">{label}</p>}
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") { setVal(value); setIsEditing(false); }
          }}
          disabled={saving}
          className={cn(
            "w-full bg-background border border-primary/50 ring-2 ring-primary/20 outline-none rounded px-2 py-1 text-sm text-foreground",
            renderMode === "text" && "min-w-[120px] m-0"
          )}
        />
      </div>
    );
  }

  const content = (
    <div className="flex items-center flex-1 min-w-0">
      <span className={cn(
        "group-hover:opacity-80 transition-opacity truncate",
        renderMode === "statcard" ? "text-[13px] font-semibold text-foreground leading-snug block" : ""
      )}>
        {value || "—"}
        {suffix && <span className="ml-1.5 text-muted-foreground font-normal text-[13px]">{suffix}</span>}
      </span>
      {!saving && !savedOk && <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-1.5 text-muted-foreground/50 hover:text-foreground" />}
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0 ml-1.5" />}
      {savedOk && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0 ml-1.5" />}
    </div>
  );

  return (
    <div
      onClick={() => setIsEditing(true)}
      className={cn(
        "group cursor-pointer flex items-center hover:bg-muted/30 rounded transition-colors",
        renderMode === "statcard" ? cn("bg-muted/20 rounded-[10px] p-2.5 items-start", span && "col-span-2") : "px-1 -mx-1",
        className
      )}
    >
      {renderMode === "statcard" ? (
        <div className="w-full overflow-hidden">
          {label && <p className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">{label}</p>}
          <div className="flex items-center">
            {content}
          </div>
        </div>
      ) : content}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteCard({
  note,
  onUpdate,
  onDelete,
}: {
  note: Note;
  onUpdate: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(note.body);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!editBody.trim() || editBody === note.body) { setEditing(false); return; }
    setSaving(true);
    try {
      await onUpdate(note.id, editBody.trim());
      setEditing(false);
    } catch {
      // keep editing state open on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5 group relative">
      {editing ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={3}
            className="text-xs resize-none bg-background border-border/60"
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              if (e.key === "Escape") { setEditBody(note.body); setEditing(false); }
            }}
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-xs px-2.5" disabled={saving || !editBody.trim()} onClick={save}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => { setEditBody(note.body); setEditing(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap pr-6">{note.body}</p>
          <p className="text-[10px] text-muted-foreground/70">
            {note.authorEmail || "Reviewer"} · {fmtTime(note.createdAt)}
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="absolute top-2 right-2 h-5 w-5 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground transition-all">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-28">
              <DropdownMenuItem onClick={() => setEditing(true)} className="text-xs gap-2 cursor-pointer">
                <Pencil className="h-3 w-3" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(note.id)}
                className="text-xs gap-2 cursor-pointer text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

function buildTimeline(
  stageEvents: StageEvent[],
  outreachMessages: OutreachMsg[],
  notes: Note[] = [],
): { type: "stage" | "message" | "note"; label: string; sub?: string; time: string }[] {
  const items: { type: "stage" | "message" | "note"; label: string; sub?: string; time: string; ts: number }[] = [];

  for (const ev of stageEvents) {
    const from = ev.fromStage ? (STAGE_CONFIG as any)[ev.fromStage]?.label ?? ev.fromStage : null;
    const to = (STAGE_CONFIG as any)[ev.toStage]?.label ?? ev.toStage;
    items.push({
      type: "stage",
      label: from ? `${from} → ${to}` : `Moved to ${to}`,
      sub: ev.reason ?? ev.actor,
      time: fmtTime(ev.createdAt),
      ts: new Date(ev.createdAt).getTime(),
    });
  }

  for (const msg of outreachMessages) {
    if (msg.direction === "IN") {
      items.push({
        type: "message",
        label: "Reply received",
        sub: msg.inboundBody ? msg.inboundBody.slice(0, 80) + (msg.inboundBody.length > 80 ? "…" : "") : undefined,
        time: fmtTime(msg.sentAt ?? msg.createdAt),
        ts: new Date(msg.sentAt ?? msg.createdAt).getTime(),
      });
    } else if (msg.status === "SENT") {
      const channel = msg.channel === "LINKEDIN_INVITE" ? "Invite sent" : "Message sent";
      items.push({
        type: "message",
        label: channel,
        sub: msg.renderedBody ? msg.renderedBody.slice(0, 60) + (msg.renderedBody.length > 60 ? "…" : "") : undefined,
        time: fmtTime(msg.sentAt ?? msg.createdAt),
        ts: new Date(msg.sentAt ?? msg.createdAt).getTime(),
      });
    }
  }

  for (const n of notes) {
    items.push({
      type: "note",
      label: `Note by ${n.authorEmail || "Reviewer"}`,
      sub: n.body.length > 80 ? n.body.slice(0, 80) + "…" : n.body,
      time: fmtTime(n.createdAt),
      ts: new Date(n.createdAt).getTime(),
    });
  }

  return items.sort((a, b) => b.ts - a.ts).map(({ ts: _, ...rest }) => rest);
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function ScoreOverrideRow({
  rule,
  analysis,
  overrides,
  idx,
  onSave,
  onRemove,
}: {
  rule: any;
  analysis: any;
  overrides: any[];
  idx: number;
  onSave: (paramKey: string, ruleKey: string, override: number, reason: string) => Promise<void>;
  onRemove: (paramKey: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [scoreInput, setScoreInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [saving, setSaving] = useState(false);

  const ruleMax = Math.max(0, ...rule.scoreParameters.map((p: any) => p.maxPoints));
  
  // Find which parameter yielded the highest score natively, and check if any param is overridden
  let bestVal = 0;
  let activeParamKey = rule.scoreParameters[0].key;
  let activeOverride: any = null;

  for (const p of rule.scoreParameters) {
    const o = overrides.find(o => o.paramKey === p.key);
    if (o) {
      activeOverride = o;
      bestVal = o.override;
      activeParamKey = p.key;
      break; // Overrides take absolute precedence
    } else {
      const s = analysis.scoring?.[p.key];
      if (typeof s === "number" && s > bestVal) {
        bestVal = s;
        activeParamKey = p.key;
      }
    }
  }

  const logText = analysis.scoringLogs?.[rule.key];
  const pct = ruleMax > 0 ? (bestVal / ruleMax) * 100 : 0;
  const isOverridden = !!activeOverride;
  const barColor = isOverridden ? "bg-blue-500" : bestVal >= ruleMax * 0.7 ? "bg-emerald-500" : bestVal > 0 ? "bg-amber-500" : "bg-muted-foreground/20";
  const textColor = isOverridden ? "text-blue-500" : bestVal >= ruleMax * 0.7 ? "text-emerald-500" : bestVal > 0 ? "text-amber-500" : "text-muted-foreground";

  const handleSave = async () => {
    const val = parseInt(scoreInput, 10);
    if (isNaN(val) || val < 0 || val > ruleMax || !reasonInput.trim()) return;
    setSaving(true);
    try {
      await onSave(activeParamKey, rule.key, val, reasonInput);
      setOpen(false);
    } catch {
      alert("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    try {
      await onRemove(activeParamKey);
      setOpen(false);
    } catch {
      alert("Failed to remove override");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("px-5 py-3.5 group", idx > 0 && "border-t border-border/60")}>
      <div className="flex items-center gap-4">
        <div className="w-36 shrink-0">
          <span className="text-sm text-muted-foreground font-medium">{rule.label}</span>
          {isOverridden && (
            <Badge variant="outline" className="ml-2 text-[8px] px-1 py-0 h-4 bg-blue-500/10 text-blue-500 border-blue-500/20">
              Edited by HR
            </Badge>
          )}
        </div>
        
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${pct}%` }} />
        </div>

        <div className="flex items-center justify-end w-24 shrink-0 gap-2">
          {isOverridden && (
            <span className="text-xs text-muted-foreground line-through opacity-50">
              {activeOverride.original}
            </span>
          )}
          <span className={cn("text-sm font-bold tabular-nums", textColor)}>
            {bestVal}/{ruleMax}
          </span>
          <Dialog open={open} onOpenChange={setOpen}>
            <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => {
              setScoreInput(String(bestVal));
              setReasonInput(activeOverride?.reason || "");
              setOpen(true);
            }}>
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Override Score: {rule.label}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label>New Score (0 to {ruleMax})</Label>
                  <Input type="number" min={0} max={ruleMax} value={scoreInput} onChange={e => setScoreInput(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Reason for override</Label>
                  <Textarea value={reasonInput} onChange={e => setReasonInput(e.target.value)} placeholder="Required. Why is this score being changed?" />
                </div>
              </div>
              <DialogFooter className="flex justify-between items-center sm:justify-between w-full">
                {isOverridden ? (
                  <Button variant="destructive" size="sm" onClick={handleRemove} disabled={saving}>
                    Remove Override
                  </Button>
                ) : <div />}
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                  <Button size="sm" onClick={handleSave} disabled={saving || !reasonInput.trim() || isNaN(parseInt(scoreInput, 10))}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      
      {isOverridden && activeOverride.reason && (
        <p className="text-xs text-blue-500/80 mt-1.5 pl-40 leading-relaxed font-medium">
          Override reason: {activeOverride.reason}
        </p>
      )}
      {!isOverridden && logText && (
        <p className="text-xs text-muted-foreground mt-1.5 pl-40 leading-relaxed">{logText}</p>
      )}
    </div>
  );
}
