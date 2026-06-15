"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  RefreshCw, LayoutGrid, Search, X, ExternalLink,
  ChevronDown, Zap, Trash2, Video, Send, Pencil, Check,
} from "lucide-react";
import { SendInterviewDialog } from "@/components/interview/SendInterviewDialog";
import { BulkSendInterviewDialog } from "@/components/interview/BulkSendInterviewDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { KanbanColumn } from "@/components/outreach/KanbanColumn";
import { PipelineListView } from "@/components/jobs/PipelineListView";
import { PipelineTask } from "@/components/outreach/CandidateKanbanCard";
import {
  CandidateStage,
  STAGE_CONFIG,
  ACTIVE_STAGES,
  ARCHIVE_STAGES,
  PIPELINE_STAGES,
  OUTREACH_ACTIVE_STAGES,
} from "@/components/outreach/stage-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  requisitionId: string;
}

type StageMap = Partial<Record<CandidateStage, PipelineTask[]>>;

function matchesQuery(task: PipelineTask, q: string) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    task.name.toLowerCase().includes(needle) ||
    task.currentDesignation.toLowerCase().includes(needle) ||
    task.headline.toLowerCase().includes(needle) ||
    task.currentOrg.toLowerCase().includes(needle)
  );
}

// A transition is "destructive" (needs confirmation) when it would archive
// thread state that can't be cheaply recovered. Three categories:
//   - terminal targets (REJECTED, ARCHIVED) — archives ALL threads
//   - SHORTLISTED from active outreach — archives live threads + restarts
//   - SOURCED from SHORTLISTED or active outreach — archives live threads
function needsConfirmation(fromStage: CandidateStage, toStage: CandidateStage): boolean {
  if (fromStage === toStage) return false;
  if (toStage === "REJECTED" || toStage === "ARCHIVED") return true;
  if (toStage === "SHORTLISTED" && OUTREACH_ACTIVE_STAGES.has(fromStage)) return true;
  if (
    toStage === "SOURCED" &&
    (fromStage === "SHORTLISTED" || OUTREACH_ACTIVE_STAGES.has(fromStage))
  ) {
    return true;
  }
  return false;
}

// Per-target copy for the confirmation dialog. `hasActiveOutreach` tweaks the
// body to be honest about whether anything will actually be archived (a
// candidate sitting in SHORTLISTED has no live threads yet).
function dialogCopy(
  toStage: CandidateStage,
  subjectLabel: string,
  hasActiveOutreach: boolean,
): { title: string; body: string; confirmLabel: string } {
  switch (toStage) {
    case "REJECTED":
      return {
        title: "Reject candidate?",
        body: hasActiveOutreach
          ? `${subjectLabel} will be moved to Rejected. Their active invite/messages will be archived.`
          : `${subjectLabel} will be moved to Rejected.`,
        confirmLabel: "Reject",
      };
    case "ARCHIVED":
      return {
        title: "Archive candidate?",
        body: hasActiveOutreach
          ? `${subjectLabel} will be moved to Archived. Their active invite/messages will be archived.`
          : `${subjectLabel} will be moved to Archived.`,
        confirmLabel: "Archive",
      };
    case "SHORTLISTED":
      return {
        title: "Restart outreach?",
        body: `${subjectLabel} has outreach in progress. Moving back to Shortlisted will archive the current invite/messages and start a fresh sequence, potentially from a different account.`,
        confirmLabel: "Yes, restart",
      };
    case "SOURCED":
      return {
        title: "Move back to Sourced?",
        body: hasActiveOutreach
          ? `${subjectLabel} will be moved back to Sourced. Their active invite/messages will be archived.`
          : `${subjectLabel} will be moved back to Sourced. They will need to be shortlisted again to resume outreach.`,
        confirmLabel: "Yes, move back",
      };
    default:
      return {
        title: "Confirm move?",
        body: `${subjectLabel} will be moved to ${toStage}.`,
        confirmLabel: "Confirm",
      };
  }
}

const REJECT_REASONS = [
  "Not a fit",
  "Overqualified",
  "Underqualified",
  "Salary mismatch",
  "Location constraint",
  "No response",
  "Failed interview",
  "Other",
];

const ARCHIVE_REASONS = [
  "Position filled",
  "On hold",
  "Budget freeze",
  "Candidate withdrew",
  "Duplicate profile",
  "Not a fit",
  "Other",
];

export function PipelineTab({ requisitionId }: Props) {
  const [stages, setStages] = useState<StageMap>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stageScope, setStageScope] = useState<CandidateStage | "ALL">("ALL");
  const [transitionReason, setTransitionReason] = useState("");
  // Free-text reason shown when "Other" is selected. Saved as the actual reason
  // when provided; falls back to "Other" if left blank.
  const [customReason, setCustomReason] = useState("");
  // When rejecting, whether to auto-send the candidate a notification on their
  // outreach channel. Defaults to on; recruiter can opt out per-rejection.
  const [notifyCandidate, setNotifyCandidate] = useState(true);
  const [archiveFilter, setArchiveFilter] = useState<"ALL" | CandidateStage>("ALL");

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [enriching, setEnriching] = useState(false);

  // Starred / favourites (optimistic local state; reseeded on each pipeline fetch)
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [starringBulk, setStarringBulk] = useState(false);

  // Pending destructive transition — set when the recruiter triggers a move
  // that archives thread state (→ REJECTED, → ARCHIVED, → SHORTLISTED from an
  // active stage, → SOURCED from an active stage). Cleared on confirm/cancel.
  const [pendingTransition, setPendingTransition] = useState<
    | {
        kind: "single";
        taskId: string;
        fromStage: CandidateStage;
        toStage: CandidateStage;
        candidateName: string;
        hasActiveOutreach: boolean;
      }
    | {
        kind: "bulk";
        taskIds: string[];
        toStage: CandidateStage;
        activeCount: number; // selected tasks currently in an active outreach stage
        totalCount: number;
      }
    | null
  >(null);

  // Pending GDPR erase — set when recruiter clicks the Delete button.
  const [pendingErase, setPendingErase] = useState<{ taskIds: string[]; count: number } | null>(null);
  const [erasing, setErasing] = useState(false);

  // Pending bulk LinkedIn invite — set when recruiter clicks "Send LinkedIn
  // invite". Sends real connection requests immediately for the SHORTLISTED
  // subset of the selection and creates a thread per candidate.
  const [pendingSendInvite, setPendingSendInvite] = useState<{ taskIds: string[]; count: number } | null>(null);
  const [sendingInvites, setSendingInvites] = useState(false);

  const fetchPipeline = useCallback(async () => {
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/pipeline`);
      if (!res.ok) throw new Error("Failed to load pipeline");
      const data = await res.json();
      setStages(data.stages ?? {});
      setTotal(data.total ?? 0);
      // Reseed starred state from fresh server data
      const ids = new Set<string>();
      for (const stageKey of Object.keys(data.stages ?? {})) {
        for (const t of data.stages[stageKey]) {
          if (t.starred) ids.add(t.id);
        }
      }
      setStarredIds(ids);
    } catch {
      toast.error("Could not load pipeline data");
    } finally {
      setLoading(false);
    }
  }, [requisitionId]);

  useEffect(() => { fetchPipeline(); }, [fetchPipeline]);

  useEffect(() => {
    function onDragStart(e: DragEvent) {
      const id = (e.target as HTMLElement)?.closest("[data-task-id]")?.getAttribute("data-task-id");
      if (id) setDraggingId(id);
    }
    function onDragEnd() { setDraggingId(null); }
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // P1 #48 / EC-13.21 — when the server returns 409 (concurrency conflict)
  // or 422 (transition refused), animate the card back to its original
  // column and toast a specific reason. Plain network failures fall back
  // to the generic "Failed to update stage." Refetches on 409 so the UI
  // reloads the latest snapshot before the recruiter retries.
  async function readStageError(res: Response): Promise<{ status: number; message: string }> {
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* ignore */ }

    if (res.status === 409) {
      return {
        status: 409,
        message: "This candidate was modified by another user. Refreshing…",
      };
    }
    if (res.status === 422) {
      const reason = parsed?.reason ?? "Move not allowed";
      return { status: 422, message: reason };
    }
    return {
      status: res.status,
      message: parsed?.error ?? `Failed (HTTP ${res.status})`,
    };
  }

  // Core API call — called after any confirmation gates have passed.
  async function commitStageChange(taskId: string, fromStage: CandidateStage, newStage: CandidateStage, movedTask: PipelineTask, reason?: string, notify?: boolean) {
    const archiveNote = (newStage === "REJECTED" || newStage === "ARCHIVED") ? (reason ?? null) : movedTask.archiveNote;
    setStages(prev => {
      const next = { ...prev };
      next[fromStage] = (next[fromStage] ?? []).filter(t => t.id !== taskId);
      next[newStage] = [{ ...movedTask, stage: newStage, stageUpdatedAt: new Date().toISOString(), archiveNote }, ...(next[newStage] ?? [])];
      return next;
    });

    try {
      const res = await fetch(
        `/api/requisitions/${requisitionId}/candidates/${taskId}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage: newStage, ...(reason ? { reason } : {}), ...(notify === false ? { notify: false } : {}) }) },
      );
      if (!res.ok) {
        const { status, message } = await readStageError(res);
        setStages(prev => {
          const next = { ...prev };
          next[newStage] = (next[newStage] ?? []).filter(t => t.id !== taskId);
          next[fromStage] = [movedTask, ...(next[fromStage] ?? [])];
          return next;
        });
        if (status === 409) { toast.warning(message); fetchPipeline(); }
        else toast.error(message);
        return;
      }
      try {
        const updated = await res.json();
        if (updated?.stageUpdatedAt) {
          setStages(prev => {
            const next = { ...prev };
            next[newStage] = (next[newStage] ?? []).map(t =>
              t.id === taskId ? ({ ...t, stageUpdatedAt: updated.stageUpdatedAt } as PipelineTask) : t,
            );
            return next;
          });
        }
      } catch { /* best-effort */ }
      toast.success(`Moved to ${STAGE_CONFIG[newStage].label}`);
    } catch {
      setStages(prev => {
        const next = { ...prev };
        next[newStage] = (next[newStage] ?? []).filter(t => t.id !== taskId);
        next[fromStage] = [movedTask, ...(next[fromStage] ?? [])];
        return next;
      });
      toast.error("Failed to update stage");
    }
  }

  async function handleStageChange(taskId: string, newStage: CandidateStage) {
    let fromStage: CandidateStage | null = null;
    let movedTask: PipelineTask | null = null;

    for (const stage of PIPELINE_STAGES) {
      const found = stages[stage]?.find(t => t.id === taskId);
      if (found) { fromStage = stage; movedTask = found; break; }
    }

    if (!fromStage || !movedTask || fromStage === newStage) return;

    if (needsConfirmation(fromStage, newStage)) {
      setPendingTransition({
        kind: "single",
        taskId,
        fromStage,
        toStage: newStage,
        candidateName: movedTask.name || "this candidate",
        hasActiveOutreach: OUTREACH_ACTIVE_STAGES.has(fromStage),
      });
      return;
    }

    await commitStageChange(taskId, fromStage, newStage, movedTask);
  }

  // Selection helpers
  function handleSelect(taskId: string, selected: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (selected) next.add(taskId); else next.delete(taskId);
      return next;
    });
  }

  function handleColumnSelectAll(taskIds: string[]) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      taskIds.forEach(id => next.add(id));
      return next;
    });
  }

  function handleColumnDeselectAll(taskIds: string[]) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      taskIds.forEach(id => next.delete(id));
      return next;
    });
  }

  function clearSelection() { setSelectedIds(new Set()); }

  // Interview send dialogs (single composer for a Replied card; bulk for selection).
  const [interviewTaskId, setInterviewTaskId] = useState<string | null>(null);
  const [bulkInterviewOpen, setBulkInterviewOpen] = useState(false);

  async function toggleStar(taskId: string) {
    const next = !starredIds.has(taskId);
    setStarredIds(prev => {
      const s = new Set(prev);
      if (next) s.add(taskId); else s.delete(taskId);
      return s;
    });
    try {
      await fetch(`/api/tasks/${taskId}/star`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: next }),
      });
    } catch {
      setStarredIds(prev => {
        const s = new Set(prev);
        if (next) s.delete(taskId); else s.add(taskId);
        return s;
      });
    }
  }

  async function handleBulkStar() {
    const taskIds = [...selectedIds];
    if (!taskIds.length) return;
    // If any are unstarred, star all; if all already starred, unstar all.
    const allStarred = taskIds.every(id => starredIds.has(id));
    const nextStarred = !allStarred;
    setStarredIds(prev => {
      const s = new Set(prev);
      for (const id of taskIds) { if (nextStarred) s.add(id); else s.delete(id); }
      return s;
    });
    setStarringBulk(true);
    try {
      await Promise.all(
        taskIds.map(id =>
          fetch(`/api/tasks/${id}/star`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ starred: nextStarred }),
          })
        )
      );
      toast.success(nextStarred ? `Starred ${taskIds.length} candidate${taskIds.length !== 1 ? "s" : ""}` : `Unstarred ${taskIds.length} candidate${taskIds.length !== 1 ? "s" : ""}`);
    } catch {
      // revert
      setStarredIds(prev => {
        const s = new Set(prev);
        for (const id of taskIds) { if (nextStarred) s.delete(id); else s.add(id); }
        return s;
      });
      toast.error("Failed to update favourites");
    } finally {
      setStarringBulk(false);
    }
  }

  // Compute selected tasks by stage for bulk actions
  const selectedByStage = useMemo(() => {
    const map: Partial<Record<CandidateStage, string[]>> = {};
    for (const stage of PIPELINE_STAGES) {
      const ids = (stages[stage] ?? []).filter(t => selectedIds.has(t.id)).map(t => t.id);
      if (ids.length > 0) map[stage] = ids;
    }
    return map;
  }, [stages, selectedIds]);

  // Stage-awareness nudge for bulk interview send (#8): interviews make sense for
  // candidates who've engaged (REPLIED / INTERVIEW). Warn when the selection
  // includes earlier-stage candidates so the recruiter isn't blindly blasting a
  // link to people who never replied.
  const interviewBulkStageNote = useMemo(() => {
    const ENGAGED = new Set<CandidateStage>(["REPLIED", "INTERVIEW"]);
    let early = 0;
    for (const [stage, ids] of Object.entries(selectedByStage)) {
      if (!ENGAGED.has(stage as CandidateStage)) early += ids?.length ?? 0;
    }
    return early > 0
      ? `${early} of ${selectedIds.size} selected ${early === 1 ? "candidate hasn't" : "candidates haven't"} replied yet — sending an interview link may be premature.`
      : null;
  }, [selectedByStage, selectedIds]);

  // P1 #47 / EC-11.17 — single bulk endpoint replaces parallel PATCH calls.
  // Server processes each task in its own transaction and returns per-task
  // outcomes; UI reverts only the cards that failed.
  // Core bulk API — called after any confirmation gates have passed.
  async function executeBulkMove(taskIds: string[], newStage: CandidateStage, reason?: string, notify?: boolean) {
    // Snapshot original stage per task so we can selectively revert failures.
    // Same reasoning as handleStageChange: we don't send `expected` (per-task
    // If-Match) because the only realistic "concurrent edit" is the system's
    // own rollup, and recruiter intent should always win over that.
    const originalStageByTask: Record<string, CandidateStage> = {};
    for (const id of taskIds) {
      for (const s of PIPELINE_STAGES) {
        const found = (stages[s] ?? []).find(t => t.id === id);
        if (found) {
          originalStageByTask[id] = s;
          break;
        }
      }
    }

    const bulkArchiveNote = (newStage === "REJECTED" || newStage === "ARCHIVED") ? (reason ?? null) : null;

    // Optimistic UI: move all selected to the target column.
    setStages(prev => {
      const next = { ...prev };
      for (const id of taskIds) {
        for (const s of PIPELINE_STAGES) {
          const idx = (next[s] ?? []).findIndex(t => t.id === id);
          if (idx !== -1) {
            const task = next[s]![idx];
            next[s] = (next[s] ?? []).filter(t => t.id !== id);
            next[newStage] = [
              { ...task, stage: newStage, stageUpdatedAt: new Date().toISOString(), archiveNote: bulkArchiveNote ?? task.archiveNote },
              ...(next[newStage] ?? []),
            ];
            break;
          }
        }
      }
      return next;
    });
    clearSelection();

    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds, stage: newStage, ...(reason ? { reason } : {}), ...(notify === false ? { notify: false } : {}) }),
      });
      if (!res.ok) {
        // Hard failure — revert everything.
        setStages(prev => {
          const next = { ...prev };
          for (const id of taskIds) {
            const orig = originalStageByTask[id];
            if (!orig) continue;
            const idx = (next[newStage] ?? []).findIndex(t => t.id === id);
            if (idx === -1) continue;
            const task = next[newStage]![idx];
            next[newStage] = (next[newStage] ?? []).filter(t => t.id !== id);
            next[orig] = [{ ...task, stage: orig }, ...(next[orig] ?? [])];
          }
          return next;
        });
        toast.error("Failed to move candidates");
        return;
      }

      const data = await res.json();
      const outcomes: Array<{
        taskId: string;
        ok: boolean;
        kind?: string;
        reason?: string;
        task?: { stageUpdatedAt: string };
      }> = data.outcomes ?? [];

      const failed = outcomes.filter(o => !o.ok);

      // Revert only the failed tasks; leave the rest in their target column.
      // Update stageUpdatedAt on the successful ones for next-drag concurrency.
      setStages(prev => {
        const next = { ...prev };
        for (const o of outcomes) {
          if (o.ok) {
            const newTs = o.task?.stageUpdatedAt;
            if (!newTs) continue;
            next[newStage] = (next[newStage] ?? []).map(t =>
              t.id === o.taskId ? ({ ...t, stageUpdatedAt: newTs } as PipelineTask) : t,
            );
          } else {
            const orig = originalStageByTask[o.taskId];
            if (!orig) continue;
            const idx = (next[newStage] ?? []).findIndex(t => t.id === o.taskId);
            if (idx === -1) continue;
            const task = next[newStage]![idx];
            next[newStage] = (next[newStage] ?? []).filter(t => t.id !== o.taskId);
            next[orig] = [{ ...task, stage: orig }, ...(next[orig] ?? [])];
          }
        }
        return next;
      });

      const okCount = outcomes.length - failed.length;
      if (failed.length === 0) {
        toast.success(`Moved ${okCount} candidate${okCount !== 1 ? "s" : ""} to ${STAGE_CONFIG[newStage].label}`);
      } else {
        const conflicts = failed.filter(f => f.kind === "concurrency_conflict").length;
        const refused = failed.filter(f => f.kind === "transition_refused").length;
        const otherErrors = failed.length - conflicts - refused;
        const parts: string[] = [];
        if (okCount > 0) parts.push(`${okCount} moved`);
        if (conflicts > 0) parts.push(`${conflicts} modified by another user`);
        if (refused > 0) parts.push(`${refused} not allowed`);
        if (otherErrors > 0) parts.push(`${otherErrors} failed`);
        toast.warning(parts.join(", "));
        if (conflicts > 0) fetchPipeline();
      }
    } catch {
      // Network error: revert everything to be safe.
      setStages(prev => {
        const next = { ...prev };
        for (const id of taskIds) {
          const orig = originalStageByTask[id];
          if (!orig) continue;
          const idx = (next[newStage] ?? []).findIndex(t => t.id === id);
          if (idx === -1) continue;
          const task = next[newStage]![idx];
          next[newStage] = (next[newStage] ?? []).filter(t => t.id !== id);
          next[orig] = [{ ...task, stage: orig }, ...(next[orig] ?? [])];
        }
        return next;
      });
      toast.error("Failed to move candidates");
    }
  }

  async function handleBulkMove(newStage: CandidateStage) {
    const taskIds = [...selectedIds];
    if (!taskIds.length) return;

    // Determine if any selected task would trigger a destructive transition
    // into newStage. For SHORTLISTED/SOURCED we count tasks in OUTREACH_ACTIVE
    // (or SHORTLISTED, for SOURCED). For REJECTED/ARCHIVED every selected task
    // counts (terminal targets are always destructive).
    const needsBulkConfirm =
      newStage === "REJECTED" ||
      newStage === "ARCHIVED" ||
      newStage === "SHORTLISTED" ||
      newStage === "SOURCED";

    if (needsBulkConfirm) {
      const activeCount = taskIds.filter(id => {
        for (const s of OUTREACH_ACTIVE_STAGES) {
          if (stages[s]?.some(t => t.id === id)) return true;
        }
        // For SOURCED, SHORTLISTED tasks also count as "will lose state".
        if (newStage === "SOURCED" && stages.SHORTLISTED?.some(t => t.id === id)) return true;
        return false;
      }).length;

      // For REJECTED/ARCHIVED, always confirm — even SOURCED candidates being
      // terminally closed deserves an "are you sure".
      const triggerForTerminal = newStage === "REJECTED" || newStage === "ARCHIVED";

      if (activeCount > 0 || triggerForTerminal) {
        setPendingTransition({
          kind: "bulk",
          taskIds,
          toStage: newStage,
          activeCount,
          totalCount: taskIds.length,
        });
        return;
      }
    }

    await executeBulkMove(taskIds, newStage);
  }

  async function handleBulkEnrich() {
    const taskIds = [...selectedIds];
    if (!taskIds.length) return;
    setEnriching(true);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const d = await res.json();
      if (res.status === 402) {
        toast.error("Airscale credit limit reached");
      } else if (!res.ok) {
        toast.error(d.error ?? "Enrichment failed");
      } else {
        toast.success(`Enriched ${d.enriched}/${d.total} contacts${d.failed ? ` (${d.failed} failed)` : ""}`);
      }
    } catch {
      toast.error("Network error during enrichment");
    } finally {
      setEnriching(false);
    }
  }

  async function commitErase(taskIds: string[]) {
    setErasing(true);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-erase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Delete failed");
        return;
      }
      // Remove erased tasks from local state
      setStages(prev => {
        const next = { ...prev };
        for (const stage of PIPELINE_STAGES) {
          if (next[stage]) {
            next[stage] = next[stage]!.filter(t => !taskIds.includes(t.id));
          }
        }
        return next;
      });
      setTotal(prev => Math.max(0, prev - (d.erased ?? 0)));
      clearSelection();
      toast.success(`${d.erased} candidate${d.erased !== 1 ? "s" : ""} permanently deleted`);
    } catch {
      toast.error("Network error — delete failed");
    } finally {
      setErasing(false);
    }
  }

  // Send real LinkedIn invites for the SHORTLISTED candidates in the selection
  // only — the endpoint also guards on stage, but we scope the UI so the dialog
  // count and the action match what the recruiter sees.
  function handleBulkSendInvite() {
    const ids = selectedByStage["SHORTLISTED"] ?? [];
    if (!ids.length) {
      toast.message("No shortlisted candidates selected", {
        description: "LinkedIn invites can only be sent to candidates in the Shortlisted stage.",
      });
      return;
    }
    setPendingSendInvite({ taskIds: ids, count: ids.length });
  }

  async function commitSendInvite(taskIds: string[]) {
    setSendingInvites(true);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-send-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Failed to send invites");
        return;
      }
      const sent = d.sent ?? 0;
      const skipped = d.skipped ?? 0;
      const failed = d.failed ?? 0;
      if (sent === 0) {
        toast.message("No invites sent", {
          description: `${skipped} skipped, ${failed} failed.`,
        });
      } else {
        const parts = [`Sent ${sent} invite${sent !== 1 ? "s" : ""}`];
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (failed > 0) parts.push(`${failed} failed`);
        toast.success(parts.join(" · "));
      }
      clearSelection();
      fetchPipeline();
    } catch {
      toast.error("Network error while sending invites");
    } finally {
      setSendingInvites(false);
    }
  }

  // Reset scope whenever the query is cleared so the board returns to normal.
  useEffect(() => { if (!query) setStageScope("ALL"); }, [query]);

  // matchCounts: per-stage hit count for the current query (used by scope chips).
  // filteredStages: applies both query and scope — what each column actually renders.
  const { filteredStages, matchCounts } = useMemo(() => {
    if (!query) return { filteredStages: stages, matchCounts: null };

    const counts: Partial<Record<CandidateStage, number>> = {};
    const out: StageMap = {};
    for (const stage of PIPELINE_STAGES) {
      const matched = (stages[stage] ?? []).filter(t => matchesQuery(t, query));
      counts[stage] = matched.length;
      out[stage] = (stageScope !== "ALL" && stageScope !== stage) ? [] : matched;
    }
    return { filteredStages: out, matchCounts: counts };
  }, [stages, query, stageScope]);

  const archiveRows = useMemo(() => {
    const rows: PipelineTask[] = [];
    for (const stage of ARCHIVE_STAGES) {
      if (archiveFilter !== "ALL" && archiveFilter !== stage) continue;
      for (const t of stages[stage] ?? []) {
        if (matchesQuery(t, query)) rows.push(t);
      }
    }
    return rows.sort((a, b) => new Date(b.stageUpdatedAt).getTime() - new Date(a.stageUpdatedAt).getTime());
  }, [stages, query, archiveFilter]);

  const archiveTotal = ARCHIVE_STAGES.reduce((n, s) => n + (stages[s]?.length ?? 0), 0);
  const showCheckboxes = selectedIds.size > 0;

  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {ACTIVE_STAGES.map(stage => (
          <div key={stage} className="flex flex-col w-[272px] shrink-0 gap-2">
            <Skeleton className="h-10 rounded-xl" />
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <Tabs defaultValue="board" className="flex flex-col flex-1 min-h-0 gap-3">
        <div className="flex items-center justify-between gap-3 shrink-0 flex-wrap">
          <div className="flex items-center gap-3">
            <TabsList>
              <TabsTrigger value="board">Board</TabsTrigger>
              <TabsTrigger value="list">List</TabsTrigger>
              <TabsTrigger value="archive" className="gap-1.5">
                Archive
                {archiveTotal > 0 && (
                  <span className="rounded-full bg-muted-foreground/15 text-xs px-1.5 font-semibold">
                    {archiveTotal}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
              <LayoutGrid className="h-4 w-4" />
              <span className="font-medium text-foreground">{total}</span>
              <span>in pipeline</span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search name, title, company..."
                  className="pl-8 pr-8 h-8 text-sm w-64"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchPipeline}
                className="gap-1.5 text-xs text-muted-foreground h-8 px-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>

            {/* Stage scope chips — only visible while a query is active */}
            {query && matchCounts && (
              <div className="flex items-center gap-1 flex-wrap justify-end">
                <button
                  onClick={() => setStageScope("ALL")}
                  className={cn(
                    "h-5.5 px-2 rounded-full text-[11px] font-medium border transition-colors",
                    stageScope === "ALL"
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                  )}
                >
                  All&nbsp;
                  <span className="opacity-70">
                    {ACTIVE_STAGES.reduce((n, s) => n + (matchCounts[s] ?? 0), 0)}
                  </span>
                </button>
                {ACTIVE_STAGES.map(stage => {
                  const count = matchCounts[stage] ?? 0;
                  if (count === 0) return null;
                  return (
                    <button
                      key={stage}
                      onClick={() => setStageScope(stage)}
                      className={cn(
                        "h-5.5 px-2 rounded-full text-[11px] font-medium border transition-colors flex items-center gap-1",
                        stageScope === stage
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STAGE_CONFIG[stage].dot)} />
                      {STAGE_CONFIG[stage].label}&nbsp;<span className="opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <TabsContent value="board" className="flex-1 min-h-0 mt-0">
          <div className="flex gap-3 overflow-x-auto pb-4 h-full">
            {ACTIVE_STAGES.map(stage => (
              <KanbanColumn
                key={stage}
                stage={stage}
                config={STAGE_CONFIG[stage]}
                tasks={filteredStages[stage] ?? []}
                totalCount={(stages[stage] ?? []).length}
                onStageChange={handleStageChange}
                draggingId={draggingId}
                requisitionId={requisitionId}
                selectedIds={selectedIds}
                onSelect={handleSelect}
                onColumnSelectAll={handleColumnSelectAll}
                onColumnDeselectAll={handleColumnDeselectAll}
                showCheckboxes={showCheckboxes}
                starredIds={starredIds}
                onStar={toggleStar}
                onSendInterview={setInterviewTaskId}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="list" className="flex-1 min-h-0 mt-0">
          <PipelineListView
            stages={stages}
            scopeStages={ACTIVE_STAGES}
            globalQuery={query}
            onStageChange={handleStageChange}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onSelectAll={handleColumnSelectAll}
            onDeselectAll={handleColumnDeselectAll}
          />
        </TabsContent>

        <TabsContent value="archive" className="flex-1 min-h-0 mt-0">
          <div className="flex flex-col h-full gap-3">
            <div className="flex items-center gap-2 shrink-0">
              {(["ALL", ...ARCHIVE_STAGES] as const).map(f => {
                const label = f === "ALL" ? "All" : STAGE_CONFIG[f].label;
                const count = f === "ALL" ? archiveTotal : stages[f]?.length ?? 0;
                const active = archiveFilter === f;
                return (
                  <button
                    key={f}
                    onClick={() => setArchiveFilter(f)}
                    className={cn(
                      "flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-medium transition-colors border",
                      active
                        ? "bg-foreground text-background border-foreground"
                        : "bg-background text-muted-foreground border-border hover:text-foreground",
                    )}
                  >
                    {f !== "ALL" && <span className={cn("h-1.5 w-1.5 rounded-full", STAGE_CONFIG[f].dot)} />}
                    {label}
                    <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", active ? "bg-background/20" : "bg-muted")}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-background">
              {archiveRows.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
                  {query ? "No matches in archive" : "No archived candidates"}
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {archiveRows.map(task => (
                    <ArchiveRow key={task.id} task={task} requisitionId={requisitionId} onStageChange={handleStageChange} onNoteChange={(id, note) => {
                      setStages(prev => {
                        const next = { ...prev };
                        for (const s of ["REJECTED", "ARCHIVED"] as CandidateStage[]) {
                          if (next[s]) next[s] = next[s]!.map(t => t.id === id ? { ...t, archiveNote: note } : t);
                        }
                        return next;
                      });
                    }} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Destructive-transition confirmation dialog */}
      <Dialog
        open={!!pendingTransition}
        onOpenChange={open => { if (!open) { setPendingTransition(null); setTransitionReason(""); setCustomReason(""); setNotifyCandidate(true); } }}
      >
        <DialogContent className="max-w-sm">
          {pendingTransition && (() => {
            const subject =
              pendingTransition.kind === "single"
                ? pendingTransition.candidateName
                : `${pendingTransition.totalCount} candidate${pendingTransition.totalCount !== 1 ? "s" : ""}`;
            const hasActive =
              pendingTransition.kind === "single"
                ? pendingTransition.hasActiveOutreach
                : pendingTransition.activeCount > 0;
            const copy = dialogCopy(pendingTransition.toStage, subject, hasActive);
            const bulkSuffix =
              pendingTransition.kind === "bulk" && pendingTransition.activeCount > 0
                ? ` (${pendingTransition.activeCount} have active outreach)`
                : "";
            const needsReason =
              pendingTransition.toStage === "REJECTED" || pendingTransition.toStage === "ARCHIVED";
            const reasonOptions =
              pendingTransition.toStage === "REJECTED" ? REJECT_REASONS : ARCHIVE_REASONS;
            // A rejection notification only goes out when there's a live
            // conversation to send it through, so only surface the toggle when
            // the candidate(s) actually have active outreach.
            const canNotify = pendingTransition.toStage === "REJECTED" && hasActive;
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{copy.title}</DialogTitle>
                  <DialogDescription className="pt-1">
                    {copy.body}{bulkSuffix}
                  </DialogDescription>
                </DialogHeader>

                {needsReason && (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-xs text-muted-foreground font-medium">Reason <span className="opacity-50">(optional)</span></p>
                    <Select value={transitionReason} onValueChange={setTransitionReason}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select a reason…" />
                      </SelectTrigger>
                      <SelectContent>
                        {reasonOptions.map(r => (
                          <SelectItem key={r} value={r} className="text-sm">{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {transitionReason === "Other" && (
                      <Textarea
                        autoFocus
                        value={customReason}
                        onChange={e => setCustomReason(e.target.value)}
                        placeholder="Describe the reason…"
                        rows={2}
                        className="text-sm"
                      />
                    )}
                  </div>
                )}

                {canNotify && (
                  <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700/60 dark:bg-amber-950/40">
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <Checkbox
                        checked={notifyCandidate}
                        onCheckedChange={v => setNotifyCandidate(v === true)}
                        className="mt-0.5"
                      />
                      <span className="text-xs leading-relaxed">
                        <span className="font-medium text-amber-900 dark:text-amber-200">
                          Notify {pendingTransition.kind === "bulk" ? "candidates" : "the candidate"} automatically
                        </span>
                        <span className="block text-amber-800/80 dark:text-amber-200/70">
                          A message will be sent on their existing outreach channel
                          {pendingTransition.kind === "bulk" ? ` (the ${pendingTransition.activeCount} with active outreach)` : ""}.
                          Uncheck to reject silently and contact them yourself.
                        </span>
                      </span>
                    </label>
                  </div>
                )}

                <DialogFooter className="gap-2 sm:gap-0">
                  <Button variant="outline" size="sm" onClick={() => { setPendingTransition(null); setTransitionReason(""); setCustomReason(""); setNotifyCandidate(true); }}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      const p = pendingTransition;
                      // "Other" → use the typed text, or fall back to "Other" if blank.
                      const r =
                        transitionReason === "Other"
                          ? (customReason.trim() || "Other")
                          : (transitionReason || undefined);
                      // Only meaningful for REJECTED with active outreach; harmless otherwise.
                      const notify = canNotify ? notifyCandidate : undefined;
                      setPendingTransition(null);
                      setTransitionReason("");
                      setCustomReason("");
                      setNotifyCandidate(true);
                      if (!p) return;
                      if (p.kind === "single") {
                        const movedTask = stages[p.fromStage]?.find(t => t.id === p.taskId);
                        if (movedTask) await commitStageChange(p.taskId, p.fromStage, p.toStage, movedTask, r, notify);
                      } else {
                        await executeBulkMove(p.taskIds, p.toStage, r, notify);
                      }
                    }}
                  >
                    {copy.confirmLabel}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* GDPR erasure confirmation dialog */}
      <Dialog
        open={!!pendingErase}
        onOpenChange={open => { if (!open) setPendingErase(null); }}
      >
        <DialogContent className="max-w-sm">
          {pendingErase && (
            <>
              <DialogHeader>
                <DialogTitle>Permanently delete {pendingErase.count} candidate{pendingErase.count !== 1 ? "s" : ""}?</DialogTitle>
                <DialogDescription className="pt-1">
                  This will erase all data — profile, outreach history, notes, and stage history — from the database. <strong>This cannot be undone.</strong>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" size="sm" onClick={() => setPendingErase(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={erasing}
                  onClick={async () => {
                    const ids = pendingErase.taskIds;
                    setPendingErase(null);
                    await commitErase(ids);
                  }}
                >
                  {erasing ? "Deleting…" : "Delete permanently"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk send-invite confirmation dialog */}
      <Dialog
        open={!!pendingSendInvite}
        onOpenChange={open => { if (!open) setPendingSendInvite(null); }}
      >
        <DialogContent className="max-w-sm">
          {pendingSendInvite && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Send LinkedIn invite to {pendingSendInvite.count} candidate{pendingSendInvite.count !== 1 ? "s" : ""}?
                </DialogTitle>
                <DialogDescription className="pt-1">
                  This sends real LinkedIn connection requests <strong>immediately</strong> from your
                  sending account and creates an outreach thread for each. Only Shortlisted
                  candidates are included. Mind your daily LinkedIn limits.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" size="sm" onClick={() => setPendingSendInvite(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={sendingInvites}
                  onClick={async () => {
                    const ids = pendingSendInvite.taskIds;
                    setPendingSendInvite(null);
                    await commitSendInvite(ids);
                  }}
                >
                  {sendingInvites ? "Sending…" : `Send ${pendingSendInvite.count} invite${pendingSendInvite.count !== 1 ? "s" : ""}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-background border border-border rounded-2xl shadow-2xl px-4 py-2.5 animate-in slide-in-from-bottom-2 duration-150">
          <span className="text-sm font-semibold text-foreground whitespace-nowrap">
            {selectedIds.size} selected
          </span>

          <div className="w-px h-5 bg-border mx-1" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                Move to
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top" className="w-44 mb-1">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Move {selectedIds.size} to…</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PIPELINE_STAGES.map(stage => (
                <DropdownMenuItem
                  key={stage}
                  onClick={() => handleBulkMove(stage)}
                  className="gap-2 text-xs cursor-pointer"
                >
                  <span className={cn("h-2 w-2 rounded-full shrink-0", STAGE_CONFIG[stage].dot)} />
                  {STAGE_CONFIG[stage].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={handleBulkEnrich}
            disabled={enriching}
          >
            {enriching ? <><RefreshCw className="h-3 w-3 animate-spin" />Enriching…</> : <><Zap className="h-3 w-3" />Enrich Contacts</>}
          </Button>

          {(() => {
            const allStarred = [...selectedIds].every(id => starredIds.has(id));
            return (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 text-xs gap-1",
                  allStarred ? "text-amber-500 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20" : ""
                )}
                onClick={handleBulkStar}
                disabled={starringBulk}
              >
                <svg
                  className={cn("h-3 w-3", allStarred ? "fill-amber-500" : "fill-none")}
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                </svg>
                {allStarred ? "Unstar" : "Star"}
              </Button>
            );
          })()}

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setBulkInterviewOpen(true)}
          >
            <Video className="h-3 w-3" />
            Send interview link
          </Button>

          {(() => {
            const shortlistedCount = (selectedByStage["SHORTLISTED"] ?? []).length;
            return (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={handleBulkSendInvite}
                disabled={sendingInvites || shortlistedCount === 0}
                title={shortlistedCount === 0 ? "Select Shortlisted candidates to send LinkedIn invites" : undefined}
              >
                {sendingInvites
                  ? <><RefreshCw className="h-3 w-3 animate-spin" />Sending…</>
                  : <><Send className="h-3 w-3" />Send LinkedIn invite{shortlistedCount > 0 ? ` (${shortlistedCount})` : ""}</>}
              </Button>
            );
          })()}

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setPendingErase({ taskIds: [...selectedIds], count: selectedIds.size })}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>

          <button
            onClick={clearSelection}
            className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Single-send composer — opened from a Replied card's CTA. */}
      <SendInterviewDialog
        taskId={interviewTaskId ?? ""}
        requisitionId={requisitionId}
        open={interviewTaskId !== null}
        onOpenChange={(o) => { if (!o) setInterviewTaskId(null); }}
        onSent={() => { setInterviewTaskId(null); fetchPipeline(); }}
      />

      {/* Bulk send — opened from the floating selection bar. */}
      <BulkSendInterviewDialog
        requisitionId={requisitionId}
        taskIds={[...selectedIds]}
        open={bulkInterviewOpen}
        onOpenChange={setBulkInterviewOpen}
        stageNote={interviewBulkStageNote}
        onDone={() => { setBulkInterviewOpen(false); clearSelection(); fetchPipeline(); }}
      />
    </div>
  );
}

const AVATAR_GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-emerald-500 to-teal-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-cyan-500 to-blue-600",
  "from-fuchsia-500 to-purple-600",
];

function pickGradient(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

function getInitials(name: string) {
  return name.split(" ").slice(0, 2).map(n => n[0] ?? "").join("").toUpperCase();
}

const REASON_OPTIONS: Record<"REJECTED" | "ARCHIVED", string[]> = {
  REJECTED: ["Not a fit", "Overqualified", "Underqualified", "Salary mismatch", "Location constraint", "No response", "Failed interview", "Other"],
  ARCHIVED: ["Position filled", "On hold", "Budget freeze", "Candidate withdrew", "Duplicate profile", "Not a fit", "Other"],
};

function ArchiveRow({
  task,
  requisitionId,
  onStageChange,
  onNoteChange,
}: {
  task: PipelineTask;
  requisitionId: string;
  onStageChange: (taskId: string, stage: CandidateStage) => void;
  onNoteChange: (taskId: string, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const name = task.name || "Unknown";
  const config = STAGE_CONFIG[task.stage];
  const scoreCls =
    task.recommendation === "Strong Fit"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : task.recommendation === "Moderate Fit"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "border-rose-500/40 bg-rose-500/10 text-rose-500";

  const options = REASON_OPTIONS[task.stage as "REJECTED" | "ARCHIVED"] ?? REASON_OPTIONS.REJECTED;

  async function saveNote(note: string | null) {
    setSaving(true);
    try {
      await fetch(`/api/requisitions/${requisitionId}/candidates/${task.id}/archive-note`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      onNoteChange(task.id, note);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors group/row">
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarImage src={task.profilePictureUrl ? `/api/proxy-image?url=${encodeURIComponent(task.profilePictureUrl)}` : undefined} alt={name} />
        <AvatarFallback className={cn("text-white font-bold text-xs bg-linear-to-br", pickGradient(name))}>
          {getInitials(name)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <Link
          href={`/candidates/${task.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-foreground truncate hover:text-primary hover:underline underline-offset-2 block"
        >
          {name}
        </Link>
        <p className="text-xs text-muted-foreground truncate">
          {task.currentDesignation || task.headline || "—"}
          {task.currentOrg && <span> · {task.currentOrg}</span>}
        </p>

        {editing ? (
          <div className="flex items-center gap-1.5 mt-1" onClick={e => e.stopPropagation()}>
            <Select
              defaultValue={task.archiveNote ?? ""}
              onValueChange={val => saveNote(val || null)}
              disabled={saving}
            >
              <SelectTrigger className="h-6 text-xs py-0 px-2 w-44">
                <SelectValue placeholder="Select reason…" />
              </SelectTrigger>
              <SelectContent>
                {options.map(r => (
                  <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(false)}
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : task.archiveNote ? (
          <div className="flex items-center gap-1 mt-0.5 group/note">
            <p className="text-xs text-muted-foreground/70 truncate" title={task.archiveNote}>
              {task.archiveNote}
            </p>
            <button
              className="opacity-0 group-hover/note:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0"
              onClick={() => setEditing(true)}
              aria-label="Edit reason"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            className="text-xs text-muted-foreground/40 hover:text-muted-foreground mt-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity"
            onClick={() => setEditing(true)}
          >
            + Add reason
          </button>
        )}
      </div>

      {task.scorePercent !== null && (
        <Badge variant="outline" className={cn("text-xs font-bold h-5 px-2 py-0 rounded-full shrink-0", scoreCls)}>
          {Math.round(task.scorePercent)}%
        </Badge>
      )}

      <Badge
        variant="outline"
        className={cn("gap-1.5 text-xs h-6 px-2 rounded-full shrink-0", config.border, config.headerBg, config.headerText)}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
        {config.label}
      </Badge>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground shrink-0"
        onClick={() => onStageChange(task.id, "SOURCED")}
      >
        Restore
      </Button>

      {task.url && (
        <a
          href={task.url}
          target="_blank"
          rel="noopener noreferrer"
          className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          aria-label="Open LinkedIn"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </li>
  );
}
