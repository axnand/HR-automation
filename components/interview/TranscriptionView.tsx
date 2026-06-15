"use client";

import { useEffect, useRef, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import {
  Participant,
  ParticipantKind,
  RoomEvent,
  TranscriptionSegment,
} from "livekit-client";
import { motion, AnimatePresence } from "framer-motion";
import { MoreHorizontal, Download } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ExportableSegment extends TranscriptionSegment {
  isAgent: boolean;
  receivedAt: Date;
}

// Standalone export helper — called both from within the sidebar and from the
// post-call overlay in InterviewRoom, which keeps its own copy of segments.
export function exportTranscript(sorted: ExportableSegment[]) {
  if (sorted.length === 0) return;
  const lines = sorted.map(
    (s) =>
      `[${s.isAgent ? "SALESCODE AI" : "CANDIDATE"} ${s.receivedAt.toLocaleTimeString()}] ${s.text}`
  );
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "interview-transcript.txt";
  a.click();
  URL.revokeObjectURL(url);
}

interface TranscriptionViewProps {
  fullPage?: boolean;
  // Called with the latest sorted segments whenever they change so a parent
  // component can hold a copy for post-call export.
  onSegmentsChange?: (segments: ExportableSegment[]) => void;
}

export function TranscriptionView({
  onSegmentsChange,
}: TranscriptionViewProps) {
  const room = useMaybeRoomContext();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState<{ [id: string]: ExportableSegment }>(
    {}
  );

  // Auto-scroll — stops when the user manually scrolls up (natural behaviour),
  // resumes automatically when they scroll back to the bottom.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments]);

  useEffect(() => {
    if (!room) return;
    const onTranscription = (
      incoming: TranscriptionSegment[],
      participant?: Participant
    ) => {
      setSegments((prev) => {
        const next = { ...prev };
        const isAgent = participant?.kind === ParticipantKind.AGENT;
        for (const s of incoming) {
          next[s.id] = { ...s, isAgent, receivedAt: new Date() };
        }
        return next;
      });
    };
    room.on(RoomEvent.TranscriptionReceived, onTranscription);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, onTranscription);
    };
  }, [room]);

  const sorted = Object.values(segments).sort(
    (a, b) => a.firstReceivedTime - b.firstReceivedTime
  );

  // Notify parent whenever segments change so it can hold a copy for the
  // post-call overlay export button.
  useEffect(() => {
    onSegmentsChange?.(sorted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  // Group consecutive same-speaker segments into one bubble
  const grouped: { isAgent: boolean; texts: string[]; receivedAt: Date }[] = [];
  for (const seg of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.isAgent === seg.isAgent) {
      last.texts.push(seg.text);
    } else {
      grouped.push({ isAgent: seg.isAgent, texts: [seg.text], receivedAt: seg.receivedAt });
    }
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "rgba(6,18,28,0.96)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid rgba(8,65,87,0.7)" }}
      >
        <span
          className="text-[11px] font-bold tracking-widest"
          style={{ color: "rgba(1,183,172,0.85)" }}
        >
          REAL-TIME CAPTIONS
        </span>
        <button className="text-slate-600 hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-white/5">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-4 px-3 py-3">
          <AnimatePresence initial={false}>
            {grouped.length === 0 ? (
              <p className="text-slate-600 text-xs mt-3">
                Waiting for conversation to begin…
              </p>
            ) : (
              grouped.map((group, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10px] font-bold tracking-wider"
                      style={{ color: group.isAgent ? "#01B7AC" : "#94a3b8" }}
                    >
                      {group.isAgent ? "SALESCODE AI" : "CANDIDATE"}
                    </span>
                    <span className="text-[10px] text-slate-600">
                      •{" "}
                      {group.receivedAt.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div
                    className="px-3 py-2.5 rounded-xl text-sm text-slate-200 leading-relaxed"
                    style={{
                      background: group.isAgent
                        ? "rgba(1,183,172,0.07)"
                        : "rgba(8,40,60,0.7)",
                      border: group.isAgent
                        ? "1px solid rgba(1,183,172,0.18)"
                        : "1px solid rgba(8,65,87,0.7)",
                    }}
                  >
                    {group.texts.join(" ")}
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Footer — export only */}
      <div
        className="p-3 shrink-0"
        style={{ borderTop: "1px solid rgba(8,65,87,0.7)" }}
      >
        <button
          onClick={() => exportTranscript(sorted)}
          disabled={sorted.length === 0}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-bold tracking-wider text-slate-500 transition-colors hover:text-slate-300 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ border: "1px solid rgba(8,65,87,0.55)" }}
        >
          <Download className="w-3 h-3" />
          EXPORT TRANSCRIPT
        </button>
      </div>
    </div>
  );
}
