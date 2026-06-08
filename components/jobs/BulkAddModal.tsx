"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onClose: () => void;
  requisitionId: string;
  onSuccess: () => void;
  onDuplicatesDetected?: (count: number) => void;
}

export function BulkAddModal({ open, onClose, requisitionId, onSuccess, onDuplicatesDetected }: Props) {
  const storageKey = `bulkAddModal.urls.${requisitionId}`;
  const [urls, setUrls] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ totalTasks: number; invalidUrls?: string[]; duplicatesDetected?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restore any draft the user left behind (e.g. closed the modal by clicking outside).
  useEffect(() => {
    if (!open) return;
    try {
      setUrls(localStorage.getItem(storageKey) ?? "");
    } catch { /* ignore */ }
  }, [open, storageKey]);

  function updateUrls(value: string) {
    setUrls(value);
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }

  function clearDraft() {
    setUrls("");
    try {
      localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }

  async function handleSubmit() {
    if (!urls.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/requisitions/${requisitionId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Failed to start run");
      } else {
        setResult(json);
        clearDraft();
        onSuccess();
      }

    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    if (loading) return;
    setUrls("");
    setResult(null);
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Add Candidates</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Future: Document upload zone */}
          <div className="rounded-lg border-2 border-dashed border-border p-6 text-center opacity-40 cursor-not-allowed">
            <p className="text-sm text-muted-foreground">Document upload (PDF/DOCX/ZIP)</p>
            <p className="text-xs text-muted-foreground mt-1">Coming soon</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>LinkedIn URLs <span className="text-muted-foreground font-normal">(one per line)</span></Label>
              <button
                type="button"
                onClick={clearDraft}
                disabled={loading || !urls}
                className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
              >
                Clear
              </button>
            </div>
            <Textarea
              placeholder={"https://linkedin.com/in/username...\nhttps://linkedin.com/in/another..."}
              value={urls}
              onChange={e => updateUrls(e.target.value)}
              rows={8}
              className="font-mono text-xs resize-none"
            />
          </div>

          {result && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-sm text-emerald-400">
                Run started with {result.totalTasks} candidate{result.totalTasks === 1 ? "" : "s"}.
                {result.invalidUrls && result.invalidUrls.length > 0 && (
                  <p className="text-xs text-amber-400 mt-1">{result.invalidUrls.length} invalid URLs skipped.</p>
                )}
              </div>
              {result.duplicatesDetected && result.duplicatesDetected > 0 && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-sm text-amber-400 flex items-center justify-between gap-3">
                  <span>⚠ {result.duplicatesDetected} duplicate candidate{result.duplicatesDetected === 1 ? "" : "s"} detected</span>
                  <button
                    className="text-xs font-medium underline underline-offset-2 hover:text-amber-300 transition-colors shrink-0"
                    onClick={() => onDuplicatesDetected?.(result.duplicatesDetected!)}
                  >
                    Review now
                  </button>
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-sm text-rose-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={loading}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading || !urls.trim()}>
            {loading ? "Processing..." : "Upload & Process"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
