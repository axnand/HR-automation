"use client";

import { useEffect, useRef, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import {
  Participant,
  ParticipantKind,
  RoomEvent,
  TranscriptionSegment,
} from "livekit-client";

interface ExtendedSegment extends TranscriptionSegment {
  isLocal: boolean;
  isAgent: boolean;
}

export function TranscriptionView({ fullPage = true }: { fullPage?: boolean }) {
  const room = useMaybeRoomContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState<{ [id: string]: ExtendedSegment }>(
    {}
  );

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
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
          next[s.id] = {
            ...s,
            isLocal: participant?.isLocal ?? false,
            isAgent,
          };
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

  return (
    <div
      ref={containerRef}
      className={`flex flex-col overflow-y-auto ${
        fullPage ? "p-4" : "p-2"
      } bg-card rounded-lg border border-border h-full flex-1`}
    >
      {sorted.length === 0 ? (
        <div className="flex-1 flex items-end">
          <div
            className={`opacity-40 ${
              fullPage ? "text-base" : "text-sm"
            } text-muted-foreground`}
          >
            Waiting for conversation to begin…
          </div>
        </div>
      ) : (
        <div className="flex flex-col mt-auto gap-3">
          {sorted.map((seg) => (
            <div
              key={seg.id}
              className={`flex flex-col gap-0.5 ${
                !seg.isAgent ? "items-end" : "items-start"
              }`}
            >
              <span
                className={`${
                  fullPage ? "text-xs" : "text-[10px]"
                } text-muted-foreground/60 px-1`}
              >
                {seg.isAgent ? "Interviewer" : "You"}
              </span>
              <div
                className={`px-3 py-2 rounded-2xl ${
                  fullPage ? "text-base" : "text-sm"
                } leading-relaxed max-w-[75%] ${
                  !seg.isAgent
                    ? "bg-primary/10 text-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}
              >
                {seg.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
