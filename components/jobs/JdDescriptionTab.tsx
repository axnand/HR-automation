"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, Eye, Check, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_CRITICAL_INSTRUCTIONS } from "@/lib/analyzer";
import { MODEL_PRICING, estimateCost, formatCost } from "@/lib/model-pricing";

// Rough estimate: ~4 chars per token for English text. Good enough for a UI hint.
const APPROX_CHARS_PER_TOKEN = 4;
// Typical analyzer output size for one profile. The hard cap (max_tokens) is 2000
// but real responses fit well under that; 800 is a reasonable average.
const ESTIMATED_OUTPUT_TOKENS = 800;
function approxTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

interface EvalConfig {
  id: string;
  title: string;
  isDefault?: boolean;
  promptRole?: string | null;
  criticalInstructions?: string | null;
  promptGuidelines?: string | null;
  builtInRuleDescriptions?: any;
}

interface AiProvider {
  id: string;
  name: string;
  provider: string;
  models: string[];
  isDefault?: boolean;
}

interface SheetIntegration {
  id: string;
  name: string;
  url: string;
}

interface Props {
  requisitionId: string;
  initialConfig: any;
  initialTitle?: string;
  onSaved?: () => void;
}

export function JdDescriptionTab({ requisitionId, initialConfig, initialTitle, onSaved }: Props) {
  const cfg = initialConfig || {};

  // Job-level config
  const [jdTitle, setJdTitle] = useState<string>(cfg.jdTitle || initialTitle || "");
  const [jobDescription, setJobDescription] = useState<string>(cfg.jobDescription || "");
  const [promptRole, setPromptRole] = useState<string>(cfg.promptRole || "");
  const [criticalInstructions, setCriticalInstructions] = useState<string>(cfg.criticalInstructions || "");
  const [promptGuidelines, setPromptGuidelines] = useState<string>(cfg.promptGuidelines || "");
  const [aiModel, setAiModel] = useState<string>(cfg.aiModel || "");
  const [aiProviderId, setAiProviderId] = useState<string>(cfg.aiProviderId || "");
  const [sheetWebAppUrl, setSheetWebAppUrl] = useState<string>(cfg.sheetWebAppUrl || "");

  // Library data
  const [evalConfigs, setEvalConfigs] = useState<EvalConfig[]>([]);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [sheets, setSheets] = useState<SheetIntegration[]>([]);

  const [jdSaving, setJdSaving] = useState(false);
  const [jdSavedAt, setJdSavedAt] = useState<number | null>(null);
  const [savedJdTitle, setSavedJdTitle] = useState<string>(cfg.jdTitle || initialTitle || "");
  const [savedJobDescription, setSavedJobDescription] = useState<string>(cfg.jobDescription || "");
  const jdDirty = jdTitle !== savedJdTitle || jobDescription !== savedJobDescription;

  // Eval config editing state
  const [appliedConfigId, setAppliedConfigId] = useState<string | null>(null);
  const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);
  const [editForms, setEditForms] = useState<Record<string, Partial<EvalConfig>>>({});
  const [savingConfigId, setSavingConfigId] = useState<string | null>(null);
  const [showNewConfigForm, setShowNewConfigForm] = useState(false);
  const [newConfigForm, setNewConfigForm] = useState({
    title: "",
    promptRole: "",
    criticalInstructions: "",
    promptGuidelines: "",
  });
  const [savingNewConfig, setSavingNewConfig] = useState(false);

  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{ systemPrompt: string; userPrompt: string } | null>(null);

  // Sheet add form
  const [newSheetName, setNewSheetName] = useState("");
  const [newSheetUrl, setNewSheetUrl] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/evaluation-configs").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/ai-providers").then(r => r.ok ? r.json() : []).catch(() => []),
      fetch("/api/sheet-integrations").then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([e, p, s]) => {
      setEvalConfigs(e || []);
      setProviders(p || []);
      setSheets(s || []);
      // Auto-select system default if no config has been applied yet
      const defaultEc = (e || []).find((ec: EvalConfig) => ec.isDefault);
      if (defaultEc) {
        setAppliedConfigId(defaultEc.id);
        // Pre-populate textareas with defaults if job has no saved prompt config
        if (!cfg.promptRole && !cfg.criticalInstructions) {
          setPromptRole(DEFAULT_PROMPT_ROLE);
          setCriticalInstructions(DEFAULT_CRITICAL_INSTRUCTIONS);
          setPromptGuidelines("");
        }
      }
    });
  }, []);

  async function saveConfig(patch: Record<string, any>) {
    await fetch(`/api/requisitions/${requisitionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async function saveJd() {
    setJdSaving(true);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // title updates the requisition display name; jdTitle + jobDescription go into config
        body: JSON.stringify({ title: jdTitle, jdTitle, jobDescription }),
      });
      if (res.ok) {
        setSavedJdTitle(jdTitle);
        setSavedJobDescription(jobDescription);
        setJdSavedAt(Date.now());
        onSaved?.();
      }
    } finally {
      setJdSaving(false);
    }
  }

  // Auto-dismiss the "Saved" badge after 2.5s
  useEffect(() => {
    if (!jdSavedAt) return;
    const t = setTimeout(() => setJdSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [jdSavedAt]);

  const DEFAULT_PROMPT_ROLE = "You are a strict ATS evaluator.";

  function applyEvalConfig(ec: EvalConfig) {
    const role = ec.isDefault ? DEFAULT_PROMPT_ROLE : (ec.promptRole || "");
    const critical = ec.isDefault ? DEFAULT_CRITICAL_INSTRUCTIONS : (ec.criticalInstructions || "");
    const guidelines = ec.isDefault ? "" : (ec.promptGuidelines || "");
    setPromptRole(role);
    setCriticalInstructions(critical);
    setPromptGuidelines(guidelines);
    setAppliedConfigId(ec.id);
    saveConfig({
      promptRole: role,
      criticalInstructions: critical,
      promptGuidelines: guidelines,
      ...(!ec.isDefault && { builtInRuleDescriptions: ec.builtInRuleDescriptions }),
    });
  }

  function startEditConfig(ec: EvalConfig) {
    setEditForms(prev => ({
      ...prev,
      [ec.id]: {
        title: ec.title,
        promptRole: ec.promptRole || "",
        criticalInstructions: ec.criticalInstructions || "",
        promptGuidelines: ec.promptGuidelines || "",
      },
    }));
    setExpandedConfigId(ec.id);
  }

  function updateEditForm(id: string, field: string, value: string) {
    setEditForms(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  }

  async function saveEditConfig(id: string) {
    const form = editForms[id];
    if (!form) return;
    setSavingConfigId(id);
    try {
      const res = await fetch(`/api/evaluation-configs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        const updated = await res.json();
        setEvalConfigs(prev => prev.map(e => e.id === id ? { ...e, ...updated } : e));
        setExpandedConfigId(null);
      }
    } finally {
      setSavingConfigId(null);
    }
  }

  async function deleteEvalConfig(id: string) {
    const res = await fetch(`/api/evaluation-configs/${id}`, { method: "DELETE" });
    if (res.ok) {
      setEvalConfigs(prev => prev.filter(e => e.id !== id));
      if (expandedConfigId === id) setExpandedConfigId(null);
    }
  }

  async function createNewConfig() {
    if (!newConfigForm.title.trim()) return;
    setSavingNewConfig(true);
    try {
      const res = await fetch("/api/evaluation-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfigForm),
      });
      if (res.ok) {
        const created = await res.json();
        setEvalConfigs(prev => [...prev, created]);
        setNewConfigForm({ title: "", promptRole: "", criticalInstructions: "", promptGuidelines: "" });
        setShowNewConfigForm(false);
      }
    } finally {
      setSavingNewConfig(false);
    }
  }

  function setModel(providerId: string, model: string) {
    setAiProviderId(providerId);
    setAiModel(model);
    saveConfig({ aiProviderId: providerId, aiModel: model });
  }

  function selectSheet(url: string) {
    setSheetWebAppUrl(url);
    saveConfig({ sheetWebAppUrl: url });
  }

  async function addSheet() {
    if (!newSheetName.trim() || !newSheetUrl.trim()) return;
    const res = await fetch("/api/sheet-integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSheetName.trim(), url: newSheetUrl.trim() }),
    });
    if (res.ok) {
      const created = await res.json();
      setSheets(prev => [...prev, created]);
      setNewSheetName("");
      setNewSheetUrl("");
    }
  }

  async function deleteSheet(id: string) {
    const res = await fetch(`/api/sheet-integrations/${id}`, { method: "DELETE" });
    if (res.ok) setSheets(prev => prev.filter(s => s.id !== id));
  }

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const res = await fetch("/api/preview-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requisitionId,
          promptRole,
          promptGuidelines,
          criticalInstructions,
          jobDescription,
        }),
      });
      if (res.ok) setPreviewData(await res.json());
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* JD Title + Description */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Job Description</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                The title here is the role&apos;s display name everywhere in the app.
              </p>
            </div>
            {jdSaving ? (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                Saving…
              </span>
            ) : jdDirty ? (
              <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unsaved changes
              </span>
            ) : jdSavedAt ? (
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 transition-opacity">
                <Check className="h-3 w-3" /> Saved
              </span>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="jd-title">Role Title</Label>
            <Input
              id="jd-title"
              placeholder="e.g. Senior Sales AE"
              value={jdTitle}
              onChange={e => setJdTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="jd-body">Description</Label>
            <Textarea
              id="jd-body"
              rows={14}
              placeholder="Paste the full job description here…"
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={saveJd}
              disabled={jdSaving || !jdTitle.trim() || !jdDirty}
              className="h-7 px-3 text-xs gap-1.5"
            >
              {jdSaving ? "Saving…" : jdDirty ? "Save" : (
                <><Check className="h-3 w-3" /> Saved</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Evaluation Configs — full CRUD */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Evaluation Configs</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Manage AI identity, critical instructions, and guidelines. Apply one to this job.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs"
              onClick={() => {
                setShowNewConfigForm(v => !v);
                setExpandedConfigId(null);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              New Config
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* New config form */}
          {showNewConfigForm && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-medium text-foreground">Create New Config</p>
              <Input
                placeholder="Config name (e.g. Strict ATS)"
                value={newConfigForm.title}
                onChange={e => setNewConfigForm(f => ({ ...f, title: e.target.value }))}
                className="text-sm"
              />
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Prompt Role</Label>
                <Textarea
                  rows={2}
                  placeholder='e.g. "You are a strict ATS evaluator."'
                  value={newConfigForm.promptRole}
                  onChange={e => setNewConfigForm(f => ({ ...f, promptRole: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Critical Instructions</Label>
                <Textarea
                  rows={3}
                  placeholder="Override the CRITICAL INSTRUCTIONS block…"
                  value={newConfigForm.criticalInstructions}
                  onChange={e => setNewConfigForm(f => ({ ...f, criticalInstructions: e.target.value }))}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Prompt Guidelines</Label>
                <Textarea
                  rows={3}
                  placeholder="Additional evaluation nuance…"
                  value={newConfigForm.promptGuidelines}
                  onChange={e => setNewConfigForm(f => ({ ...f, promptGuidelines: e.target.value }))}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setShowNewConfigForm(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={createNewConfig}
                  disabled={!newConfigForm.title.trim() || savingNewConfig}
                >
                  {savingNewConfig ? "Creating…" : "Create"}
                </Button>
              </div>
            </div>
          )}

          {/* Config list */}
          {evalConfigs.length === 0 && !showNewConfigForm ? (
            <p className="text-xs text-muted-foreground italic">No configs yet. Create one above.</p>
          ) : (
            <div className="space-y-2">
              {evalConfigs.map(ec => {
                const isExpanded = expandedConfigId === ec.id;
                const isApplied = appliedConfigId === ec.id;
                const form = editForms[ec.id] || {
                  title: ec.title,
                  promptRole: ec.promptRole || "",
                  criticalInstructions: ec.criticalInstructions || "",
                  promptGuidelines: ec.promptGuidelines || "",
                };

                return (
                  <div
                    key={ec.id}
                    className={cn(
                      "rounded-lg border transition-all",
                      isApplied
                        ? "border-emerald-500/50 bg-emerald-500/5 dark:bg-emerald-500/10"
                        : isExpanded
                          ? "border-primary/40 bg-card"
                          : "border-border bg-card"
                    )}
                  >
                    {/* Row header */}
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                          {ec.title}
                          {ec.isDefault && (
                            <span className="text-[10px] text-muted-foreground font-normal">(system default)</span>
                          )}
                          {isApplied && (
                            <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          )}
                        </p>
                        {!isExpanded && (ec.promptRole || ec.promptGuidelines) && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                            {ec.promptRole || ec.promptGuidelines}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={isApplied ? "default" : "outline"}
                        className={cn(
                          "h-7 text-xs shrink-0",
                          isApplied && "bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                        )}
                        onClick={() => applyEvalConfig(ec)}
                      >
                        {isApplied ? <><Check className="h-3 w-3 mr-1" />Applied</> : "Apply"}
                      </Button>
                      {!ec.isDefault && (
                        <button
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedConfigId(null);
                            } else {
                              startEditConfig(ec);
                            }
                          }}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {isExpanded ? (
                            <X className="h-4 w-4" />
                          ) : (
                            <Pencil className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Inline edit form */}
                    {isExpanded && !ec.isDefault && (
                      <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Name</Label>
                          <Input
                            value={form.title || ""}
                            onChange={e => updateEditForm(ec.id, "title", e.target.value)}
                            className="text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Prompt Role</Label>
                          <Textarea
                            rows={2}
                            placeholder='e.g. "You are a strict ATS evaluator."'
                            value={form.promptRole || ""}
                            onChange={e => updateEditForm(ec.id, "promptRole", e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Critical Instructions</Label>
                          <Textarea
                            rows={4}
                            placeholder="Override the CRITICAL INSTRUCTIONS block…"
                            value={form.criticalInstructions || ""}
                            onChange={e => updateEditForm(ec.id, "criticalInstructions", e.target.value)}
                            className="font-mono text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Prompt Guidelines</Label>
                          <Textarea
                            rows={4}
                            placeholder="Additional evaluation nuance…"
                            value={form.promptGuidelines || ""}
                            onChange={e => updateEditForm(ec.id, "promptGuidelines", e.target.value)}
                            className="font-mono text-xs"
                          />
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => deleteEvalConfig(ec.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                            Delete
                          </Button>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => setExpandedConfigId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => saveEditConfig(ec.id)}
                              disabled={savingConfigId === ec.id}
                            >
                              {savingConfigId === ec.id ? "Saving…" : "Save"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Separator />

          {/* Applied eval prompt fields */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Applied to this job</p>
            <div className="space-y-1.5">
              <Label className="text-xs">Prompt Role</Label>
              <Textarea
                rows={2}
                placeholder='e.g. "You are a strict ATS evaluator."'
                value={promptRole}
                onChange={e => setPromptRole(e.target.value)}
                onBlur={() => saveConfig({ promptRole })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Critical Instructions</Label>
              <Textarea
                rows={4}
                placeholder="Override the CRITICAL INSTRUCTIONS block…"
                value={criticalInstructions}
                onChange={e => setCriticalInstructions(e.target.value)}
                onBlur={() => saveConfig({ criticalInstructions })}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Prompt Guidelines</Label>
              <Textarea
                rows={4}
                placeholder="Additional evaluation nuance, injected after critical instructions…"
                value={promptGuidelines}
                onChange={e => setPromptGuidelines(e.target.value)}
                onBlur={() => saveConfig({ promptGuidelines })}
                className="font-mono text-xs"
              />
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={openPreview} className="gap-2">
                <Eye className="h-3.5 w-3.5" />
                Preview Prompt
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Model / Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Model</CardTitle>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No AI providers configured. Add one in Settings → Models Configuration.
            </p>
          ) : (
            <div className="flex gap-3">
              {/* Step 1 — Provider */}
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Provider</Label>
                <Select
                  value={aiProviderId || ""}
                  onValueChange={pid => {
                    setAiProviderId(pid);
                    // Reset model when provider changes
                    const p = providers.find(p => p.id === pid);
                    const firstModel = p?.models?.[0] ?? "";
                    setAiModel(firstModel);
                    saveConfig({ aiProviderId: pid, aiModel: firstModel });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select provider…" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}{p.isDefault ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Step 2 — Model */}
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Model</Label>
                <Select
                  value={aiModel || ""}
                  disabled={!aiProviderId}
                  onValueChange={m => {
                    setAiModel(m);
                    saveConfig({ aiProviderId, aiModel: m });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={aiProviderId ? "Select model…" : "Choose provider first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(providers.find(p => p.id === aiProviderId)?.models ?? []).map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Google Sheets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Sheets Integration</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">Profiles above the minimum score auto-export to this sheet.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {sheets.length > 0 && (
            <div className="space-y-2">
              {sheets.map(s => {
                const active = sheetWebAppUrl === s.url;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border p-2",
                      active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-card"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectSheet(s.url)}
                      className="flex-1 text-left min-w-0"
                    >
                      <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{s.url}</p>
                    </button>
                    {active && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteSheet(s.id)}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Add a new sheet</Label>
            <Input
              placeholder="Name (e.g. Sales candidates)"
              value={newSheetName}
              onChange={e => setNewSheetName(e.target.value)}
            />
            <Input
              placeholder="https://script.google.com/macros/s/..."
              value={newSheetUrl}
              onChange={e => setNewSheetUrl(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={addSheet}
              disabled={!newSheetName.trim() || !newSheetUrl.trim()}
              className="w-full gap-2"
            >
              <Plus className="h-3.5 w-3.5" /> Add Sheet
            </Button>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label className="text-xs">Or enter a URL directly</Label>
            <Input
              placeholder="https://script.google.com/macros/s/..."
              value={sheetWebAppUrl}
              onChange={e => setSheetWebAppUrl(e.target.value)}
              onBlur={() => saveConfig({ sheetWebAppUrl })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Preview modal */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Prompt Preview</DialogTitle>
          </DialogHeader>
          {previewLoading || !previewData ? (
            <p className="text-sm text-muted-foreground">Compiling prompt…</p>
          ) : (() => {
            const sysTokens = approxTokens(previewData.systemPrompt);
            const userTokens = approxTokens(previewData.userPrompt);
            const inputTokens = sysTokens + userTokens;
            const totalTokens = inputTokens + ESTIMATED_OUTPUT_TOKENS;
            const pricing = aiModel ? MODEL_PRICING[aiModel] : undefined;
            const cost = aiModel
              ? estimateCost(inputTokens, ESTIMATED_OUTPUT_TOKENS, aiModel)
              : null;
            return (
              <>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Estimated tokens per profile</span>
                    <span className="font-mono">
                      {inputTokens.toLocaleString()} in + ~{ESTIMATED_OUTPUT_TOKENS.toLocaleString()} out
                      <span className="text-muted-foreground"> = {totalTokens.toLocaleString()}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      Estimated cost per profile{aiModel ? ` (${aiModel})` : ""}
                    </span>
                    <span className="font-mono">
                      {!aiModel ? (
                        <span className="text-muted-foreground">Select a model</span>
                      ) : !pricing || !cost ? (
                        <span className="text-muted-foreground">Pricing unknown</span>
                      ) : (
                        <>
                          {formatCost(cost.totalCost)}
                          <span className="text-muted-foreground">
                            {" "}({formatCost(cost.inputCost)} in + {formatCost(cost.outputCost)} out)
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground/80 pt-0.5">
                    Rough estimate: ~4 chars/token, ~{ESTIMATED_OUTPUT_TOKENS} output tokens assumed. Actual usage will vary with profile size.
                  </p>
                </div>
            <Tabs defaultValue="system">
              <TabsList>
                <TabsTrigger value="system">System</TabsTrigger>
                <TabsTrigger value="user">User</TabsTrigger>
              </TabsList>
              <TabsContent value="system">
                <pre className="text-xs text-foreground bg-muted rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono">
                  {previewData.systemPrompt}
                </pre>
              </TabsContent>
              <TabsContent value="user">
                <pre className="text-xs text-foreground bg-muted rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono">
                  {previewData.userPrompt}
                </pre>
              </TabsContent>
            </Tabs>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
