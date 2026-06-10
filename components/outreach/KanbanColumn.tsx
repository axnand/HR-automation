"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CandidateKanbanCard, PipelineTask } from "./CandidateKanbanCard";
import { CandidateStage, StageConfig } from "./stage-config";

interface Props {
  readonly stage: CandidateStage;
  readonly config: StageConfig;
  readonly tasks: PipelineTask[];
  readonly totalCount: number;
  readonly onStageChange: (taskId: string, newStage: CandidateStage) => void;
  readonly draggingId: string | null;
  readonly requisitionId: string;
  readonly selectedIds: Set<string>;
  readonly onSelect: (taskId: string, selected: boolean) => void;
  readonly onColumnSelectAll: (taskIds: string[]) => void;
  readonly onColumnDeselectAll: (taskIds: string[]) => void;
  readonly showCheckboxes: boolean;
  readonly starredIds?: Set<string>;
  readonly onStar?: (taskId: string) => void;
}

export function KanbanColumn({
  stage,
  config,
  tasks,
  totalCount,
  onStageChange,
  draggingId,
  requisitionId,
  selectedIds,
  onSelect,
  onColumnSelectAll,
  onColumnDeselectAll,
  showCheckboxes,
  starredIds,
  onStar,
}: Props) {
  const [isOver, setIsOver] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);

  const allSelected = tasks.length > 0 && tasks.every(t => selectedIds.has(t.id));
  const someSelected = tasks.some(t => selectedIds.has(t.id));

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  function handleHeaderCheckbox(e: React.ChangeEvent<HTMLInputElement>) {
    const ids = tasks.map(t => t.id);
    if (e.target.checked) onColumnSelectAll(ids);
    else onColumnDeselectAll(ids);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsOver(false);
    const taskId = e.dataTransfer.getData("taskId");
    const fromStage = e.dataTransfer.getData("fromStage") as CandidateStage;
    if (taskId && fromStage !== stage) onStageChange(taskId, stage);
  }

  return (
    <section
      aria-label={`${config.label} column`}
      className={cn(
        "flex flex-col w-80 shrink-0 rounded-2xl transition-colors duration-150 overflow-hidden",
        isOver ? "bg-accent/60" : "bg-muted/40"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0">
        {(showCheckboxes || someSelected) && tasks.length > 0 && (
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={allSelected}
            onChange={handleHeaderCheckbox}
            className="h-3.5 w-3.5 cursor-pointer accent-primary rounded shrink-0"
            title={allSelected ? "Deselect all" : "Select all"}
          />
        )}
        <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", config.dot)} />
        <span className={cn("text-sm font-semibold flex-1 truncate", config.headerText)}>
          {config.label}
        </span>
        <span className={cn(
          "text-xs font-bold flex items-center justify-center",
          "rounded-full border px-1.5 min-w-5.5 h-5.5",
          config.headerBg, config.headerText, config.border
        )}>
          {tasks.length < totalCount ? `${tasks.length}/${totalCount}` : tasks.length}
        </span>
      </div>

      <ScrollArea
        className="flex-1 px-2 pb-2 [&>div>div]:!block [&>div>div]:!min-w-0 [&>div>div]:!w-full"
        style={{ height: "calc(100vh - 248px)" }}
      >
        <div className="flex flex-col gap-2 pt-0.5">
          {tasks.length === 0 ? (
            <div className={cn(
              "flex items-center justify-center h-20 rounded-xl border-2 border-dashed",
              "text-xs text-muted-foreground transition-colors",
              isOver ? "border-primary/40 bg-primary/5 text-primary/70" : "border-border/40"
            )}>
              {isOver ? "Drop here" : "No candidates"}
            </div>
          ) : (
            tasks.map(task => (
              <CandidateKanbanCard
                key={task.id}
                task={task}
                requisitionId={requisitionId}
                onStageChange={onStageChange}
                isDragging={draggingId === task.id}
                isSelected={selectedIds.has(task.id)}
                onSelect={onSelect}
                showCheckbox={showCheckboxes || someSelected}
                isStarred={starredIds?.has(task.id) ?? false}
                onStar={onStar}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
