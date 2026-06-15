"use client";

import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Check, X, GripVertical, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

const LINK_TOKEN = "{{interviewLink}}";
const LINK_TOKEN_RE = /\{\{\s*interviewLink\s*\}\}/i;

interface InterviewQuestion {
  id: string;
  order: number;
  text: string;
  mustAsk?: boolean;
  idealAnswer?: string;
  weight?: number;
}

interface Props {
  requisitionId: string;
  initialConfig: any;
  globalQuestions?: InterviewQuestion[];
  onSaved?: () => void;
}

function coerceQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is InterviewQuestion =>
      q && typeof q === "object" && typeof q.id === "string" && typeof q.text === "string",
  );
}

export function InterviewTab({ requisitionId, initialConfig, globalQuestions = [], onSaved }: Props) {
  const cfg = initialConfig || {};
  const interviewCfg = cfg.interview || {};

  const [trigger, setTrigger] = useState<"MANUAL" | "ON_INTERVIEW_STAGE">(
    interviewCfg.trigger === "ON_INTERVIEW_STAGE" ? "ON_INTERVIEW_STAGE" : "MANUAL",
  );
  const [roleQuestions, setRoleQuestions] = useState<InterviewQuestion[]>(
    coerceQuestions(interviewCfg.questions),
  );

  const [newText, setNewText] = useState("");
  const [newMust, setNewMust] = useState(false);
  const [newIdeal, setNewIdeal] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Per-role message template (overrides the global default). { subject?, body }.
  const initialTemplate = interviewCfg.messageTemplate || {};
  const [templateBody, setTemplateBody] = useState<string>(initialTemplate.body ?? "");
  const [templateSubject, setTemplateSubject] = useState<string>(initialTemplate.subject ?? "");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Each save sends ONLY the changed keys; the requisition PUT route deep-merges
  // the `interview` object, so saving questions can't wipe the messageTemplate
  // (or vice-versa).
  async function saveInterviewConfig(patch: {
    trigger?: string;
    questions?: InterviewQuestion[];
    messageTemplate?: { subject?: string; body: string } | null;
  }) {
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interview: patch }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setSaveError(d.error || `Save failed (${res.status})`);
        setTimeout(() => setSaveError(null), 4000);
        return false;
      }
      onSaved?.();
      return true;
    } catch {
      setSaveError("Network error — changes not saved");
      setTimeout(() => setSaveError(null), 4000);
      return false;
    }
  }

  function insertLinkToken() {
    const el = bodyRef.current;
    if (!el) {
      setTemplateBody((b) => (b ? `${b} ${LINK_TOKEN}` : LINK_TOKEN));
      return;
    }
    const start = el.selectionStart ?? templateBody.length;
    const end = el.selectionEnd ?? templateBody.length;
    setTemplateBody(templateBody.slice(0, start) + LINK_TOKEN + templateBody.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + LINK_TOKEN.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const templateHasLink = LINK_TOKEN_RE.test(templateBody);

  async function saveTemplate() {
    if (templateBody.trim() && !templateHasLink) return; // guard: must contain the link
    setSavingKey("template");
    const payload = templateBody.trim()
      ? { messageTemplate: { subject: templateSubject.trim() || undefined, body: templateBody } }
      : { messageTemplate: null }; // cleared → fall back to global/default
    const ok = await saveInterviewConfig(payload);
    setSavingKey(null);
    if (ok) {
      setSavedKey("template");
      setTimeout(() => setSavedKey(k => (k === "template" ? null : k)), 2000);
    }
  }

  async function handleTriggerChange(next: "MANUAL" | "ON_INTERVIEW_STAGE") {
    setTrigger(next);
    setSavingKey("trigger");
    const ok = await saveInterviewConfig({ trigger: next });
    setSavingKey(null);
    if (ok) {
      setSavedKey("trigger");
      setTimeout(() => setSavedKey(k => (k === "trigger" ? null : k)), 2000);
    }
  }

  async function addQuestion() {
    if (!newText.trim()) return;
    const next: InterviewQuestion[] = [
      ...roleQuestions,
      {
        id: `q-role-${Date.now()}`,
        order: roleQuestions.length + 1,
        text: newText.trim(),
        mustAsk: newMust,
        idealAnswer: newIdeal.trim() || undefined,
        weight: 1.0,
      },
    ];
    setRoleQuestions(next);
    setSavingKey("add");
    const ok = await saveInterviewConfig({ questions: next });
    setSavingKey(null);
    if (ok) {
      setNewText("");
      setNewMust(false);
      setNewIdeal("");
      setSavedKey("add");
      setTimeout(() => setSavedKey(k => (k === "add" ? null : k)), 1500);
    }
  }

  async function removeQuestion(id: string) {
    const next = roleQuestions.filter(q => q.id !== id);
    setRoleQuestions(next);
    setSavingKey(id);
    await saveInterviewConfig({ questions: next });
    setSavingKey(null);
  }

  async function toggleMust(id: string) {
    const next = roleQuestions.map(q => q.id === id ? { ...q, mustAsk: !q.mustAsk } : q);
    setRoleQuestions(next);
    await saveInterviewConfig({ questions: next });
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {saveError && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-destructive/30 bg-destructive/5 text-sm text-destructive">
          <X className="h-4 w-4 shrink-0" />
          {saveError}
        </div>
      )}

      {/* ── Auto-send trigger ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Interview Trigger</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            When should the interview link be automatically sent to a candidate?
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            {(["MANUAL", "ON_INTERVIEW_STAGE"] as const).map(opt => (
              <label
                key={opt}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                  trigger === opt
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:bg-muted/30",
                )}
              >
                <input
                  type="radio"
                  name="trigger"
                  value={opt}
                  checked={trigger === opt}
                  onChange={() => handleTriggerChange(opt)}
                  className="mt-0.5 accent-primary"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {opt === "MANUAL" ? "Manual only" : "On interview stage"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {opt === "MANUAL"
                      ? "The interview link is never sent automatically — only via the Send button or bulk send."
                      : "Automatically send the interview link when a candidate is moved to the Interview stage."}
                  </p>
                </div>
              </label>
            ))}
          </div>
          {savedKey === "trigger" && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <Check className="h-3 w-3" /> Saved
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Message template (per-role override) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Interview Message</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            The message sent to candidates with their interview link, for this role. Leave blank to use the
            org-wide default from Settings → Interview. Variables: <code className="text-[11px]">{"{{firstName}}"}</code>,{" "}
            <code className="text-[11px]">{"{{name}}"}</code>, <code className="text-[11px]">{"{{role}}"}</code>, and the
            required <code className="text-[11px]">{LINK_TOKEN}</code>.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Subject (email only)</Label>
            <Input
              value={templateSubject}
              onChange={e => setTemplateSubject(e.target.value)}
              placeholder="Interview for the {{role}} role"
              className="mt-1.5"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Message body</Label>
              <button
                type="button"
                onClick={insertLinkToken}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:text-primary/80"
              >
                <Link2 className="h-3 w-3" />
                Insert interview link
              </button>
            </div>
            <Textarea
              ref={bodyRef}
              value={templateBody}
              onChange={e => setTemplateBody(e.target.value)}
              rows={7}
              placeholder={`Hi {{firstName}},\n\nWe'd love for you to take a short interview: ${LINK_TOKEN}`}
              className="mt-1.5 font-mono text-xs"
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-[11px] text-muted-foreground">
                <code className="text-[10px]">{LINK_TOKEN}</code> is where each candidate&apos;s link is inserted.
              </p>
              <div className="flex items-center gap-2">
                {savedKey === "template" && (
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Saved
                  </span>
                )}
                <Button size="sm" className="h-7 text-xs" onClick={saveTemplate} disabled={savingKey === "template" || (!!templateBody.trim() && !templateHasLink)}>
                  {savingKey === "template" ? "Saving…" : "Save message"}
                </Button>
              </div>
            </div>
            {!!templateBody.trim() && !templateHasLink && (
              <p className="text-[11px] text-destructive mt-1">
                The message must include {LINK_TOKEN} — click “Insert interview link”.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Inherited global questions (read-only) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inherited Global Questions</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            These come from Settings → Interview and are asked in every interview. They cannot be edited here.
          </p>
        </CardHeader>
        <CardContent>
          {globalQuestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No global questions configured yet.</p>
          ) : (
            <ul className="space-y-2">
              {globalQuestions.map((q, i) => (
                <li
                  key={q.id}
                  className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5 opacity-70"
                >
                  <span className="text-xs font-mono text-muted-foreground mt-0.5 shrink-0 w-4">{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{q.text}</p>
                    {q.mustAsk && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-medium">
                        Must ask
                      </span>
                    )}
                  </div>
                  <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Role-specific questions ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Role-Specific Questions</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Added after the global questions. Asked only for this role.
              </p>
            </div>
            <span className="text-xs font-mono text-muted-foreground">{roleQuestions.length}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {roleQuestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No role-specific questions yet.</p>
          ) : (
            <ul className="space-y-2">
              {roleQuestions.map((q, i) => (
                <li key={q.id} className="rounded-lg border border-border bg-card p-3 space-y-1.5">
                  <div className="flex items-start gap-3">
                    <span className="text-xs font-mono text-muted-foreground mt-0.5 shrink-0 w-4">
                      {globalQuestions.length + i + 1}.
                    </span>
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm text-foreground">{q.text}</p>
                      {q.idealAnswer && (
                        <p className="text-xs text-muted-foreground italic line-clamp-2">
                          Ideal: {q.idealAnswer}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground">Must ask</span>
                        <Switch
                          checked={q.mustAsk ?? false}
                          onCheckedChange={() => toggleMust(q.id)}
                          className="scale-75"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeQuestion(q.id)}
                        disabled={savingKey === q.id}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Add role-specific question</Label>
            <Textarea
              placeholder="Question text…"
              value={newText}
              rows={2}
              onChange={e => setNewText(e.target.value)}
            />
            <Input
              placeholder="Ideal answer (optional — helps with future scoring)"
              value={newIdeal}
              onChange={e => setNewIdeal(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="roleMustAsk"
                checked={newMust}
                onChange={e => setNewMust(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              <label htmlFor="roleMustAsk" className="text-xs text-muted-foreground cursor-pointer">
                Must ask
              </label>
            </div>
            <Button
              onClick={addQuestion}
              disabled={!newText.trim() || savingKey === "add"}
              variant="outline"
              size="sm"
              className="w-full gap-2"
            >
              <Plus className="h-3.5 w-3.5" />
              {savingKey === "add" ? "Saving…" : savedKey === "add" ? <><Check className="h-3 w-3" /> Added</> : "Add Question"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
