"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Briefcase, MapPin, MoreHorizontal, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FilterBar,
  FilterDivider,
  FilterText,
  FilterNumber,
  SortSelect,
} from "@/components/ui/filter-bar";
import { PipelineTask } from "@/components/outreach/CandidateKanbanCard";
import {
  CandidateStage,
  STAGE_CONFIG,
  PIPELINE_STAGES,
} from "@/components/outreach/stage-config";

type StageMap = Partial<Record<CandidateStage, PipelineTask[]>>;

interface Props {
  stages: StageMap;
  /** Stages to flatten into the list (board stages or archive stages). */
  scopeStages: CandidateStage[];
  /** Shared free-text search from the parent header. */
  globalQuery: string;
  onStageChange: (taskId: string, newStage: CandidateStage) => void;
  selectedIds: Set<string>;
  onSelect: (taskId: string, selected: boolean) => void;
  onSelectAll: (taskIds: string[]) => void;
  onDeselectAll: (taskIds: string[]) => void;
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

// lucide-react dropped brand glyphs; inline the LinkedIn mark so the link is
// instantly recognizable (HR explicitly asked for the logo, not a generic ↗).
function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

function matchesQuery(task: PipelineTask, q: string) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    task.name.toLowerCase().includes(needle) ||
    task.currentDesignation.toLowerCase().includes(needle) ||
    task.headline.toLowerCase().includes(needle) ||
    task.currentOrg.toLowerCase().includes(needle) ||
    task.location.toLowerCase().includes(needle)
  );
}

const SORT_OPTIONS = [
  { label: "Recently updated", value: "date-desc" },
  { label: "Score: high → low", value: "score-desc" },
  { label: "Experience: high → low", value: "exp-desc" },
  { label: "Experience: low → high", value: "exp-asc" },
  { label: "Name: A → Z", value: "name-asc" },
];

export function PipelineListView({
  stages,
  scopeStages,
  globalQuery,
  onStageChange,
  selectedIds,
  onSelect,
  onSelectAll,
  onDeselectAll,
}: Props) {
  // Empty set means "all stages" — no filtering. Otherwise show only the
  // selected stages (multi-select).
  const [stageFilter, setStageFilter] = useState<Set<CandidateStage>>(new Set());
  const [filterLocation, setFilterLocation] = useState("");
  const [filterMinExp, setFilterMinExp] = useState("");
  const [sort, setSort] = useState("date-desc");

  function toggleStage(stage: CandidateStage) {
    setStageFilter(prev => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  const rows = useMemo(() => {
    const flat: PipelineTask[] = [];
    for (const stage of scopeStages) {
      if (stageFilter.size > 0 && !stageFilter.has(stage)) continue;
      for (const t of stages[stage] ?? []) flat.push(t);
    }

    const loc = filterLocation.trim().toLowerCase();
    const minExp = filterMinExp.trim() ? parseFloat(filterMinExp) : null;

    return flat
      .filter(t => {
        if (!matchesQuery(t, globalQuery)) return false;
        if (loc && !t.location.toLowerCase().includes(loc)) return false;
        if (minExp !== null && (t.totalExperienceYears ?? -1) < minExp) return false;
        return true;
      })
      .sort((a, b) => {
        switch (sort) {
          case "score-desc":
            return (b.scorePercent ?? -1) - (a.scorePercent ?? -1);
          case "exp-desc":
            return (b.totalExperienceYears ?? -1) - (a.totalExperienceYears ?? -1);
          case "exp-asc":
            return (a.totalExperienceYears ?? -1) - (b.totalExperienceYears ?? -1);
          case "name-asc":
            return a.name.localeCompare(b.name);
          case "date-desc":
          default:
            return (
              new Date(b.stageUpdatedAt || b.addedAt).getTime() -
              new Date(a.stageUpdatedAt || a.addedAt).getTime()
            );
        }
      });
  }, [stages, scopeStages, stageFilter, filterLocation, filterMinExp, globalQuery, sort]);

  const rowIds = useMemo(() => rows.map(r => r.id), [rows]);
  const allSelected = rowIds.length > 0 && rowIds.every(id => selectedIds.has(id));
  const someSelected = rowIds.some(id => selectedIds.has(id));

  const hasFilters =
    stageFilter.size > 0 || filterLocation.trim() !== "" || filterMinExp.trim() !== "";

  function clearFilters() {
    setStageFilter(new Set());
    setFilterLocation("");
    setFilterMinExp("");
  }

  return (
    <div className="flex flex-col h-full gap-3">
      <FilterBar>
        <div className="flex items-center gap-1 flex-wrap">
          {scopeStages.map(stage => {
            const active = stageFilter.has(stage);
            const cfg = STAGE_CONFIG[stage];
            return (
              <button
                key={stage}
                onClick={() => toggleStage(stage)}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors border",
                  active
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:text-foreground",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
                {cfg.label}
              </button>
            );
          })}
        </div>
        <FilterDivider />
        <FilterText
          value={filterLocation}
          onChange={setFilterLocation}
          placeholder="Location…"
          icon="location"
        />
        <FilterNumber
          value={filterMinExp}
          onChange={setFilterMinExp}
          placeholder="Min exp (yrs)"
        />
        <FilterDivider />
        <SortSelect value={sort} onChange={setSort} options={SORT_OPTIONS} />
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{rows.length}</span>{" "}
          candidate{rows.length !== 1 ? "s" : ""}
        </span>
      </FilterBar>

      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border/60 bg-background">
        {rows.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
            No candidates match these filters
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 h-10">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    ref={el => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={e =>
                      e.target.checked ? onSelectAll(rowIds) : onDeselectAll(rowIds)
                    }
                    className="h-3.5 w-3.5 cursor-pointer accent-primary rounded"
                  />
                </TableHead>
                <TableHead className="h-10">Candidate</TableHead>
                <TableHead className="h-10">Current org</TableHead>
                <TableHead className="h-10 w-20">Exp</TableHead>
                <TableHead className="h-10">Location</TableHead>
                <TableHead className="h-10 w-32">Stage</TableHead>
                <TableHead className="h-10 w-16 text-right">Score</TableHead>
                <TableHead className="h-10 w-20 text-right">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(task => (
                <PipelineRow
                  key={task.id}
                  task={task}
                  selected={selectedIds.has(task.id)}
                  onSelect={onSelect}
                  onStageChange={onStageChange}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function PipelineRow({
  task,
  selected,
  onSelect,
  onStageChange,
}: {
  task: PipelineTask;
  selected: boolean;
  onSelect: (taskId: string, selected: boolean) => void;
  onStageChange: (taskId: string, newStage: CandidateStage) => void;
}) {
  const name = task.name || "Unknown";
  const config = STAGE_CONFIG[task.stage];
  const moveTargets = PIPELINE_STAGES.filter(s => s !== task.stage);
  const scoreCls =
    task.recommendation === "Strong Fit"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : task.recommendation === "Moderate Fit"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "border-rose-500/40 bg-rose-500/10 text-rose-500";

  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell className="py-2.5">
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          checked={selected}
          onChange={e => onSelect(task.id, e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-primary rounded"
        />
      </TableCell>

      <TableCell className="py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarImage
              src={task.profilePictureUrl ? `/api/proxy-image?url=${encodeURIComponent(task.profilePictureUrl)}` : undefined}
              alt={name}
            />
            <AvatarFallback className={cn("text-white font-bold text-[10px] bg-linear-to-br", pickGradient(name))}>
              {getInitials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <Link
              href={`/candidates/${task.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-foreground truncate hover:text-primary hover:underline underline-offset-2 block max-w-[220px]"
            >
              {name}
            </Link>
            <p className="text-xs text-muted-foreground truncate max-w-[220px]">
              {task.currentDesignation || task.headline || "—"}
            </p>
          </div>
        </div>
      </TableCell>

      <TableCell className="py-2.5 text-sm text-muted-foreground">
        <span className="truncate block max-w-[160px]">{task.currentOrg || "—"}</span>
      </TableCell>

      <TableCell className="py-2.5 text-sm text-muted-foreground whitespace-nowrap">
        {task.totalExperienceYears !== null ? (
          <span className="flex items-center gap-1.5">
            <Briefcase className="h-3 w-3 shrink-0" />
            {task.totalExperienceYears} yrs
          </span>
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="py-2.5 text-sm text-muted-foreground">
        {task.location ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate max-w-[160px]">{task.location}</span>
          </span>
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="py-2.5">
        <Badge
          variant="outline"
          className={cn("gap-1.5 text-xs h-6 px-2 rounded-full", config.border, config.headerBg, config.headerText)}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
          {config.label}
        </Badge>
      </TableCell>

      <TableCell className="py-2.5 text-right">
        {task.scorePercent !== null ? (
          <Badge variant="outline" className={cn("text-xs font-bold h-5 px-2 py-0 rounded-full", scoreCls)}>
            {Math.round(task.scorePercent)}%
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="py-2.5">
        <div className="flex items-center justify-end gap-1">
          {task.url && (
            <a
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-[#0a66c2] hover:bg-muted transition-colors"
              aria-label="Open LinkedIn profile"
              title="Open LinkedIn profile"
            >
              <LinkedInIcon className="h-3.5 w-3.5" />
            </a>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="More actions"
              >
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
      </TableCell>
    </TableRow>
  );
}
