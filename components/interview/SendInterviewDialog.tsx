"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Copy, Send, AlertTriangle, Link2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const LINK_TOKEN = "{{interviewLink}}";
const LINK_TOKEN_RE = /\{\{\s*interviewLink\s*\}\}/i;

type ChannelKind = "LINKEDIN" | "EMAIL" | "WHATSAPP";

type PublicChannel = {
  channelType: ChannelKind;
  status: string;
  sendable: boolean;
  reason: string | null;
};

type Preview = {
  candidateName: string | null;
  link: string;
  sessionId: string;
  status: string;
  sentVia: string | null;
  alreadySent: boolean;
  picked: ChannelKind | null;
  channels: PublicChannel[];
  subject: string | null;
  body: string;
  hasLinkVar: boolean;
};

const CHANNEL_LABEL: Record<string, string> = {
  LINKEDIN: "LinkedIn",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  LINK_ONLY: "Link only",
};

// Trigger B — the single-send composer (docs/interview-flow.md §6). Shows the
// auto-picked channel pre-selected with the per-channel sendable breakdown, the
// rendered (editable) message, and a Copy-link fallback when nothing is sendable.
export function SendInterviewDialog({
  taskId,
  requisitionId,
  open,
  onOpenChange,
  onSent,
}: {
  taskId: string;
  requisitionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}) {
  // The send-interview route mirrors send-dm's location; the requisitionId path
  // segment isn't used by the handler, so "_" is a safe placeholder for legacy
  // tasks with no requisition.
  const reqSeg = requisitionId ?? "_";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [channel, setChannel] = useState<ChannelKind | null>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setPreview(null);
      try {
        const res = await fetch(`/api/requisitions/${reqSeg}/candidates/${taskId}/send-interview`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load preview");
        if (cancelled) return;
        setPreview(data);
        setChannel(data.picked);
        setBody(data.body ?? "");
        setSubject(data.subject ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, taskId, reqSeg]);

  const link = preview?.link ?? "";
  // Accept the {{interviewLink}} token (preferred) or the raw link pasted in.
  const bodyHasLink = LINK_TOKEN_RE.test(body) || (!!link && body.includes(link));
  const isEmail = channel === "EMAIL";

  function insertLinkToken() {
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => (b ? `${b} ${LINK_TOKEN}` : LINK_TOKEN));
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + LINK_TOKEN + body.slice(end);
    setBody(next);
    // Restore caret just after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + LINK_TOKEN.length;
      el.setSelectionRange(pos, pos);
    });
  }
  const selectedReason = channel
    ? preview?.channels.find((c) => c.channelType === channel && !c.sendable)?.reason ?? null
    : null;
  const canSend = !!channel && !selectedReason && bodyHasLink && (!isEmail || subject.trim().length > 0);

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Interview link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  async function handleSend() {
    if (!preview || !channel) return;
    setSending(true);
    try {
      const res = await fetch(`/api/requisitions/${reqSeg}/candidates/${taskId}/send-interview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          text: body,
          subject: isEmail ? subject : undefined,
          allowResend: preview.alreadySent,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      toast.success(`Interview link sent via ${CHANNEL_LABEL[channel]}`);
      onSent?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            Send interview link{preview?.candidateName ? ` · ${preview.candidateName}` : ""}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Preparing…
          </div>
        ) : error ? (
          <div className="py-6 text-sm text-destructive">{error}</div>
        ) : preview ? (
          <div className="space-y-4 min-w-0 w-full">
            {preview.alreadySent && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {preview.status === "IN_PROGRESS"
                    ? "This candidate has already opened an interview link."
                    : `An interview link was already sent${
                        preview.sentVia ? ` via ${CHANNEL_LABEL[preview.sentVia] ?? preview.sentVia}` : ""
                      }.`}{" "}
                  Sending again delivers a new message.
                </span>
              </div>
            )}

            <div>
              <Label className="text-xs">Channel</Label>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {preview.channels.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No open channel with this candidate — copy the link to share it manually.
                  </span>
                ) : (
                  preview.channels.map((c) => (
                    <button
                      key={c.channelType}
                      type="button"
                      disabled={!c.sendable}
                      title={c.reason ?? undefined}
                      onClick={() => setChannel(c.channelType)}
                      className={cn(
                        "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                        channel === c.channelType
                          ? "bg-primary text-white border-primary"
                          : "border-border hover:bg-muted",
                        !c.sendable && "opacity-40 cursor-not-allowed line-through",
                      )}
                    >
                      {CHANNEL_LABEL[c.channelType]}
                    </button>
                  ))
                )}
              </div>
              {selectedReason && <p className="text-[11px] text-destructive mt-1">{selectedReason}</p>}
            </div>

            {isEmail && (
              <div>
                <Label className="text-xs">Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1.5" />
              </div>
            )}

            <div>
              <div className="flex items-center justify-between min-w-0">
                <Label className="text-xs">Message</Label>
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
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                className="mt-1.5 text-sm resize-none"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                <code className="text-[10px]">{LINK_TOKEN}</code>{" "}is replaced with this candidate&apos;s link when sent.
              </p>
              {!bodyHasLink && (
                <p className="text-[11px] text-destructive mt-1">
                  The message must include the interview link — click “Insert interview link”.
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
              <Link2 className="h-3 w-3 shrink-0" />
              <span className="truncate min-w-0 flex-1">{link}</span>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex items-center gap-1 hover:text-foreground shrink-0 ml-1"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          {preview && !channel && (
            <Button variant="secondary" onClick={copyLink}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy link
            </Button>
          )}
          <Button onClick={handleSend} disabled={!canSend || sending}>
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1.5" />
            )}
            {preview?.alreadySent ? "Send again" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
