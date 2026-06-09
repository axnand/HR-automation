"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Plus, Pencil, Trash2, Pause, Play, Loader2,
  Link2, Mail, MessageCircle, Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ChannelForm,
  type ChannelType,
  type ChannelFormValues,
  type LinkedInFormValues,
  type EmailFormValues,
  type WAFormValues,
} from "./ChannelForm";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Account { id: string; accountId: string; name: string; type: string; }

interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  status: string;
  dailyCap: number;
  dailyInMailCap: number;
  config: Record<string, unknown>;
  sendingAccountId: string | null;
  sendingAccount: Account | null;
  createdAt: string;
  _count: { threads: number };
  // Populated only when fetched with ?missing=1: outreach-lifecycle candidates
  // matching this channel's rules that have no live thread yet (ACTIVE only).
  missingThreadCount?: number;
}

interface Props { requisitionId: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  ACTIVE:   "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
  PAUSED:   "bg-amber-500/10 text-amber-500 border-amber-500/30",
  ARCHIVED: "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

const TYPE_META: Record<ChannelType, { label: string; icon: React.ReactNode; color: string; description: string }> = {
  LINKEDIN:  {
    label: "LinkedIn",
    icon: <Link2 className="h-5 w-5" />,
    color: "text-[#0077B5]",
    description: "Connection requests, InMail, and DM follow-ups via Unipile.",
  },
  EMAIL: {
    label: "Email",
    icon: <Mail className="h-5 w-5" />,
    color: "text-violet-500",
    description: "Multi-step email sequences with subject + body templates.",
  },
  WHATSAPP: {
    label: "WhatsApp",
    icon: <MessageCircle className="h-5 w-5" />,
    color: "text-emerald-500",
    description: "WhatsApp outreach with quiet-hours enforcement via Unipile.",
  },
};

// Convert a Channel DB record → ChannelFormValues for editing
function channelToFormValues(channel: Channel): ChannelFormValues {
  const cfg = channel.config;
  const base = {
    name: channel.name,
    sendingAccountId: channel.sendingAccountId ?? "",
    dailyCap: channel.dailyCap,
  };

  if (channel.type === "LINKEDIN") {
    return {
      ...base,
      dailyInMailCap: channel.dailyInMailCap,
      inviteRules:  (cfg.inviteRules as LinkedInFormValues["inviteRules"]) ?? [],
      archiveAfterInviteDays: (cfg.archiveAfterInviteDays as number) ?? 14,
      followups: (cfg.followups as LinkedInFormValues["followups"]) ?? [],
      replyWaitDays: (cfg.replyWaitDays as number) ?? 5,
      connectedFirstMessage: (cfg.connectedFirstMessage as string) ?? "",
    } satisfies LinkedInFormValues;
  }

  if (channel.type === "EMAIL") {
    return {
      ...base,
      emailRules: (cfg.emailRules as EmailFormValues["emailRules"]) ?? [],
      followups:  (cfg.followups  as EmailFormValues["followups"])  ?? [],
      contactRetryMinutes: (cfg.contactRetryMinutes as number) ?? 60,
      contactRetryMaxDays: (cfg.contactRetryMaxDays as number) ?? 7,
      replyWaitDays: (cfg.replyWaitDays as number) ?? 5,
    } satisfies EmailFormValues;
  }

  // WHATSAPP
  return {
    ...base,
    waRules: (cfg.waRules as WAFormValues["waRules"]) ?? [],
    followups: (cfg.followups as WAFormValues["followups"]) ?? [],
    quietHoursEnabled: (cfg.quietHoursEnabled as boolean) ?? true,
    quietHours: (cfg.quietHours as WAFormValues["quietHours"]) ?? { startHour: 21, endHour: 8, tz: "Asia/Kolkata" },
    contactRetryMinutes: (cfg.contactRetryMinutes as number) ?? 60,
    contactRetryMaxDays: (cfg.contactRetryMaxDays as number) ?? 7,
    replyWaitDays: (cfg.replyWaitDays as number) ?? 5,
  } satisfies WAFormValues;
}

// Convert ChannelFormValues → API POST/PATCH body
function formValuesToApiBody(values: ChannelFormValues, type: ChannelType) {
  const { name, sendingAccountId, dailyCap, ...rest } = values as any;

  const body: Record<string, unknown> = {
    name,
    type,
    sendingAccountId: sendingAccountId || null,
    dailyCap,
  };

  if (type === "LINKEDIN") {
    body.dailyInMailCap = rest.dailyInMailCap;
    body.config = {
      inviteRules: rest.inviteRules,
      archiveAfterInviteDays: rest.archiveAfterInviteDays,
      followups: rest.followups,
      replyWaitDays: rest.replyWaitDays,
      connectedFirstMessage: rest.connectedFirstMessage,
    };
  } else if (type === "EMAIL") {
    body.config = {
      emailRules: rest.emailRules,
      followups: rest.followups,
      contactRetryMinutes: rest.contactRetryMinutes,
      contactRetryMaxDays: rest.contactRetryMaxDays,
      replyWaitDays: rest.replyWaitDays,
    };
  } else {
    body.config = {
      waRules: rest.waRules,
      followups: rest.followups,
      quietHoursEnabled: rest.quietHoursEnabled,
      quietHours: rest.quietHours,
      contactRetryMinutes: rest.contactRetryMinutes,
      contactRetryMaxDays: rest.contactRetryMaxDays,
      replyWaitDays: rest.replyWaitDays,
    };
  }

  return body;
}

// ─── UI states ────────────────────────────────────────────────────────────────

type UIState =
  | { mode: "list" }
  | { mode: "pick-type" }
  | { mode: "create"; channelType: ChannelType }
  | { mode: "edit"; channel: Channel };

// ─── Type picker cards ────────────────────────────────────────────────────────

function TypePickerCards({ onPick }: { onPick: (t: ChannelType) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Choose channel type</p>
        <p className="text-xs text-muted-foreground mt-0.5">Select how you want to reach out to shortlisted candidates.</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {(["LINKEDIN", "EMAIL", "WHATSAPP"] as ChannelType[]).map(type => {
          const meta = TYPE_META[type];
          return (
            <button
              key={type}
              type="button"
              onClick={() => onPick(type)}
              className="flex flex-col items-start gap-3 rounded-xl border border-border bg-background p-4 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={cn("rounded-lg bg-muted p-2", meta.color)}>
                {meta.icon}
              </span>
              <div>
                <p className="text-sm font-semibold">{meta.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{meta.description}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ChannelsTab({ requisitionId }: Props) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState<UIState>({ mode: "list" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/channels?missing=1`);
      const data = await res.json();
      setChannels(data.channels ?? []);
    } catch {
      toast.error("Failed to load channels");
    } finally {
      setLoading(false);
    }
  }, [requisitionId]);

  useEffect(() => {
    fetchChannels();
    fetch("/api/accounts")
      .then(r => r.json())
      .then(d => setAccounts(d.accounts ?? []))
      .catch(() => {});
  }, [fetchChannels]);

  async function handleCreate(values: ChannelFormValues) {
    if (ui.mode !== "create") return;
    const body = formValuesToApiBody(values, ui.channelType);
    const res = await fetch(`/api/requisitions/${requisitionId}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || "Failed to create channel");
    }
    await fetchChannels();
    setUi({ mode: "list" });
    toast.success("Channel created");
  }

  async function handleUpdate(values: ChannelFormValues) {
    if (ui.mode !== "edit") return;
    const { name, sendingAccountId, dailyCap, ...rest } = values as any;

    const body: Record<string, unknown> = { name, sendingAccountId: sendingAccountId || null, dailyCap };

    if (ui.channel.type === "LINKEDIN") {
      body.dailyInMailCap = rest.dailyInMailCap;
      body.config = {
        inviteRules: rest.inviteRules,
        archiveAfterInviteDays: rest.archiveAfterInviteDays,
        followups: rest.followups,
        replyWaitDays: rest.replyWaitDays,
        connectedFirstMessage: rest.connectedFirstMessage,
      };
    } else if (ui.channel.type === "EMAIL") {
      body.config = {
        emailRules: rest.emailRules,
        followups: rest.followups,
        contactRetryMinutes: rest.contactRetryMinutes,
        contactRetryMaxDays: rest.contactRetryMaxDays,
        replyWaitDays: rest.replyWaitDays,
      };
    } else {
      body.config = {
        waRules: rest.waRules,
        followups: rest.followups,
        quietHoursEnabled: rest.quietHoursEnabled,
        quietHours: rest.quietHours,
        contactRetryMinutes: rest.contactRetryMinutes,
        contactRetryMaxDays: rest.contactRetryMaxDays,
        replyWaitDays: rest.replyWaitDays,
      };
    }

    const res = await fetch(`/api/requisitions/${requisitionId}/channels/${ui.channel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || "Failed to update channel");
    }
    await fetchChannels();
    setUi({ mode: "list" });
    toast.success("Channel updated");
  }

  async function handleDelete(channelId: string) {
    setDeleting(channelId);
    try {
      await fetch(`/api/requisitions/${requisitionId}/channels/${channelId}`, { method: "DELETE" });
      setChannels(prev => prev.filter(c => c.id !== channelId));
      toast.success("Channel archived");
    } catch {
      toast.error("Failed to archive channel");
    } finally {
      setDeleting(null);
    }
  }

  async function handleToggle(channel: Channel) {
    const newStatus = channel.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setToggling(channel.id);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error();
      setChannels(prev => prev.map(c => c.id === channel.id ? { ...c, status: newStatus } : c));
      toast.success(newStatus === "ACTIVE" ? "Channel activated" : "Channel paused");
      // Activating/pausing changes which candidates count as "missing" a thread
      // on this channel — refresh the badge counts.
      fetchChannels();
    } catch {
      toast.error("Failed to update channel status");
    } finally {
      setToggling(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
    );
  }

  const isFormOpen = ui.mode === "pick-type" || ui.mode === "create" || ui.mode === "edit";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Outreach Channels</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Multi-channel outreach sequences for shortlisted candidates — LinkedIn, Email, WhatsApp.
          </p>
        </div>
        {!isFormOpen && (
          <Button size="sm" className="gap-1.5" onClick={() => setUi({ mode: "pick-type" })}>
            <Plus className="h-3.5 w-3.5" />
            New channel
          </Button>
        )}
      </div>

      {/* Inline panel — type picker, create form, or edit form */}
      {isFormOpen && (
        <div className="rounded-xl border border-border bg-background">
          <div className="bg-muted/40 px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-sm font-medium">
              {ui.mode === "pick-type" && "New channel"}
              {ui.mode === "create" && `New ${TYPE_META[ui.channelType].label} channel`}
              {ui.mode === "edit" && `Edit — ${ui.channel.name}`}
            </span>
            <Button
              variant="ghost" size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => setUi({ mode: "list" })}
            >
              Cancel
            </Button>
          </div>

          <div className="p-6">
            {ui.mode === "pick-type" && (
              <TypePickerCards onPick={type => setUi({ mode: "create", channelType: type })} />
            )}
            {ui.mode === "create" && (
              <ChannelForm
                type={ui.channelType}
                accounts={accounts}
                onSubmit={handleCreate}
                submitLabel="Create channel"
              />
            )}
            {ui.mode === "edit" && (
              <ChannelForm
                type={ui.channel.type}
                accounts={accounts}
                initialValues={channelToFormValues(ui.channel)}
                onSubmit={handleUpdate}
                submitLabel="Save changes"
              />
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isFormOpen && channels.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center border border-dashed border-border rounded-xl py-14 px-4">
          <Radio className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-semibold text-muted-foreground">No channels yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">
            Create a channel to automatically reach out to shortlisted candidates across LinkedIn, Email, and WhatsApp.
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={() => setUi({ mode: "pick-type" })}>
            <Plus className="h-3.5 w-3.5" />
            New channel
          </Button>
        </div>
      )}

      {/* Channel list table */}
      {!isFormOpen && channels.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden bg-background">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Channel</th>
                <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-32">Type</th>
                <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-24">Cap / day</th>
                <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-32">Account</th>
                <th className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground w-24">Threads</th>
                <th className="px-4 py-2.5 w-28" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {channels.map(channel => {
                const meta = TYPE_META[channel.type];
                return (
                  <tr key={channel.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{channel.name}</span>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] h-5 px-2 rounded-full shrink-0", STATUS_STYLES[channel.status] ?? STATUS_STYLES.ARCHIVED)}
                        >
                          {channel.status}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center gap-1.5 text-xs", meta.color)}>
                        {meta.icon && <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{meta.icon}</span>}
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {channel.dailyCap}
                      {channel.type === "LINKEDIN" && channel.dailyInMailCap > 0 && (
                        <span className="ml-1 text-[10px] text-muted-foreground/60">({channel.dailyInMailCap} InMail)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-0 w-32">
                      {channel.sendingAccount?.name || channel.sendingAccount?.accountId || <span className="italic opacity-50">none</span>}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <span>{channel._count.threads}</span>
                        {channel.status === "ACTIVE" && (channel.missingThreadCount ?? 0) > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] h-5 px-2 rounded-full border-amber-500/30 bg-amber-500/10 text-amber-500 cursor-default"
                            title="Shortlisted candidates that match this channel's rules but have no thread yet. Select them in the Pipeline and click 'Fan out to channels' to start outreach."
                          >
                            {channel.missingThreadCount} missing
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {(channel.status === "ACTIVE" || channel.status === "PAUSED") && (
                          <Button
                            variant="ghost" size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground"
                            disabled={toggling === channel.id}
                            onClick={() => handleToggle(channel)}
                            title={channel.status === "ACTIVE" ? "Pause" : "Activate"}
                          >
                            {toggling === channel.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : channel.status === "ACTIVE"
                                ? <Pause className="h-3.5 w-3.5" />
                                : <Play className="h-3.5 w-3.5" />
                            }
                          </Button>
                        )}
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground"
                          onClick={() => setUi({ mode: "edit", channel })}
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          disabled={deleting === channel.id}
                          onClick={() => handleDelete(channel.id)}
                          title="Archive"
                        >
                          {deleting === channel.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />
                          }
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
