"use client";

import { useState } from "react";
import { Plus, Trash2, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChannelType = "LINKEDIN" | "EMAIL" | "WHATSAPP";

interface Account { id: string; accountId: string; name: string; type: string; }

interface Followup { afterDays: number; template: string; subjectTemplate?: string; }

// LinkedIn
interface InviteRule {
  key: string; minScore: number; maxScore: number;
  inviteType: "CONNECTION_REQUEST" | "INMAIL";
  noteTemplate: string; messageTemplate: string; priority: number;
}
export interface LinkedInFormValues {
  name: string; sendingAccountId: string; dailyCap: number; dailyInMailCap: number;
  inviteRules: InviteRule[]; archiveAfterInviteDays: number; followups: Followup[];
  replyWaitDays: number;
  connectedFirstMessage: string;
}

// Email
interface EmailRule {
  key: string; minScore: number; maxScore: number;
  subjectTemplate: string; bodyTemplate: string; priority: number;
}
export interface EmailFormValues {
  name: string; sendingAccountId: string; dailyCap: number;
  emailRules: EmailRule[]; followups: Followup[];
  contactRetryMinutes: number; contactRetryMaxDays: number;
  replyWaitDays: number;
}

// WhatsApp
interface WARule {
  key: string; minScore: number; maxScore: number;
  messageTemplate: string; priority: number;
}
interface QuietHours { startHour: number; endHour: number; tz: string; }
export interface WAFormValues {
  name: string; sendingAccountId: string; dailyCap: number;
  waRules: WARule[]; followups: Followup[];
  quietHoursEnabled: boolean; quietHours: QuietHours;
  contactRetryMinutes: number; contactRetryMaxDays: number;
  replyWaitDays: number;
}

export type ChannelFormValues = LinkedInFormValues | EmailFormValues | WAFormValues;

interface Props {
  type: ChannelType;
  accounts: Account[];
  initialValues?: ChannelFormValues;
  onSubmit: (values: ChannelFormValues) => Promise<void>;
  submitLabel?: string;
}

// ─── Template variable chips ──────────────────────────────────────────────────

const VARS = ["{{firstName}}", "{{name}}", "{{company}}", "{{role}}", "{{score}}"];

function VarChips({ onInsert }: { onInsert: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {VARS.map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(v)}
          className="text-[10px] font-mono bg-primary/10 text-primary border border-primary/20 rounded px-1.5 py-0.5 hover:bg-primary/20 transition-colors"
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// ─── Shared fields ────────────────────────────────────────────────────────────

function SharedFields({
  name, setName, sendingAccountId, setSendingAccountId, dailyCap, setDailyCap, accounts,
}: {
  name: string; setName: (v: string) => void;
  sendingAccountId: string; setSendingAccountId: (v: string) => void;
  dailyCap: number; setDailyCap: (v: number) => void;
  accounts: Account[];
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2 space-y-1.5">
        <Label className="text-xs">Channel name <span className="text-destructive">*</span></Label>
        <Input
          required value={name} onChange={e => setName(e.target.value)}
          className="h-8 text-sm" placeholder="e.g. LinkedIn Outreach — Senior Engineers"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Sending account</Label>
        <Select value={sendingAccountId} onValueChange={setSendingAccountId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select account…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">None</SelectItem>
            {accounts.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name || a.accountId}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Daily send cap</Label>
        <Input
          type="number" min={1} max={500} value={dailyCap}
          onChange={e => setDailyCap(Number(e.target.value))}
          className="h-8 text-sm"
        />
      </div>
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, description, action }: {
  title: string; description?: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ─── Followup list (shared across all channel types) ─────────────────────────

function FollowupList({
  followups, onChange, showSubject = false,
}: {
  followups: Followup[];
  onChange: (f: Followup[]) => void;
  showSubject?: boolean;
}) {
  function addFollowup() {
    const lastDays = followups[followups.length - 1]?.afterDays ?? 0;
    onChange([...followups, { afterDays: lastDays + 3, template: "", subjectTemplate: "" }]);
  }
  function removeFollowup(i: number) {
    onChange(followups.filter((_, idx) => idx !== i));
  }
  function updateFollowup(i: number, patch: Partial<Followup>) {
    onChange(followups.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Follow-up messages"
        description="Sent if the candidate doesn't reply. Stacked in order."
        action={
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={addFollowup}>
            <Plus className="h-3 w-3" /> Add follow-up
          </Button>
        }
      />
      {followups.length === 0 && (
        <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg p-3 text-center">
          No follow-ups — candidates who don't reply will be archived after the initial message.
        </p>
      )}
      {followups.map((f, i) => (
        <div key={i} className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Follow-up {i + 1}</span>
            <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeFollowup(i)}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Label className="text-xs whitespace-nowrap">Send after</Label>
            <Input
              type="number" min={1} max={90} value={f.afterDays}
              onChange={e => updateFollowup(i, { afterDays: Number(e.target.value) })}
              className="h-7 text-sm w-20"
            />
            <span className="text-xs text-muted-foreground">days of no reply</span>
          </div>
          {showSubject && (
            <div className="space-y-1.5">
              <Label className="text-xs">Subject line</Label>
              <Input
                value={f.subjectTemplate ?? ""} placeholder="Re: Your application"
                onChange={e => updateFollowup(i, { subjectTemplate: e.target.value })}
                className="h-7 text-sm"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Message</Label>
            <textarea
              value={f.template}
              onChange={e => updateFollowup(i, { template: e.target.value })}
              rows={3}
              placeholder="Hi {{firstName}}, just following up…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <VarChips onInsert={v => updateFollowup(i, { template: f.template + v })} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Reply-wait field (shared across all channel types) ──────────────────────
//
// After the LAST message is sent, the candidate gets this many days to reply
// before the thread is auto-archived. Prevents archiving someone the instant
// the final follow-up goes out (they'd have zero chance to respond).

function ReplyWaitField({
  value, onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Wait for reply (days)</Label>
      <div className="flex items-center gap-3">
        <Input
          type="number" min={1} max={90} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="h-8 text-sm w-24"
        />
        <span className="text-xs text-muted-foreground">
          After the final message, wait this long for a reply before archiving.
        </span>
      </div>
    </div>
  );
}

// ─── Contact retry fields (Email + WhatsApp) ──────────────────────────────────

function ContactRetryFields({
  retryMinutes, setRetryMinutes,
  maxDays, setMaxDays,
}: {
  retryMinutes: number; setRetryMinutes: (v: number) => void;
  maxDays: number; setMaxDays: (v: number) => void;
}) {
  // Determine if value is cleanly expressible in hours
  const isHours = retryMinutes >= 60 && retryMinutes % 60 === 0;
  const [unit, setUnit] = useState<"minutes" | "hours">(isHours ? "hours" : "minutes");
  const displayValue = unit === "hours" ? retryMinutes / 60 : retryMinutes;

  function handleValueChange(raw: number) {
    const mins = unit === "hours" ? raw * 60 : raw;
    setRetryMinutes(Math.max(1, mins));
  }
  function handleUnitChange(u: "minutes" | "hours") {
    setUnit(u);
    // Convert the current display value to the new unit's minutes
    const mins = u === "hours" ? displayValue * 60 : displayValue;
    setRetryMinutes(Math.max(1, mins));
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">Contact retry</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          If no contact info yet, retry on this schedule until Airscale enrichment fills it in.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Retry every</Label>
          <div className="flex gap-1.5">
            <Input
              type="number" min={1} max={unit === "hours" ? 168 : 1440}
              value={displayValue}
              onChange={e => handleValueChange(Number(e.target.value))}
              className="h-8 text-sm"
            />
            <Select value={unit} onValueChange={v => handleUnitChange(v as any)}>
              <SelectTrigger className="h-8 text-sm w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Give up after (days)</Label>
          <Input
            type="number" min={1} max={30} value={maxDays}
            onChange={e => setMaxDays(Number(e.target.value))}
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Archive if still no contact after N days</p>
        </div>
      </div>
    </div>
  );
}

// ─── LinkedIn form ────────────────────────────────────────────────────────────

function defaultLinkedInRule(priority = 0): InviteRule {
  return { key: `rule-${Date.now()}`, minScore: 70, maxScore: 100, inviteType: "CONNECTION_REQUEST", noteTemplate: "", messageTemplate: "", priority };
}

function LinkedInForm({ accounts, initial, onSubmit, submitLabel }: {
  accounts: Account[]; initial?: LinkedInFormValues;
  onSubmit: (v: LinkedInFormValues) => Promise<void>; submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [sendingAccountId, setSendingAccountId] = useState(initial?.sendingAccountId ?? "_none");
  const [dailyCap, setDailyCap] = useState(initial?.dailyCap ?? 20);
  const [dailyInMailCap, setDailyInMailCap] = useState(initial?.dailyInMailCap ?? 5);
  const [archiveAfterInviteDays, setArchiveAfterInviteDays] = useState(initial?.archiveAfterInviteDays ?? 14);
  const [replyWaitDays, setReplyWaitDays] = useState(initial?.replyWaitDays ?? 5);
  const [connectedFirstMessage, setConnectedFirstMessage] = useState(initial?.connectedFirstMessage ?? "");
  const [inviteRules, setInviteRules] = useState<InviteRule[]>(initial?.inviteRules ?? [defaultLinkedInRule()]);
  const [followups, setFollowups] = useState<Followup[]>(initial?.followups ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedRule, setExpandedRule] = useState<number>(0);

  function addRule() {
    setInviteRules(r => [...r, defaultLinkedInRule(r.length)]);
    setExpandedRule(inviteRules.length);
  }
  function removeRule(i: number) {
    setInviteRules(r => r.filter((_, idx) => idx !== i));
  }
  function updateRule(i: number, patch: Partial<InviteRule>) {
    setInviteRules(r => r.map((rule, idx) => idx === i ? { ...rule, ...patch } : rule));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Channel name is required"); return; }
    if (inviteRules.length === 0) { setError("At least one invite rule is required"); return; }
    for (const rule of inviteRules) {
      if (rule.minScore > rule.maxScore) { setError("Min score must be ≤ max score in each rule"); return; }
    }
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(), sendingAccountId: sendingAccountId === "_none" ? "" : sendingAccountId,
        dailyCap, dailyInMailCap, archiveAfterInviteDays, inviteRules, followups, replyWaitDays,
        connectedFirstMessage: connectedFirstMessage.trim(),
      });
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <SharedFields name={name} setName={setName} sendingAccountId={sendingAccountId} setSendingAccountId={setSendingAccountId} dailyCap={dailyCap} setDailyCap={setDailyCap} accounts={accounts} />

      {/* InMail cap + invite timeout */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">InMail daily cap</Label>
          <Input type="number" min={1} max={50} value={dailyInMailCap} onChange={e => setDailyInMailCap(Number(e.target.value))} className="h-8 text-sm" />
          <p className="text-[10px] text-muted-foreground">InMail credits are scarce — keep this low</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Archive invite after (days)</Label>
          <Input type="number" min={1} max={90} value={archiveAfterInviteDays} onChange={e => setArchiveAfterInviteDays(Number(e.target.value))} className="h-8 text-sm" />
          <p className="text-[10px] text-muted-foreground">If not accepted within N days, archive</p>
        </div>
      </div>

      <Separator />

      {/* Invite rules */}
      <div className="space-y-3">
        <SectionHeader
          title="Score band rules"
          description="Map score ranges to outreach method. Highest priority wins if bands overlap."
          action={
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={addRule}>
              <Plus className="h-3 w-3" /> Add rule
            </Button>
          }
        />
        {inviteRules.map((rule, i) => (
          <div key={i} className="rounded-lg border border-border bg-muted/20 overflow-hidden">
            {/* Rule header / collapse toggle */}
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
              onClick={() => setExpandedRule(expandedRule === i ? -1 : i)}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium">Rule {i + 1}</span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {rule.minScore}%–{rule.maxScore}% → {rule.inviteType === "CONNECTION_REQUEST" ? "Connection" : "InMail"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {inviteRules.length > 1 && (
                  <span
                    role="button"
                    onClick={e => { e.stopPropagation(); removeRule(i); }}
                    className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                )}
                {expandedRule === i ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
            </button>

            {expandedRule === i && (
              <div className="px-3 pb-3 space-y-4 border-t border-border/60">
                <div className="grid grid-cols-3 gap-3 pt-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Min score %</Label>
                    <Input type="number" min={0} max={100} value={rule.minScore} onChange={e => updateRule(i, { minScore: Number(e.target.value) })} className="h-7 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Max score %</Label>
                    <Input type="number" min={0} max={100} value={rule.maxScore} onChange={e => updateRule(i, { maxScore: Number(e.target.value) })} className="h-7 text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Priority</Label>
                    <Input type="number" min={0} value={rule.priority} onChange={e => updateRule(i, { priority: Number(e.target.value) })} className="h-7 text-sm" />
                    <p className="text-[10px] text-muted-foreground">Higher = preferred</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Send method</Label>
                  <Select value={rule.inviteType} onValueChange={v => updateRule(i, { inviteType: v as any })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CONNECTION_REQUEST">Connection request</SelectItem>
                      <SelectItem value="INMAIL">InMail (direct message)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {rule.inviteType === "CONNECTION_REQUEST" ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Connection note <span className="text-muted-foreground">(optional, max 300 chars)</span></Label>
                      <span className={cn("text-[10px]", rule.noteTemplate.length > 280 ? "text-amber-500" : "text-muted-foreground")}>{rule.noteTemplate.length}/300</span>
                    </div>
                    <textarea
                      value={rule.noteTemplate} rows={3}
                      maxLength={300}
                      placeholder="Hi {{firstName}}, I came across your profile…"
                      onChange={e => updateRule(i, { noteTemplate: e.target.value })}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <VarChips onInsert={v => updateRule(i, { noteTemplate: rule.noteTemplate + v })} />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs">InMail message <span className="text-destructive">*</span></Label>
                    <textarea
                      required value={rule.messageTemplate} rows={4}
                      placeholder="Hi {{firstName}}, came across your background as {{role}} at {{company}} and wanted to reach out about an opportunity…"
                      onChange={e => updateRule(i, { messageTemplate: e.target.value })}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <VarChips onInsert={v => updateRule(i, { messageTemplate: rule.messageTemplate + v })} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <Separator />

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground bg-primary/5 border border-primary/15 rounded-lg p-2.5">
          <strong>Followup order:</strong> Follow-up [0] is sent as the first DM after a connection is accepted. For InMail, follow-ups start immediately after the InMail is sent.
        </p>
      </div>

      <FollowupList followups={followups} onChange={setFollowups} />

      <div className="space-y-1.5">
        <Label className="text-xs">First message if already connected <span className="text-muted-foreground">(optional)</span></Label>
        <p className="text-[10px] text-muted-foreground">
          For candidates you're already connected to (1st-degree). No invite/note is sent to them, so this is delivered as their first DM, before the follow-ups. Leave blank to reuse the connection note above.
        </p>
        <textarea
          value={connectedFirstMessage} rows={3}
          placeholder="Hi {{firstName}}, came across your profile at {{company}} and wanted to reach out about a role we're hiring for…"
          onChange={e => setConnectedFirstMessage(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <VarChips onInsert={v => setConnectedFirstMessage(connectedFirstMessage + v)} />
      </div>

      <ReplyWaitField value={replyWaitDays} onChange={setReplyWaitDays} />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5 min-w-28">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ─── Email form ───────────────────────────────────────────────────────────────

function defaultEmailRule(priority = 0): EmailRule {
  return { key: `rule-${Date.now()}`, minScore: 70, maxScore: 100, subjectTemplate: "", bodyTemplate: "", priority };
}

function EmailForm({ accounts, initial, onSubmit, submitLabel }: {
  accounts: Account[]; initial?: EmailFormValues;
  onSubmit: (v: EmailFormValues) => Promise<void>; submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [sendingAccountId, setSendingAccountId] = useState(initial?.sendingAccountId ?? "_none");
  const [dailyCap, setDailyCap] = useState(initial?.dailyCap ?? 50);
  const [emailRules, setEmailRules] = useState<EmailRule[]>(initial?.emailRules ?? [defaultEmailRule()]);
  const [followups, setFollowups] = useState<Followup[]>(initial?.followups ?? []);
  const [contactRetryMinutes, setContactRetryMinutes] = useState(initial?.contactRetryMinutes ?? 60);
  const [contactRetryMaxDays, setContactRetryMaxDays] = useState(initial?.contactRetryMaxDays ?? 7);
  const [replyWaitDays, setReplyWaitDays] = useState(initial?.replyWaitDays ?? 5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedRule, setExpandedRule] = useState(0);

  function addRule() { setEmailRules(r => [...r, defaultEmailRule(r.length)]); setExpandedRule(emailRules.length); }
  function removeRule(i: number) { setEmailRules(r => r.filter((_, idx) => idx !== i)); }
  function updateRule(i: number, patch: Partial<EmailRule>) { setEmailRules(r => r.map((rule, idx) => idx === i ? { ...rule, ...patch } : rule)); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!name.trim()) { setError("Channel name is required"); return; }
    if (emailRules.length === 0) { setError("At least one email rule is required"); return; }
    for (const rule of emailRules) {
      if (rule.minScore > rule.maxScore) { setError("Min score must be ≤ max score"); return; }
      if (!rule.subjectTemplate.trim()) { setError("Subject line is required for each rule"); return; }
      if (!rule.bodyTemplate.trim()) { setError("Email body is required for each rule"); return; }
    }
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), sendingAccountId: sendingAccountId === "_none" ? "" : sendingAccountId, dailyCap, emailRules, followups, contactRetryMinutes, contactRetryMaxDays, replyWaitDays });
    } catch (err: any) { setError(err.message || "Failed to save"); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <SharedFields name={name} setName={setName} sendingAccountId={sendingAccountId} setSendingAccountId={setSendingAccountId} dailyCap={dailyCap} setDailyCap={setDailyCap} accounts={accounts} />
      <Separator />

      <div className="space-y-3">
        <SectionHeader title="Score band rules" description="Map score ranges to email templates. Highest priority wins if bands overlap."
          action={<Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={addRule}><Plus className="h-3 w-3" /> Add rule</Button>}
        />
        {emailRules.map((rule, i) => (
          <div key={i} className="rounded-lg border border-border bg-muted/20 overflow-hidden">
            <button type="button" className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-muted/40 transition-colors" onClick={() => setExpandedRule(expandedRule === i ? -1 : i)}>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium">Rule {i + 1}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{rule.minScore}%–{rule.maxScore}%</span>
                {rule.subjectTemplate && <span className="text-[10px] text-muted-foreground truncate max-w-48">{rule.subjectTemplate}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                {emailRules.length > 1 && <span role="button" onClick={e => { e.stopPropagation(); removeRule(i); }} className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"><Trash2 className="h-3 w-3" /></span>}
                {expandedRule === i ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
            </button>
            {expandedRule === i && (
              <div className="px-3 pb-3 space-y-4 border-t border-border/60">
                <div className="grid grid-cols-3 gap-3 pt-3">
                  <div className="space-y-1.5"><Label className="text-xs">Min score %</Label><Input type="number" min={0} max={100} value={rule.minScore} onChange={e => updateRule(i, { minScore: Number(e.target.value) })} className="h-7 text-sm" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Max score %</Label><Input type="number" min={0} max={100} value={rule.maxScore} onChange={e => updateRule(i, { maxScore: Number(e.target.value) })} className="h-7 text-sm" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Priority</Label><Input type="number" min={0} value={rule.priority} onChange={e => updateRule(i, { priority: Number(e.target.value) })} className="h-7 text-sm" /></div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Subject line <span className="text-destructive">*</span></Label>
                  <Input value={rule.subjectTemplate} onChange={e => updateRule(i, { subjectTemplate: e.target.value })} placeholder="{{firstName}}, saw your work at {{company}}" className="h-8 text-sm" />
                  <VarChips onInsert={v => updateRule(i, { subjectTemplate: rule.subjectTemplate + v })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Email body <span className="text-destructive">*</span></Label>
                  <textarea value={rule.bodyTemplate} rows={5} placeholder="Hi {{firstName}},&#10;&#10;I came across your profile and…" onChange={e => updateRule(i, { bodyTemplate: e.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                  <VarChips onInsert={v => updateRule(i, { bodyTemplate: rule.bodyTemplate + v })} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <Separator />
      <FollowupList followups={followups} onChange={setFollowups} showSubject />

      <ReplyWaitField value={replyWaitDays} onChange={setReplyWaitDays} />

      <Separator />
      <ContactRetryFields
        retryMinutes={contactRetryMinutes} setRetryMinutes={setContactRetryMinutes}
        maxDays={contactRetryMaxDays} setMaxDays={setContactRetryMaxDays}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5 min-w-28">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ─── WhatsApp form ────────────────────────────────────────────────────────────

function defaultWARule(priority = 0): WARule {
  return { key: `rule-${Date.now()}`, minScore: 70, maxScore: 100, messageTemplate: "", priority };
}

function WAForm({ accounts, initial, onSubmit, submitLabel }: {
  accounts: Account[]; initial?: WAFormValues;
  onSubmit: (v: WAFormValues) => Promise<void>; submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [sendingAccountId, setSendingAccountId] = useState(initial?.sendingAccountId ?? "_none");
  const [dailyCap, setDailyCap] = useState(initial?.dailyCap ?? 30);
  const [waRules, setWARules] = useState<WARule[]>(initial?.waRules ?? [defaultWARule()]);
  const [followups, setFollowups] = useState<Followup[]>(initial?.followups ?? []);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(initial?.quietHoursEnabled ?? true);
  const [quietHours, setQuietHours] = useState<QuietHours>(initial?.quietHours ?? { startHour: 21, endHour: 8, tz: "Asia/Kolkata" });
  const [contactRetryMinutes, setContactRetryMinutes] = useState(initial?.contactRetryMinutes ?? 60);
  const [contactRetryMaxDays, setContactRetryMaxDays] = useState(initial?.contactRetryMaxDays ?? 7);
  const [replyWaitDays, setReplyWaitDays] = useState(initial?.replyWaitDays ?? 5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedRule, setExpandedRule] = useState(0);

  function addRule() { setWARules(r => [...r, defaultWARule(r.length)]); setExpandedRule(waRules.length); }
  function removeRule(i: number) { setWARules(r => r.filter((_, idx) => idx !== i)); }
  function updateRule(i: number, patch: Partial<WARule>) { setWARules(r => r.map((rule, idx) => idx === i ? { ...rule, ...patch } : rule)); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (!name.trim()) { setError("Channel name is required"); return; }
    if (waRules.length === 0) { setError("At least one rule is required"); return; }
    for (const rule of waRules) {
      if (rule.minScore > rule.maxScore) { setError("Min score must be ≤ max score"); return; }
      if (!rule.messageTemplate.trim()) { setError("Message template is required"); return; }
    }
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(), sendingAccountId: sendingAccountId === "_none" ? "" : sendingAccountId,
        dailyCap, waRules, followups, quietHoursEnabled,
        quietHours: quietHoursEnabled ? quietHours : { startHour: 21, endHour: 8, tz: "UTC" },
        contactRetryMinutes, contactRetryMaxDays, replyWaitDays,
      });
    } catch (err: any) { setError(err.message || "Failed to save"); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <SharedFields name={name} setName={setName} sendingAccountId={sendingAccountId} setSendingAccountId={setSendingAccountId} dailyCap={dailyCap} setDailyCap={setDailyCap} accounts={accounts} />
      <Separator />

      <div className="space-y-3">
        <SectionHeader title="Score band rules" description="Map score ranges to WhatsApp message templates."
          action={<Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={addRule}><Plus className="h-3 w-3" /> Add rule</Button>}
        />
        {waRules.map((rule, i) => (
          <div key={i} className="rounded-lg border border-border bg-muted/20 overflow-hidden">
            <button type="button" className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-muted/40 transition-colors" onClick={() => setExpandedRule(expandedRule === i ? -1 : i)}>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium">Rule {i + 1}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{rule.minScore}%–{rule.maxScore}%</span>
              </div>
              <div className="flex items-center gap-1.5">
                {waRules.length > 1 && <span role="button" onClick={e => { e.stopPropagation(); removeRule(i); }} className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"><Trash2 className="h-3 w-3" /></span>}
                {expandedRule === i ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
            </button>
            {expandedRule === i && (
              <div className="px-3 pb-3 space-y-4 border-t border-border/60">
                <div className="grid grid-cols-3 gap-3 pt-3">
                  <div className="space-y-1.5"><Label className="text-xs">Min score %</Label><Input type="number" min={0} max={100} value={rule.minScore} onChange={e => updateRule(i, { minScore: Number(e.target.value) })} className="h-7 text-sm" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Max score %</Label><Input type="number" min={0} max={100} value={rule.maxScore} onChange={e => updateRule(i, { maxScore: Number(e.target.value) })} className="h-7 text-sm" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Priority</Label><Input type="number" min={0} value={rule.priority} onChange={e => updateRule(i, { priority: Number(e.target.value) })} className="h-7 text-sm" /></div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Message <span className="text-destructive">*</span></Label>
                  <textarea value={rule.messageTemplate} rows={4} placeholder="Hi {{firstName}}, I came across your profile…" onChange={e => updateRule(i, { messageTemplate: e.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                  <VarChips onInsert={v => updateRule(i, { messageTemplate: rule.messageTemplate + v })} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <Separator />
      <FollowupList followups={followups} onChange={setFollowups} />

      <ReplyWaitField value={replyWaitDays} onChange={setReplyWaitDays} />

      <Separator />
      <ContactRetryFields
        retryMinutes={contactRetryMinutes} setRetryMinutes={setContactRetryMinutes}
        maxDays={contactRetryMaxDays} setMaxDays={setContactRetryMaxDays}
      />

      <Separator />
      {/* Quiet hours */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Quiet hours</p>
            <p className="text-xs text-muted-foreground mt-0.5">Hold messages during off-hours to avoid account bans</p>
          </div>
          <button type="button" onClick={() => setQuietHoursEnabled(e => !e)} className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none", quietHoursEnabled ? "bg-primary" : "bg-input")}>
            <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform", quietHoursEnabled ? "translate-x-4.5" : "translate-x-0.5")} />
          </button>
        </div>
        {quietHoursEnabled && (
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Start hour (24h)</Label>
              <Input type="number" min={0} max={23} value={quietHours.startHour} onChange={e => setQuietHours(q => ({ ...q, startHour: Number(e.target.value) }))} className="h-7 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">End hour (24h)</Label>
              <Input type="number" min={0} max={23} value={quietHours.endHour} onChange={e => setQuietHours(q => ({ ...q, endHour: Number(e.target.value) }))} className="h-7 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Timezone</Label>
              <Input value={quietHours.tz} onChange={e => setQuietHours(q => ({ ...q, tz: e.target.value }))} placeholder="Asia/Kolkata" className="h-7 text-sm" />
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5 min-w-28">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ─── Public ChannelForm dispatcher ────────────────────────────────────────────

export function ChannelForm({ type, accounts, initialValues, onSubmit, submitLabel = "Create channel" }: Props) {
  const filtered = accounts.filter(a => a.type === type);
  switch (type) {
    case "LINKEDIN":
      return <LinkedInForm accounts={filtered} initial={initialValues as LinkedInFormValues} onSubmit={onSubmit as any} submitLabel={submitLabel} />;
    case "EMAIL":
      return <EmailForm accounts={filtered} initial={initialValues as EmailFormValues} onSubmit={onSubmit as any} submitLabel={submitLabel} />;
    case "WHATSAPP":
      return <WAForm accounts={filtered} initial={initialValues as WAFormValues} onSubmit={onSubmit as any} submitLabel={submitLabel} />;
  }
}
