"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { estimateCost, formatCost } from "@/lib/model-pricing";
import { getEffectiveRules } from "@/lib/analyzer";
import { FilterBar, FilterDivider, FilterPills, FilterText, FilterNumber, SortSelect, FilterSelect } from "@/components/ui/filter-bar";
import { Users, TrendingUp, Minus, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

interface TaskResult {
  id: string;
  url: string;
  status: string;
  result: any;
  analysisResult: any;
  errorMessage: string | null;
  retryCount: number;
  runId?: string;
  runIndex?: number;
  addedAt?: string;
  source?: string;
  sourceFileName?: string | null;
  hasResume?: boolean;
  starred?: boolean;
  overrides?: any[];
}

interface JobResults {
  id: string;
  title: string;
  department: string;
  status: string;
  totalTasks: number;
  processedCount: number;
  successCount: number;
  failedCount: number;
  config?: any;
  tasks: TaskResult[];
}

interface SheetIntegrationType {
  id: string;
  name: string;
  url: string;
}

interface Props {
  data: JobResults;
  requisitionId: string;
  onRefresh: () => void;
  duplicateTaskIds?: Set<string>;
  onOpenDuplicates?: () => void;
}

export function CandidatesTab({ data, requisitionId, onRefresh, duplicateTaskIds, onOpenDuplicates }: Props) {
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterFit, setFilterFit] = useState("All");
  const [filterLocation, setFilterLocation] = useState("");
  const [filterMinExp, setFilterMinExp] = useState("");
  const [filterDate, setFilterDate] = useState("all");
  const [sort, setSort] = useState("score-desc");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [starredIds, setStarredIds] = useState<Set<string>>(
    () => new Set(data.tasks.filter(t => t.starred).map(t => t.id))
  );
  const [filterStarred, setFilterStarred] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [reevalLoading, setReevalLoading] = useState(false);
  const [showSheetModal, setShowSheetModal] = useState(false);
  const [sheetUrl, setSheetUrl] = useState(data.config?.sheetWebAppUrl || "");
  const [sheetIntegrations, setSheetIntegrations] = useState<SheetIntegrationType[]>([]);

  useEffect(() => {
    fetch("/api/sheet-integrations")
      .then(r => r.ok ? r.json() : [])
      .then(setSheetIntegrations)
      .catch(() => {});
  }, []);

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
    setExportMsg(null);
  }

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
      // revert on failure
      setStarredIds(prev => {
        const s = new Set(prev);
        if (next) s.delete(taskId); else s.add(taskId);
        return s;
      });
    }
  }

  async function runExport(mode: "xlsx" | "sheet") {
    setExportLoading(true);
    setExportMsg(null);
    try {
      const body: any = {};
      if (selectedIds.size > 0) body.taskIds = Array.from(selectedIds);
      if (mode === "sheet") body.sheetWebAppUrl = sheetUrl.trim();

      const res = await fetch(`/api/requisitions/${requisitionId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (mode === "sheet") {
        const json = await res.json();
        if (!res.ok) { setExportMsg({ type: "error", text: json.error || "Export failed" }); return; }
        setExportMsg({ type: "success", text: `Exported ${json.exported}/${json.total} profiles to "${json.tabName}"${json.failed ? ` (${json.failed} failed)` : ""}` });
        setShowSheetModal(false);
      } else {
        if (!res.ok) { const json = await res.json(); setExportMsg({ type: "error", text: json.error || "Export failed" }); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "export.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setExportMsg({ type: "success", text: "XLSX downloaded" });
      }
    } catch (err: any) {
      setExportMsg({ type: "error", text: err.message });
    } finally {
      setExportLoading(false);
    }
  }

  async function handleBulkEnrich() {
    const taskIds = selectedIds.size > 0 ? Array.from(selectedIds) : filteredTasks.map(t => t.id);
    if (!taskIds.length) return;
    setEnrichLoading(true);
    setExportMsg(null);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const d = await res.json();
      if (res.status === 402) {
        setExportMsg({ type: "error", text: "Airscale credit limit reached" });
      } else if (!res.ok) {
        setExportMsg({ type: "error", text: d.error ?? "Enrichment failed" });
      } else {
        setExportMsg({ type: "success", text: `Enriched ${d.enriched}/${d.total} contacts${d.failed ? ` (${d.failed} failed)` : ""}` });
      }
    } catch (err: any) {
      setExportMsg({ type: "error", text: err.message });
    } finally {
      setEnrichLoading(false);
    }
  }

  async function handleBulkReevaluate() {
    // Re-evaluation re-runs the AI per profile, so require an explicit selection
    // rather than silently re-scoring the whole (potentially large) list.
    const taskIds = Array.from(selectedIds);
    if (!taskIds.length) {
      setExportMsg({ type: "error", text: "Select the profiles you want to re-evaluate first" });
      return;
    }
    setReevalLoading(true);
    setExportMsg(null);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-reevaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const d = await res.json();
      if (!res.ok) {
        setExportMsg({ type: "error", text: d.error ?? "Re-evaluation failed" });
      } else {
        const improved = (d.results ?? []).filter(
          (r: any) => r.ok && r.before && r.after && r.after.scorePercent > r.before.scorePercent
        ).length;
        setExportMsg({
          type: "success",
          text: `Re-evaluated ${d.reevaluated}/${d.total}${improved ? ` · ${improved} improved` : ""}${d.failed ? ` · ${d.failed} failed` : ""}`,
        });
        onRefresh?.();
      }
    } catch (err: any) {
      setExportMsg({ type: "error", text: err.message });
    } finally {
      setReevalLoading(false);
    }
  }

  const completedTasks = useMemo(
    () => data.tasks.filter(t => t.result || t.analysisResult),
    [data.tasks]
  );
  
  const filteredTasks = useMemo(() => {
    return completedTasks
      .filter(task => {
        const profile = task.result;
        const analysis = task.analysisResult;

        // Only apply user-driven filters if the user has set them
        if (search.trim()) {
          const scrapedName = `${profile?.first_name || ""} ${profile?.last_name || ""}`;
          const extractedName = profile?.extractedInfo?.name || analysis?.candidateInfo?.name || "";
          const fullName = (scrapedName.trim() || extractedName).toLowerCase();
          if (!fullName.includes(search.toLowerCase().trim())) return false;
        }
        if (filterStarred && !starredIds.has(task.id)) return false;
        if (filterFit !== "All" && analysis?.recommendation !== filterFit) return false;
        if (filterLocation.trim()) {
          const loc = (analysis?.candidateInfo?.currentLocation || profile?.location || "").toLowerCase();
          if (!loc.includes(filterLocation.toLowerCase().trim())) return false;
        }
        if (filterMinExp.trim()) {
          const exp = analysis?.candidateInfo?.totalExperienceYears ?? -1;
          if (exp < parseFloat(filterMinExp)) return false;
        }
        if (filterDate !== "all") {
          const added = task.addedAt ? new Date(task.addedAt) : null;
          if (!added) return false;
          const now = new Date();
          const diffHours = (now.getTime() - added.getTime()) / (1000 * 60 * 60);
          if (filterDate === "24h" && diffHours > 24) return false;
          if (filterDate === "7d" && diffHours > 24 * 7) return false;
          if (filterDate === "30d" && diffHours > 24 * 30) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aA = a.analysisResult;
        const bA = b.analysisResult;
        if (sort === "score-desc") return (bA?.scorePercent ?? -1) - (aA?.scorePercent ?? -1);
        if (sort === "score-asc") return (aA?.scorePercent ?? -1) - (bA?.scorePercent ?? -1);
        if (sort === "date-desc") {
          const aDate = a.addedAt ? new Date(a.addedAt).getTime() : 0;
          const bDate = b.addedAt ? new Date(b.addedAt).getTime() : 0;
          return bDate - aDate;
        }
        if (sort === "date-asc") {
          const aDate = a.addedAt ? new Date(a.addedAt).getTime() : 0;
          const bDate = b.addedAt ? new Date(b.addedAt).getTime() : 0;
          return aDate - bDate;
        }
        if (sort === "exp-desc") return (bA?.candidateInfo?.totalExperienceYears ?? -1) - (aA?.candidateInfo?.totalExperienceYears ?? -1);
        if (sort === "exp-asc") return (aA?.candidateInfo?.totalExperienceYears ?? -1) - (bA?.candidateInfo?.totalExperienceYears ?? -1);
        if (sort === "name-asc") {
          const aName = `${a.result?.first_name || ""} ${a.result?.last_name || ""}`.trim();
          const bName = `${b.result?.first_name || ""} ${b.result?.last_name || ""}`.trim();
          return aName.localeCompare(bName);
        }
        return 0;
      });
  }, [completedTasks, search, filterFit, filterLocation, filterMinExp, filterDate, sort, filterStarred, starredIds]);

  const kpiStats = useMemo(() => {
    let strong = 0, moderate = 0, notFit = 0;
    for (const t of filteredTasks) {
      if (t.analysisResult) {
        const a = t.analysisResult;
        if (a.recommendation === "Strong Fit") strong++;
        else if (a.recommendation === "Moderate Fit") moderate++;
        else if (a.recommendation === "Not a Fit") notFit++;
      }
    }
    return { strong, moderate, notFit, total: filteredTasks.length };
  }, [filteredTasks]);

  const allAnalysedIds = filteredTasks.map(t => t.id);
  const allSelected = allAnalysedIds.length > 0 && selectedIds.size === allAnalysedIds.length;

  return (
    <div className={`space-y-6 ${selectMode ? "pb-28" : ""}`}>
      {/* KPI Stats */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Total" value={kpiStats.total} icon={Users} tone="neutral" />
          <StatTile label="Strong Fit" value={kpiStats.strong} icon={TrendingUp} tone="emerald" />
          <StatTile label="Moderate" value={kpiStats.moderate} icon={Minus} tone="amber" />
          <StatTile label="Not a Fit" value={kpiStats.notFit} icon={TrendingDown} tone="rose" />
        </div>
        {/* <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Award className="h-3.5 w-3.5" />
              <span className="uppercase tracking-wider font-medium">Average Score</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-foreground">{kpiStats.avgScore}</span>
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", kpiStats.avgScore >= 70 ? "bg-emerald-500" : kpiStats.avgScore >= 40 ? "bg-amber-500" : "bg-rose-500")}
                style={{ width: `${kpiStats.avgScore}%` }}
              />
            </div>
          </CardContent>
        </Card> */}
      </div>

      {/* Completed Profiles */}
      {completedTasks.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground shrink-0">
                Candidates ({filteredTasks.length})
              </h2>
              {filteredTasks.length > 0 && !selectMode && (
                <button
                  onClick={() => setSelectMode(true)}
                  className="ml-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25 transition-colors"
                >
                  Select to export
                </button>
              )}
              {selectMode && (
                <button
                  onClick={() => setSelectedIds(allSelected ? new Set() : new Set(allAnalysedIds))}
                  className="ml-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted text-muted-foreground hover:bg-accent transition-colors"
                >
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
              )}
            </div>

            {completedTasks.length > 1 && (
              <div className="space-y-2">
                <FilterBar>
                  <FilterText value={search} onChange={setSearch} placeholder="Name…" icon="search" />
                  <FilterDivider />
                  <FilterPills
                    value={filterFit}
                    onChange={setFilterFit}
                    options={[
                      { label: "All", value: "All", color: "default" },
                      { label: "Strong Fit", value: "Strong Fit", color: "emerald" },
                      { label: "Moderate Fit", value: "Moderate Fit", color: "amber" },
                      { label: "Not a Fit", value: "Not a Fit", color: "rose" },
                    ]}
                  />
                  <FilterDivider />
                  <button
                    onClick={() => setFilterStarred(v => !v)}
                    title={filterStarred ? "Show all" : "Show starred only"}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border",
                      filterStarred
                        ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                        : "bg-transparent text-muted-foreground border-transparent hover:bg-muted"
                    )}
                  >
                    <svg className={cn("w-3.5 h-3.5", filterStarred ? "fill-amber-500 text-amber-500" : "fill-none text-muted-foreground")} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                    </svg>
                    Starred
                    {filterStarred && starredIds.size > 0 && (
                      <span className="text-[10px] font-bold">{starredIds.size}</span>
                    )}
                  </button>
                  <FilterDivider />
                  <SortSelect
                    value={sort}
                    onChange={setSort}
                    options={[
                      { label: "Score: High → Low", value: "score-desc" },
                      { label: "Score: Low → High", value: "score-asc" },
                      { label: "Date: Newest First", value: "date-desc" },
                      { label: "Date: Oldest First", value: "date-asc" },
                      { label: "Experience: High → Low", value: "exp-desc" },
                      { label: "Experience: Low → High", value: "exp-asc" },
                      { label: "Name: A → Z", value: "name-asc" },
                    ]}
                  />
                  <FilterDivider />
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border",
                      showAdvanced || filterLocation || filterMinExp || filterDate !== "all"
                        ? "bg-primary/10 text-primary border-primary/20"
                        : "bg-transparent text-muted-foreground border-transparent hover:bg-muted"
                    )}
                  >
                    More Filters
                    {(filterLocation || filterMinExp || filterDate !== "all") && (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                </FilterBar>

                {showAdvanced && (
                  <FilterBar>
                    <FilterSelect
                      value={filterDate}
                      onChange={setFilterDate}
                      icon="calendar"
                      options={[
                        { label: "All Time", value: "all" },
                        { label: "Last 24 Hours", value: "24h" },
                        { label: "Last 7 Days", value: "7d" },
                        { label: "Last 30 Days", value: "30d" },
                      ]}
                    />
                    <FilterText value={filterLocation} onChange={setFilterLocation} placeholder="Location…" icon="location" />
                    <FilterNumber value={filterMinExp} onChange={setFilterMinExp} placeholder="Min exp (yrs)" />
                  </FilterBar>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            {filteredTasks.map(task => {
                const isSelected = selectedIds.has(task.id);
                const isSelectable = selectMode && !!task.analysisResult;
                return (
                  <div
                    key={task.id}
                    onClick={isSelectable ? () => toggleSelect(task.id) : undefined}
                    className={`relative rounded-xl transition-all ${isSelectable ? "cursor-pointer" : ""} ${
                      isSelected
                        ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                        : isSelectable
                        ? "ring-1 ring-border hover:ring-primary/50"
                        : ""
                    }`}
                  >
                    <ProfileCard
                      task={task}
                      jobConfig={data.config}
                      expanded={!selectMode && expandedTask === task.id}
                      onToggle={() => {
                        if (selectMode) return;
                        setExpandedTask(expandedTask === task.id ? null : task.id);
                      }}
                      isDuplicate={duplicateTaskIds?.has(task.id)}
                      onOpenDuplicates={onOpenDuplicates}
                      selectMode={selectMode}
                      isSelected={isSelected}
                      isStarred={starredIds.has(task.id)}
                      onStar={() => toggleStar(task.id)}
                    />
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* Floating Export Bar */}
      {selectMode && (
        <div className="fixed bottom-0 left-56 right-0 z-40 flex justify-center pb-4 px-4 pointer-events-none">
          <div className="pointer-events-auto w-auto max-w-[calc(100vw-2rem)] bg-card border border-border rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-2">
            <div className="shrink-0 flex items-center gap-2">
              <span className="inline-flex items-center justify-center h-7 px-2.5 rounded-full bg-primary text-primary-foreground text-xs font-bold min-w-[28px]">
                {selectedIds.size}
              </span>
              <span className="text-sm text-foreground whitespace-nowrap">
                {selectedIds.size === 0 ? "None selected" : `profile${selectedIds.size !== 1 ? "s" : ""} selected`}
              </span>
            </div>
            {exportMsg && (
              <span className={`text-xs px-2 py-1 rounded-lg whitespace-nowrap ${exportMsg.type === "success" ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}`}>
                {exportMsg.text}
              </span>
            )}
            <div className="w-1" />
            <button
              onClick={handleBulkReevaluate}
              disabled={reevalLoading || exportLoading || selectedIds.size === 0}
              title="Re-run the AI scorer on the selected profiles using the current scoring rules (no LinkedIn re-scrape)"
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 transition-colors disabled:opacity-50 shrink-0"
            >
              {reevalLoading ? "Re-evaluating…" : "Re-evaluate"}
            </button>
            <button
              onClick={handleBulkEnrich}
              disabled={enrichLoading || exportLoading}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors disabled:opacity-50 shrink-0"
            >
              {enrichLoading ? "Enriching…" : "Enrich Contacts"}
            </button>
            <button
              onClick={() => { setExportMsg(null); setShowSheetModal(true); }}
              disabled={exportLoading}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 shrink-0"
            >
              Export to Sheet
            </button>
            <button
              onClick={() => runExport("xlsx")}
              disabled={exportLoading}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors disabled:opacity-50 shrink-0"
            >
              {exportLoading ? "Generating..." : "Download XLSX"}
            </button>
            <button
              onClick={exitSelectMode}
              disabled={exportLoading}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-muted text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50 shrink-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sheet URL Modal */}
      {showSheetModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
          onClick={() => !exportLoading && setShowSheetModal(false)}
        >
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">Export to Google Sheet</h3>
              <span className="text-xs text-muted-foreground">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : `All ${filteredTasks.length} profiles`}
              </span>
            </div>

            {sheetIntegrations.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground font-medium">Saved Sheets</p>
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {sheetIntegrations.map(sheet => {
                    const isActive = sheetUrl === sheet.url;
                    return (
                      <button
                        key={sheet.id}
                        type="button"
                        onClick={() => setSheetUrl(sheet.url)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all ${
                          isActive
                            ? "bg-emerald-500/15 border border-emerald-500/40 text-emerald-300"
                            : "bg-muted border border-border text-foreground hover:border-muted-foreground"
                        }`}
                      >
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-emerald-400" : "bg-muted-foreground"}`} />
                        <span className="text-sm font-medium truncate">{sheet.name}</span>
                        {isActive && <span className="ml-auto text-[10px] text-emerald-400 shrink-0">Selected</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">
                {sheetIntegrations.length > 0 ? "Or enter URL manually" : "Apps Script Web App URL"}
              </label>
              <input
                autoFocus={sheetIntegrations.length === 0}
                type="text"
                placeholder="https://script.google.com/macros/s/..."
                value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)}
                className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-muted-foreground mt-1.5">Profiles are exported as a separate tab in your sheet</p>
            </div>
            {exportMsg && (
              <p className={`text-xs rounded-lg px-3 py-2 ${exportMsg.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
                {exportMsg.text}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => runExport("sheet")}
                disabled={exportLoading || !sheetUrl.trim()}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
              >
                {exportLoading ? "Exporting..." : "Export"}
              </button>
              <button
                onClick={() => { setShowSheetModal(false); setExportMsg(null); }}
                disabled={exportLoading}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-muted text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function ProfileCard({ task, jobConfig, expanded, onToggle, isDuplicate, onOpenDuplicates, selectMode, isSelected, isStarred, onStar }: { task: TaskResult; jobConfig?: any; expanded: boolean; onToggle: () => void; isDuplicate?: boolean; onOpenDuplicates?: () => void; selectMode?: boolean; isSelected?: boolean; isStarred?: boolean; onStar?: () => void; }) {
  const profile = task.result;
  const analysis = task.analysisResult;
  if (!profile && !analysis) return null;

  const extracted = profile?.extractedInfo || {};
  const scrapedName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ");
  const name =
    scrapedName ||
    extracted.name ||
    analysis?.candidateInfo?.name ||
    "Unknown";
  const headline = profile?.headline || profile?.occupation || extracted.currentDesignation || analysis?.candidateInfo?.currentDesignation || "";
  const location = analysis?.candidateInfo?.currentLocation || profile?.location || extracted.currentLocation || "";
  const publicId = profile?.public_identifier || "";
  const info = analysis?.candidateInfo;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        className="w-full text-left p-4 flex items-center gap-4 hover:bg-accent/30 transition-colors cursor-pointer"
      >
        <div className="h-12 w-12 rounded-full bg-gradient-to-br from-primary to-cyan-400 flex items-center justify-center text-primary-foreground font-bold text-lg shrink-0 overflow-hidden">
          {profile?.profile_picture_url ? (
            <img
              src={`/api/proxy-image?url=${encodeURIComponent(profile.profile_picture_url)}`}
              alt={name}
              className="h-full w-full object-cover"
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            (() => {
              const parts = (name || "?").split(/\s+/).filter(Boolean);
              const first = parts[0]?.[0] || "?";
              const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
              return `${first}${last}`;
            })()
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/candidates/${task.id}`}
              onClick={e => e.stopPropagation()}
              className="text-foreground font-medium text-base hover:text-primary hover:underline transition-colors"
            >
              {name}
            </Link>
            {isDuplicate && (
              <span
                onClick={e => { e.stopPropagation(); onOpenDuplicates?.(); }}
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0 cursor-pointer"
              >
                ⚠ dup
              </span>
            )}
            {task.addedAt && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0">
                {new Date(task.addedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
          {info ? (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground truncate">
              {info.currentDesignation && (
                <span className="font-medium text-foreground/80 truncate max-w-[200px]">
                  {info.currentDesignation}
                </span>
              )}
              {info.currentDesignation && info.currentOrg && <span>at</span>}
              {info.currentOrg && (
                <span className="truncate max-w-[150px]">{info.currentOrg}</span>
              )}
              {(info.currentDesignation || info.currentOrg) && <span className="opacity-50">•</span>}
              
              {info.totalExperienceYears > 0 && (
                <span className="whitespace-nowrap px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/50 text-[10px] font-medium text-foreground/70">
                  {info.totalExperienceYears} yrs exp
                </span>
              )}
              
              {location && (
                <>
                  <span className="opacity-50">•</span>
                  <span className="truncate max-w-[150px]">{location}</span>
                </>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground truncate">{headline}</p>
              {location && <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{location}</p>}
            </>
          )}
        </div>

        <button
          onClick={e => { e.stopPropagation(); onStar?.(); }}
          title={isStarred ? "Remove from favourites" : "Add to favourites"}
          className={cn(
            "shrink-0 p-1.5 rounded-lg transition-colors",
            isStarred
              ? "text-amber-400 hover:text-amber-500"
              : "text-muted-foreground/40 hover:text-amber-400"
          )}
        >
          <svg className={cn("w-4 h-4", isStarred ? "fill-amber-400" : "fill-none")} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
        </button>

        {analysis && (
          <div className="flex flex-col items-end gap-1.5 shrink-0 min-w-[72px] pr-1">
            <div className="flex items-center gap-3">
              <span className={`text-xl font-bold tabular-nums leading-none ${
                analysis.scorePercent >= 70 ? "text-emerald-500"
                : analysis.scorePercent >= 40 ? "text-amber-500"
                : "text-rose-500"
              }`}>{analysis.scorePercent}%</span>
              
              {selectMode ? (
                <div className={`w-[22px] h-[22px] rounded-full flex items-center justify-center border-[1.5px] transition-colors shrink-0 ${
                  isSelected 
                    ? "bg-primary border-primary text-primary-foreground shadow-sm" 
                    : "border-border/60 bg-background"
                }`}>
                  {isSelected && (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              ) : (
                <div className="w-[22px] flex justify-center">
                  {/* Empty spacer for alignment if not select mode, or maybe put the chevron here? 
                      Actually in the design, chevron is below. We'll leave it as is or omit spacer. */}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-1.5 mt-0.5">
              {task.overrides && task.overrides.length > 0 && (
                <span className="text-[9px] font-medium text-blue-500 border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 rounded">
                  Edited
                </span>
              )}
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                analysis.recommendation === "Strong Fit"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : analysis.recommendation === "Moderate Fit"
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-rose-500/10 text-rose-500"
              }`}>{analysis.recommendation}</span>
              
              <div className="w-[22px] flex justify-center ml-1.5">
                {!selectMode && (
                  <svg className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {analysis && (
            <div className="space-y-4">
              {analysis.candidateInfo && (
                <div className="bg-background/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Candidate Info</p>
                    {task.hasResume && (
                      <a
                        href={`/api/tasks/${task.id}/resume`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline px-2 py-1 rounded-md bg-primary/10 border border-primary/20"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        View Resume
                      </a>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {analysis.candidateInfo.currentOrg && <InfoField label="Current Org" value={analysis.candidateInfo.currentOrg} />}
                    {analysis.candidateInfo.currentDesignation && <InfoField label="Designation" value={analysis.candidateInfo.currentDesignation} />}
                    {analysis.candidateInfo.totalExperienceYears > 0 && <InfoField label="Experience" value={`${analysis.candidateInfo.totalExperienceYears} yrs`} />}
                    {analysis.candidateInfo.companiesSwitched > 0 && <InfoField label="Companies" value={String(analysis.candidateInfo.companiesSwitched)} />}
                    {analysis.candidateInfo.stabilityAvgYears > 0 && <InfoField label="Avg Tenure" value={`${analysis.candidateInfo.stabilityAvgYears} yrs`} />}
                    {analysis.candidateInfo.currentLocation && <InfoField label="Location" value={analysis.candidateInfo.currentLocation} />}
                    {analysis.candidateInfo.btech && <InfoField label="BTech/BE" value={analysis.candidateInfo.btech} />}
                    {analysis.candidateInfo.graduation && <InfoField label="Graduation" value={analysis.candidateInfo.graduation} />}
                    {analysis.candidateInfo.mba && <InfoField label="MBA" value={analysis.candidateInfo.mba} />}
                    {analysis.candidateInfo.graduationYear && <InfoField label="Grad Year" value={String(analysis.candidateInfo.graduationYear)} />}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      analysis.scorePercent >= 70 ? "bg-emerald-500"
                      : analysis.scorePercent >= 40 ? "bg-amber-500"
                      : "bg-rose-500"
                    }`}
                    style={{ width: `${(analysis.totalScore / analysis.maxScore) * 100}%` }}
                  />
                </div>
                <span className="text-sm text-foreground font-mono shrink-0">{analysis.totalScore}/{analysis.maxScore}</span>
              </div>

              {(() => {
                const jobConfig_ = jobConfig || {};
                const effectiveRules = getEffectiveRules({
                  scoringRules: analysis.enabledRules || jobConfig_.scoringRules,
                  customScoringRules: analysis.customScoringRules || jobConfig_.customScoringRules || [],
                  builtInRuleDescriptions: jobConfig_.builtInRuleDescriptions,
                  ruleDefinitions: jobConfig_.ruleDefinitions,
                }).filter(r => r.enabled);

                return (
                  <div className="bg-background/50 rounded-lg overflow-hidden">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider p-3 border-b border-border">Scoring Breakdown</p>
                    <div className="divide-y divide-border/50">
                      {effectiveRules.map(rule => {
                        const ruleMax = Math.max(0, ...rule.scoreParameters.map(p => p.maxPoints));
                        
                        let bestVal = 0;
                        let isOverridden = false;
                        for (const p of rule.scoreParameters) {
                          const o = task.overrides?.find(o => o.paramKey === p.key);
                          if (o) {
                            isOverridden = true;
                            bestVal = o.override;
                            break;
                          } else {
                            const s = analysis.scoring?.[p.key];
                            if (typeof s === "number" && s > bestVal) bestVal = s;
                          }
                        }

                        const logText = analysis.scoringLogs?.[rule.key];
                        const isCustom = rule.type === "custom";
                        
                        const pct = ruleMax > 0 ? (bestVal / ruleMax) * 100 : 0;
                        const barColor = isOverridden ? "bg-blue-500" : bestVal >= ruleMax * 0.7 ? "bg-emerald-500" : bestVal > 0 ? "bg-amber-500" : "bg-muted-foreground/30";
                        const textColor = isOverridden ? "text-blue-500" : "text-foreground";

                        return (
                          <div key={rule.key} className="px-3 py-2 space-y-1">
                            <div className="flex items-center gap-3">
                              <span className={`text-xs w-36 shrink-0 ${isCustom ? "text-primary" : "text-muted-foreground"}`}>
                                {rule.label}
                                {isOverridden && <span className="ml-1.5 text-[8px] text-blue-500 border border-blue-500/20 bg-blue-500/10 px-1 py-0.5 rounded">HR Edited</span>}
                              </span>
                              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${barColor}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className={`text-xs font-mono w-12 text-right ${textColor}`}>{bestVal}/{ruleMax}</span>
                            </div>
                            {logText && (
                              <p className="text-[11px] text-muted-foreground pl-[9.5rem] leading-relaxed">{logText}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {analysis.strengths?.length > 0 && (
                  <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
                    <p className="text-xs font-medium text-emerald-400 mb-2">Strengths</p>
                    <ul className="space-y-1">{analysis.strengths.map((s: string, i: number) => <li key={i} className="text-xs text-foreground">• {s}</li>)}</ul>
                  </div>
                )}
                {analysis.gaps?.length > 0 && (
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                    <p className="text-xs font-medium text-amber-400 mb-2">Gaps</p>
                    <ul className="space-y-1">{analysis.gaps.map((g: string, i: number) => <li key={i} className="text-xs text-foreground">• {g}</li>)}</ul>
                  </div>
                )}
              </div>

              {analysis.flags?.length > 0 && (
                <div className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-3">
                  <p className="text-xs font-medium text-rose-400 mb-2">Red Flags / Disqualifiers</p>
                  <ul className="space-y-1">{analysis.flags.map((f: string, i: number) => <li key={i} className="text-xs text-foreground">• {f}</li>)}</ul>
                </div>
              )}

              {analysis.skillBreakdown && (
                <div className="bg-background/50 rounded-lg p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Skills Analysis ({analysis.skillBreakdown.matchPercent}% Match)</p>
                  <div className="flex flex-wrap gap-1">
                    {(analysis.skillBreakdown.matchedSkills || []).map((s: string, i: number) => (
                      <span key={i} className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">{s}</span>
                    ))}
                    {(analysis.skillBreakdown.missingSkills || []).map((s: string, i: number) => (
                      <span key={i} className="px-2 py-0.5 rounded-full text-[10px] bg-rose-500/15 text-rose-400 border border-rose-500/20">{s}</span>
                    ))}
                  </div>
                </div>
              )}

              {analysis.experienceSummary && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                  <p className="text-xs font-medium text-primary mb-1">AI Summary</p>
                  <p className="text-xs text-foreground">{analysis.experienceSummary}</p>
                  {analysis.remarks && <p className="text-xs text-muted-foreground mt-1 italic">{analysis.remarks}</p>}
                </div>
              )}

              <details>
                <summary className="text-xs text-primary cursor-pointer hover:text-primary/80">View Scoring Logs</summary>
                <div className="mt-2 space-y-2">
                  {Object.entries(analysis.scoringLogs || {}).map(([key, log]) => (
                    <div key={key} className="bg-background/50 rounded-lg p-2">
                      <span className="text-[10px] text-primary font-medium uppercase">{key}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">{log as string}</p>
                    </div>
                  ))}
                </div>
              </details>

              {analysis.__debug && (
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">Debug Info</summary>
                  <div className="mt-2 space-y-2">
                    <div className="bg-background/50 rounded-lg p-2">
                      <span className="text-[10px] text-muted-foreground font-medium">Model</span>
                      <p className="text-xs text-muted-foreground font-mono">{analysis.__debug.model}</p>
                    </div>
                    {analysis.__debug.usage && (() => {
                      const usage = analysis.__debug.usage;
                      const cost = estimateCost(usage.prompt_tokens, usage.completion_tokens, analysis.__debug.model);
                      return (
                        <div className="bg-background/50 rounded-lg p-2">
                          <span className="text-[10px] text-muted-foreground font-medium">Token Usage</span>
                          <p className="text-xs text-muted-foreground font-mono">Prompt: {usage.prompt_tokens} | Completion: {usage.completion_tokens} | Total: {usage.total_tokens}</p>
                          {cost ? (
                            <p className="text-xs text-emerald-400/80 font-mono mt-0.5">Cost: {formatCost(cost.totalCost)} (in {formatCost(cost.inputCost)} + out {formatCost(cost.outputCost)})</p>
                          ) : (
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">pricing unknown for {analysis.__debug.model}</p>
                          )}
                        </div>
                      );
                    })()}
                    {analysis.__debug.preComputed && (
                      <div className="bg-background/50 rounded-lg p-2">
                        <span className="text-[10px] text-muted-foreground font-medium">Pre-computed</span>
                        <p className="text-xs text-muted-foreground font-mono">Stability: {String(analysis.__debug.preComputed.stability)} | Location: {String(analysis.__debug.preComputed.location)}</p>
                      </div>
                    )}
                    <details className="ml-2">
                      <summary className="text-[10px] text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">System Prompt</summary>
                      <pre className="mt-1 text-[10px] text-muted-foreground bg-background rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">{analysis.__debug.systemPrompt}</pre>
                    </details>
                    <details className="ml-2">
                      <summary className="text-[10px] text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">User Prompt</summary>
                      <pre className="mt-1 text-[10px] text-muted-foreground bg-background rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">{analysis.__debug.userPrompt}</pre>
                    </details>
                  </div>
                </details>
              )}
            </div>
          )}

          {profile && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {publicId && <Field label="Profile ID" value={publicId} />}
                {profile.provider_id && <Field label="Provider ID" value={profile.provider_id} />}
                {profile.industry && <Field label="Industry" value={profile.industry} />}
                {profile.connections_count && <Field label="Connections" value={String(profile.connections_count)} />}
              </div>

              {profile.summary && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">About</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap line-clamp-4">{profile.summary}</p>
                </div>
              )}

              {profile.work_experience?.length > 0 && (
                <ExpandableList
                  title="Experience"
                  items={profile.work_experience}
                  initialCount={3}
                  renderItem={(exp: any, i: number) => (
                    <div key={i} className="bg-background/50 rounded-lg p-3">
                      <p className="text-sm font-medium text-foreground">{exp.position || "Untitled Role"}</p>
                      <p className="text-xs text-muted-foreground">{exp.company || ""}</p>
                      {exp.start && <p className="text-xs text-muted-foreground/70 mt-0.5">{exp.start} – {exp.end || "Present"}</p>}
                    </div>
                  )}
                />
              )}

              {profile.education?.length > 0 && (
                <ExpandableList
                  title="Education"
                  items={profile.education}
                  initialCount={2}
                  renderItem={(edu: any, i: number) => (
                    <div key={i} className="bg-background/50 rounded-lg p-3">
                      <p className="text-sm font-medium text-foreground">{edu.school || "Unknown School"}</p>
                      <p className="text-xs text-muted-foreground">{edu.degree || ""}</p>
                    </div>
                  )}
                />
              )}
            </>
          )}

          <details className="mt-2">
            <summary className="text-xs text-primary cursor-pointer hover:text-primary/80">View raw JSON</summary>
            <pre className="mt-2 text-xs text-muted-foreground bg-background rounded-lg p-3 overflow-x-auto max-h-64">{JSON.stringify(profile, null, 2)}</pre>
          </details>

          <a href={task.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80">
            Open LinkedIn Profile ↗
          </a>
        </div>
      )}
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-xs text-foreground">{value}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background/50 rounded-lg p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground truncate">{value}</p>
    </div>
  );
}

function StatTile({ label, value, icon: Icon, tone }: {
  label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone: "neutral" | "emerald" | "amber" | "rose";
}) {
  const tones: Record<string, string> = {
    neutral: "text-foreground",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber:   "text-amber-600 dark:text-amber-400",
    rose:    "text-rose-600 dark:text-rose-400",
  };
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </div>
        <p className={cn("text-2xl font-bold mt-1", tones[tone])}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ExpandableList({ title, items, initialCount, renderItem }: {
  title: string;
  items: any[];
  initialCount: number;
  renderItem: (item: any, index: number) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, initialCount);
  const remaining = items.length - initialCount;

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{title}</p>
      <div className="space-y-2">
        {visible.map((item, i) => renderItem(item, i))}
        {remaining > 0 && (
          <button onClick={() => setShowAll(!showAll)} className="text-xs text-primary hover:text-primary/80 font-medium transition-colors">
            {showAll ? "Show less" : `+${remaining} more`}
          </button>
        )}
      </div>
    </div>
  );
}
