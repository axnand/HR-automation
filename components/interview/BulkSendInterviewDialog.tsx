"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ChannelKind = "LINKEDIN" | "EMAIL" | "WHATSAPP";

type PreviewItem = {
  taskId: string;
  candidateName: string | null;
  channelType: ChannelKind | null;
  reason: string | null;
};

type Preview = {
  total: number;
  byChannel: Record<ChannelKind, number>;
  skipped: number;
  items: PreviewItem[];
};

const CHANNEL_LABEL: Record<ChannelKind, string> = {
  LINKEDIN: "LinkedIn",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
};

const OVERRIDES = ["AUTO", "LINKEDIN", "WHATSAPP", "EMAIL"] as const;
type Override = (typeof OVERRIDES)[number];

// Trigger E — the bulk confirmation dialog (docs/interview-flow.md §6). Default is
// auto (best channel per candidate); the recruiter can force one channel for the
// whole batch, and the breakdown recomputes live so the skip cost is visible
// BEFORE sending. Skipped candidates are always listed — no silent truncation.
export function BulkSendInterviewDialog({
  requisitionId,
  taskIds,
  open,
  onOpenChange,
  onDone,
  stageNote,
}: {
  requisitionId: string;
  taskIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
  /** Optional advisory shown above the breakdown (e.g. "3 haven't replied yet"). */
  stageNote?: string | null;
}) {
  const [override, setOverride] = useState<Override>("AUTO");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(
    async (ov: Override) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-send-interview/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds, channel: ov === "AUTO" ? undefined : ov }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Preview failed");
        setPreview(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        setLoading(false);
      }
    },
    [requisitionId, taskIds],
  );

  useEffect(() => {
    if (open) {
      setOverride("AUTO");
      loadPreview("AUTO");
    }
  }, [open, loadPreview]);

  function changeOverride(ov: Override) {
    setOverride(ov);
    loadPreview(ov);
  }

  async function confirm() {
    setSending(true);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/candidates/bulk-send-interview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds, channel: override === "AUTO" ? undefined : override }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      toast.success(
        `Sent ${data.sent} · skipped ${data.skipped}${data.failed ? ` · failed ${data.failed}` : ""}`,
      );
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  const skippedItems = preview?.items.filter((i) => !i.channelType) ?? [];
  const sendableCount = preview ? preview.total - preview.skipped : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Send interview link · {taskIds.length} candidate{taskIds.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        {stageNote && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-700 dark:text-amber-400">
            <span>{stageNote}</span>
          </div>
        )}

        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Channel</p>
          <div className="flex flex-wrap gap-2">
            {OVERRIDES.map((ov) => (
              <button
                key={ov}
                type="button"
                onClick={() => changeOverride(ov)}
                disabled={loading || sending}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-50",
                  override === ov ? "bg-primary text-white border-primary" : "border-border hover:bg-muted",
                )}
              >
                {ov === "AUTO" ? "Auto (best per candidate)" : CHANNEL_LABEL[ov]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="py-8 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Calculating…
          </div>
        ) : error ? (
          <div className="py-4 text-sm text-destructive">{error}</div>
        ) : preview ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              {(["LINKEDIN", "WHATSAPP", "EMAIL"] as ChannelKind[]).map((c) =>
                preview.byChannel[c] > 0 ? (
                  <span key={c} className="px-2 py-1 rounded-md bg-muted">
                    {preview.byChannel[c]} {CHANNEL_LABEL[c]}
                  </span>
                ) : null,
              )}
              {preview.skipped > 0 && (
                <span className="px-2 py-1 rounded-md bg-destructive/15 text-destructive">
                  {preview.skipped} skipped
                </span>
              )}
              {sendableCount === 0 && <span className="text-muted-foreground">Nothing sendable.</span>}
            </div>

            {skippedItems.length > 0 && (
              <div className="border border-border rounded-lg p-2 max-h-40 overflow-y-auto">
                <p className="text-[11px] font-semibold text-muted-foreground mb-1">Skipped ({skippedItems.length})</p>
                <ul className="space-y-1">
                  {skippedItems.map((i) => (
                    <li key={i.taskId} className="text-[11px] flex justify-between gap-2">
                      <span className="truncate">{i.candidateName ?? i.taskId.slice(-8)}</span>
                      <span className="text-muted-foreground shrink-0">{i.reason ?? "no channel"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={sending || loading || sendableCount === 0}>
            {sending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
            Send to {sendableCount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
