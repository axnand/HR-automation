"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Briefcase, Building2, ExternalLink, MoreHorizontal, Send, Loader2, MessageSquare, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChannelStatusPopover } from "./ChannelStatusPopover";
import type { ThreadForDisplay } from "@/lib/channel-display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CandidateStage, STAGE_CONFIG, PIPELINE_STAGES } from "./stage-config";

export interface PipelineTask {
  id: string;
  url: string;
  stage: CandidateStage;
  stageUpdatedAt: string;
  name: string;
  headline: string;
  currentOrg: string;
  currentDesignation: string;
  totalExperienceYears: number | null;
  location: string;
  scorePercent: number | null;
  recommendation: string | null;
  profilePictureUrl: string | null;
  publicId: string | null;
  source: string;
  addedAt: string;
  remarks: string | null;
  archiveNote: string | null;
  starred: boolean;
  outreachMessages?: { channel: string; status: string }[];
  channelThreads?: ThreadForDisplay[];
}

interface Props {
  task: PipelineTask;
  requisitionId: string;
  onStageChange: (taskId: string, newStage: CandidateStage) => void;
  isDragging?: boolean;
  isSelected?: boolean;
  onSelect?: (taskId: string, selected: boolean) => void;
  showCheckbox?: boolean;
  isStarred?: boolean;
  onStar?: (taskId: string) => void;
  /** Opens the single-send interview composer for this candidate (REPLIED CTA). */
  onSendInterview?: (taskId: string) => void;
}

function getInitials(name: string) {
  return name.split(" ").slice(0, 2).map(n => n[0] ?? "").join("").toUpperCase();
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

export function CandidateKanbanCard({
  task,
  requisitionId,
  onStageChange,
  isDragging,
  isSelected = false,
  onSelect,
  showCheckbox = false,
  isStarred = false,
  onStar,
  onSendInterview,
}: Props) {
  const [sendingInvite, setSendingInvite] = useState(false);
  const [sendingDm, setSendingDm] = useState(false);
  const name = task.name || "Unknown";
  // Interview link already delivered? Derived from the timeline (OutreachMessage
  // channel "<CHANNEL>_INTERVIEW") the send primitive writes — no extra fetch.
  const interviewSent = (task.outreachMessages ?? []).some(m => m.channel?.includes("INTERVIEW"));
  const gradient = pickGradient(name);
  const moveTargets = PIPELINE_STAGES.filter(s => s !== task.stage);

  const scoreCls =
    task.recommendation === "Strong Fit"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : task.recommendation === "Moderate Fit"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "border-rose-500/40 bg-rose-500/10 text-rose-500";

  const threads = task.channelThreads ?? [];

  async function handleSendInvite(e: React.MouseEvent) {
    e.stopPropagation();
    setSendingInvite(true);
    try {
      const res = await fetch(
        `/api/requisitions/${requisitionId}/candidates/${task.id}/send-invite`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send invite");
      onStageChange(task.id, "CONTACT_REQUESTED");
      toast.success("LinkedIn request sent");
    } catch (err: any) {
      toast.error(err.message || "Failed to send LinkedIn request");
    } finally {
      setSendingInvite(false);
    }
  }

  async function handleSendDm(e: React.MouseEvent) {
    e.stopPropagation();
    setSendingDm(true);
    try {
      const res = await fetch(
        `/api/requisitions/${requisitionId}/candidates/${task.id}/send-dm`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send DM");
      onStageChange(task.id, "MESSAGED");
      toast.success("LinkedIn DM sent");
    } catch (err: any) {
      toast.error(err.message || "Failed to send LinkedIn DM");
    } finally {
      setSendingDm(false);
    }
  }

  const checkboxVisible = showCheckbox || isSelected;

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData("taskId", task.id);
        e.dataTransfer.setData("fromStage", task.stage);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group relative w-full overflow-hidden bg-background rounded-xl border transition-all duration-150",
        "hover:border-border hover:shadow-sm cursor-grab active:cursor-grabbing select-none",
        isSelected
          ? "border-primary/50 ring-2 ring-primary/20 shadow-sm"
          : "border-border/60",
        isDragging && "opacity-40 scale-[0.97] shadow-none"
      )}
    >
      {/* Selection checkbox */}
      {onSelect && (
        <div
          className={cn(
            "absolute top-2.5 left-2.5 z-10 transition-opacity",
            checkboxVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={e => {
              e.stopPropagation();
              onSelect(task.id, e.target.checked);
            }}
            onClick={e => e.stopPropagation()}
            className="h-3.5 w-3.5 cursor-pointer accent-primary rounded"
          />
        </div>
      )}

      <div className={cn("p-3", onSelect && "pl-7")}>
        {/* Top: Avatar + Name + Menu */}
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarImage src={task.profilePictureUrl ? `/api/proxy-image?url=${encodeURIComponent(task.profilePictureUrl)}` : undefined} alt={name} />
            <AvatarFallback
              className={cn("text-white font-bold text-xs bg-linear-to-br", gradient)}
            >
              {getInitials(name)}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <Link
              href={`/candidates/${task.id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-sm font-semibold text-foreground truncate leading-snug hover:text-primary hover:underline underline-offset-2 transition-colors block"
            >
              {name}
            </Link>
            <p className="text-sm text-muted-foreground truncate leading-snug">
              {task.currentDesignation || task.headline || "—"}
            </p>
          </div>

          {onStar && (
            <button
              onClick={e => { e.stopPropagation(); onStar(task.id); }}
              title={isStarred ? "Remove from favourites" : "Add to favourites"}
              className={cn(
                "shrink-0 h-6 w-6 rounded-md flex items-center justify-center transition-all",
                isStarred
                  ? "text-amber-400 opacity-100"
                  : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-amber-400",
              )}
            >
              <svg
                className={cn("h-3.5 w-3.5", isStarred ? "fill-amber-400" : "fill-none")}
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
              </svg>
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="shrink-0 h-6 w-6 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Move to</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {moveTargets.map(stage => (
                <DropdownMenuItem
                  key={stage}
                  onClick={() => onStageChange(task.id, stage)}
                  className="gap-2 text-xs cursor-pointer"
                >
                  <span className={cn("h-2 w-2 rounded-full shrink-0", STAGE_CONFIG[stage].dot)} />
                  {STAGE_CONFIG[stage].label}
                </DropdownMenuItem>
              ))}
              {task.url && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <a href={task.url} target="_blank" rel="noopener noreferrer" className="gap-2 text-xs cursor-pointer">
                      <ExternalLink className="h-3 w-3" />
                      Open LinkedIn
                    </a>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Divider */}
        <div className="my-2.5 border-t border-border/50" />

        {/* Details */}
        <div className="space-y-1.5">
          {task.totalExperienceYears !== null && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Briefcase className="h-3 w-3 shrink-0" />
              <span>{task.totalExperienceYears} yrs experience</span>
            </div>
          )}
          {task.currentOrg && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">Ex: {task.currentOrg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
              {timeAgo(task.stageUpdatedAt || task.addedAt)}
              {threads.length > 0 && (
                <>
                  <span className="text-muted-foreground/30">•</span>
                  <ChannelStatusPopover threads={threads} />
                </>
              )}
            </span>
            {task.scorePercent !== null && (
              <Badge
                variant="outline"
                className={cn("text-xs font-bold h-5 px-2 py-0 border rounded-full", scoreCls)}
              >
                {Math.round(task.scorePercent)}%
              </Badge>
            )}
          </div>
        </div>

        {/* Shortlisted CTA */}
        {task.stage === "SHORTLISTED" && (
          <Button
            size="sm"
            className="mt-2.5 w-full h-7 text-xs gap-1.5"
            disabled={sendingInvite}
            onClick={handleSendInvite}
          >
            {sendingInvite ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {sendingInvite ? "Sending…" : "Send LinkedIn request"}
          </Button>
        )}

        {/* Connected CTA */}
        {task.stage === "CONNECTED" && (
          <Button
            size="sm"
            className="mt-2.5 w-full h-7 text-xs gap-1.5"
            disabled={sendingDm}
            onClick={handleSendDm}
          >
            {sendingDm ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <MessageSquare className="h-3 w-3" />
            )}
            {sendingDm ? "Sending…" : "Send DM"}
          </Button>
        )}

        {/* Replied CTA — the natural moment to send an interview link. */}
        {task.stage === "REPLIED" && onSendInterview && (
          <Button
            size="sm"
            variant={interviewSent ? "outline" : "default"}
            className="mt-2.5 w-full h-7 text-xs gap-1.5"
            onClick={e => { e.stopPropagation(); onSendInterview(task.id); }}
          >
            <Video className="h-3 w-3" />
            {interviewSent ? "Resend interview link" : "Send interview link"}
          </Button>
        )}

        {/* Interview-sent indicator (any stage once a link has gone out). */}
        {interviewSent && task.stage !== "REPLIED" && (
          <div className="mt-2 flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <Video className="h-3 w-3" />
            Interview link sent
          </div>
        )}
      </div>
    </div>
  );
}
