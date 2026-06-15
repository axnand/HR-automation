"use client";

import { useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useVoiceAssistant,
  useMaybeRoomContext,
  BarVisualizer,
} from "@livekit/components-react";
import {
  MediaDeviceFailure,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  Participant,
  ParticipantKind,
  TranscriptionSegment,
  DefaultReconnectPolicy,
} from "livekit-client";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, PhoneOff, CheckCircle2, Download } from "lucide-react";
import "@livekit/components-styles";

import { InterviewControlBar } from "./InterviewControlBar";
import { TranscriptionView, exportTranscript } from "./TranscriptionView";
import type { ExportableSegment } from "./TranscriptionView";

interface InterviewRoomProps {
  token: string;
  serverUrl: string;
  fullPage?: boolean;
  onClose?: () => void;
  onDisconnected?: () => void;
  onRoomConnected?: (roomSid: string) => void;
  // Called with the final transcript just before the room unmounts so the
  // parent can show an export option on the post-call ended screen.
  onTranscriptReady?: (segments: ExportableSegment[]) => void;
}

export function InterviewRoom({
  token,
  serverUrl,
  onClose,
  onDisconnected,
  onRoomConnected,
  onTranscriptReady,
}: InterviewRoomProps) {
  const [activeToken, setActiveToken] = useState<string | undefined>(token);

  useEffect(() => {
    setActiveToken(token);
  }, [token]);

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col"
      style={{
        background:
          "radial-gradient(ellipse at 30% 20%, #0d2d3e 0%, #071d2b 40%, #050f18 100%)",
      }}
    >
      <LiveKitRoom
        token={activeToken}
        serverUrl={serverUrl}
        connect={!!activeToken}
        audio={true}
        video={false}
        options={{
          disconnectOnPageLeave: true,
          reconnectPolicy: new DefaultReconnectPolicy(),
        }}
        onMediaDeviceFailure={onDeviceFailure}
        onDisconnected={() => {
          setActiveToken(undefined);
          onDisconnected?.();
        }}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <InterviewView
          onClose={onClose ?? (() => {})}
          onRoomConnected={onRoomConnected}
          onTranscriptReady={onTranscriptReady}
        />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────

function useElapsedTimer(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (active && startRef.current === null) {
      startRef.current = Date.now();
    } else if (!active) {
      // Don't reset — freeze the timer when session ends so it keeps showing
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (startRef.current !== null)
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ─── Per-turn question accumulator ───────────────────────────────────────────
// Fixes: (1) text flickering from per-segment key changes; (2) text vanishing
// too fast. Each speaking turn gets its own animKey so AnimatePresence only
// animates between questions, not between segments. Text persists 12s after
// the agent stops speaking.

function useDisplayedQuestion(agentState: string) {
  const room = useMaybeRoomContext();
  const [text, setText] = useState("");
  // Increments once per new speaking turn — drives AnimatePresence key
  const [animKey, setAnimKey] = useState(0);
  const bufferRef = useRef(new Map<string, string>());
  const prevStateRef = useRef(agentState);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect turn boundaries via agentState transitions
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = agentState;

    if (agentState === "speaking" && prev !== "speaking") {
      // New speaking turn — clear old buffer, new animation key
      bufferRef.current.clear();
      setAnimKey((k) => k + 1);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    }

    if (prev === "speaking" && agentState !== "speaking") {
      // Turn just ended — keep text visible for 12 s then fade
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setText(""), 12_000);
    }
  }, [agentState]);

  useEffect(() => {
    if (!room) return;
    const onTranscription = (
      segs: TranscriptionSegment[],
      participant?: Participant
    ) => {
      if (participant?.kind !== ParticipantKind.AGENT) return;
      let updated = false;
      for (const s of segs) {
        if (bufferRef.current.get(s.id) !== s.text) {
          bufferRef.current.set(s.id, s.text);
          updated = true;
        }
      }
      if (updated) {
        // Cancel any pending clear while new text is arriving
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        setText([...bufferRef.current.values()].join(" ").trim());
      }
    };
    room.on(RoomEvent.TranscriptionReceived, onTranscription);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, onTranscription);
    };
  }, [room]);

  useEffect(
    () => () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    },
    []
  );

  return { text, animKey };
}

// ─── Main view ────────────────────────────────────────────────────────────────

function InterviewView({
  onClose,
  onRoomConnected,
  onTranscriptReady,
}: {
  onClose: () => void;
  onRoomConnected?: (sid: string) => void;
  onTranscriptReady?: (segments: ExportableSegment[]) => void;
}) {
  const room = useMaybeRoomContext();
  const { state: agentState, audioTrack } = useVoiceAssistant();
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true);
  const [showTranscript, setShowTranscript] = useState(true);
  // Track whether the agent ever actually connected so we know it left intentionally
  const [hadAgentConnected, setHadAgentConnected] = useState(false);
  const [transcriptSegments, setTranscriptSegments] = useState<ExportableSegment[]>([]);
  // Ref always holds the latest segments — safe to read inside effects/callbacks
  // without stale-closure issues.
  const transcriptRef = useRef<ExportableSegment[]>([]);
  const { text: displayedQuestion, animKey } = useDisplayedQuestion(agentState);

  const handleSegmentsChange = (segs: ExportableSegment[]) => {
    transcriptRef.current = segs;
    setTranscriptSegments(segs);
  };

  const isLive =
    agentState !== "disconnected" && agentState !== "connecting";
  const agentLeft = agentState === "disconnected" && hadAgentConnected;

  // Fire transcript to parent the moment the agent leaves — before the room
  // auto-closes and onDisconnected skips handleClose entirely.
  useEffect(() => {
    if (agentLeft) {
      onTranscriptReady?.(transcriptRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLeft]);

  // Single exit point — also saves transcript for the "End Interview" path.
  const handleClose = () => {
    onTranscriptReady?.(transcriptRef.current);
    onClose();
  };
  // Timer freezes when agent leaves (active stays true so the value is preserved)
  const elapsed = useElapsedTimer(isLive || agentLeft);

  useEffect(() => {
    if (
      agentState !== "disconnected" &&
      agentState !== "connecting" &&
      agentState !== "initializing"
    ) {
      setHadAgentConnected(true);
    }
  }, [agentState]);

  // Report room SID once connected
  useEffect(() => {
    if (!room || !onRoomConnected) return;
    const sid = (room as unknown as { roomInfo?: { sid?: string } })?.roomInfo
      ?.sid;
    if (sid) {
      onRoomConnected(sid);
      return;
    }
    const handleConnected = () => {
      const s = (room as unknown as { roomInfo?: { sid?: string } })?.roomInfo
        ?.sid;
      if (s) onRoomConnected(s);
    };
    room.on(RoomEvent.Connected, handleConnected);
    return () => {
      room.off(RoomEvent.Connected, handleConnected);
    };
  }, [room, onRoomConnected]);

  // Speaker volume
  useEffect(() => {
    if (!room) return;
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      p.audioTrackPublications.forEach((pub: RemoteTrackPublication) => {
        if (pub.track && pub.kind === Track.Kind.Audio)
          (pub.track as RemoteAudioTrack).setVolume(isSpeakerEnabled ? 1 : 0);
      });
    });
    const handleTrackSubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio)
        (track as RemoteAudioTrack).setVolume(isSpeakerEnabled ? 1 : 0);
    };
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, isSpeakerEnabled]);

  // Status badge config per agent state
  const statusConfig: Record<
    string,
    { label: string; color: string; bg: string; border: string; pulse: boolean }
  > = {
    connecting: {
      label: "CONNECTING...",
      color: "#227C9D",
      bg: "rgba(34,124,157,0.06)",
      border: "rgba(34,124,157,0.25)",
      pulse: true,
    },
    initializing: {
      label: "INITIALIZING...",
      color: "#227C9D",
      bg: "rgba(34,124,157,0.06)",
      border: "rgba(34,124,157,0.25)",
      pulse: true,
    },
    listening: {
      label: "INTERVIEWER IS LISTENING",
      color: "#01B7AC",
      bg: "rgba(1,183,172,0.06)",
      border: "rgba(1,183,172,0.3)",
      pulse: true,
    },
    thinking: {
      label: "INTERVIEWER IS LISTENING",
      color: "#01B7AC",
      bg: "rgba(1,183,172,0.06)",
      border: "rgba(1,183,172,0.3)",
      pulse: true,
    },
    speaking: {
      label: "INTERVIEWER IS SPEAKING",
      color: "#01B7AC",
      bg: "rgba(1,183,172,0.08)",
      border: "rgba(1,183,172,0.35)",
      pulse: false,
    },
    disconnected: {
      label: "SESSION ENDED",
      color: "#64748b",
      bg: "rgba(100,116,139,0.06)",
      border: "rgba(100,116,139,0.25)",
      pulse: false,
    },
  };

  const status = statusConfig[agentState] ?? statusConfig.listening;

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      {/* ── Top bar ── */}
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex items-center justify-between px-6 py-3 shrink-0"
        style={{ borderBottom: "1px solid rgba(8,65,87,0.55)" }}
      >
        <span
          className="font-bold text-lg tracking-wide"
          style={{ color: "#01B7AC" }}
        >
          Salescode.ai
        </span>

        <div className="flex items-center gap-5">
          {/* Live / Ended badge */}
          <AnimatePresence mode="wait">
            {agentLeft ? (
              <motion.div
                key="ended"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="flex items-center gap-2 px-3 py-1 rounded-full"
                style={{
                  border: "1px solid rgba(100,116,139,0.35)",
                  background: "rgba(100,116,139,0.08)",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                <span className="text-xs font-bold tracking-widest text-slate-400">
                  SESSION ENDED
                </span>
              </motion.div>
            ) : (
              <motion.div
                key="live"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="flex items-center gap-2 px-3 py-1 rounded-full"
                style={{
                  border: "1px solid rgba(52,211,153,0.35)",
                  background: "rgba(52,211,153,0.08)",
                }}
              >
                <motion.span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400"
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ repeat: Infinity, duration: 1.8 }}
                  style={{ boxShadow: "0 0 6px rgba(52,211,153,0.8)" }}
                />
                <span className="text-xs font-bold tracking-widest text-emerald-400">
                  LIVE SESSION
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Elapsed — always visible once timer starts */}
          {(isLive || agentLeft) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm font-mono text-slate-300 tracking-wider"
            >
              ELAPSED:{" "}
              <span
                className="font-bold"
                style={{ color: agentLeft ? "#64748b" : "#01B7AC" }}
              >
                {elapsed}
              </span>
            </motion.div>
          )}
        </div>

        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wider text-slate-400 cursor-default select-none"
          style={{
            border: "1px solid rgba(8,65,87,0.55)",
            background: "rgba(8,65,87,0.12)",
          }}
        >
          <Shield className="w-3 h-3" />
          SECURE CHANNEL
        </div>
      </motion.header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Center */}
        <div className="flex-1 flex flex-col items-center justify-between py-8 px-8 min-w-0">
          {/* Orb */}
          <div className="flex-1 flex items-center justify-center">
            <InterviewOrb agentState={agentState} audioTrack={audioTrack} />
          </div>

          {/* Question display */}
          <div className="text-center mb-6 max-w-2xl w-full px-4">
            <div className="min-h-[5rem] flex items-end justify-center mb-5">
              <AnimatePresence mode="wait">
                {displayedQuestion ? (
                  <motion.p
                    key={animKey}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                    className="text-2xl font-semibold text-white leading-snug"
                  >
                    &ldquo;{displayedQuestion}&rdquo;
                  </motion.p>
                ) : (
                  <motion.p
                    key="placeholder"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.35 }}
                    exit={{ opacity: 0 }}
                    className="text-lg text-slate-400"
                  >
                    {agentState === "connecting" || agentState === "initializing"
                      ? "Establishing secure connection…"
                      : agentLeft
                      ? "Session complete"
                      : "Waiting for the interview to begin…"}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            {/* Status badge */}
            <motion.div
              animate={
                status.pulse ? { opacity: [0.65, 1, 0.65] } : { opacity: 1 }
              }
              transition={
                status.pulse
                  ? { repeat: Infinity, duration: 2.5 }
                  : { duration: 0 }
              }
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-widest"
              style={{
                border: `1px solid ${status.border}`,
                color: status.color,
                background: status.bg,
              }}
            >
              {status.label}
            </motion.div>
          </div>

          {/* Control bar */}
          <InterviewControlBar
            handleBack={handleClose}
            agentState={agentState}
            isSpeakerEnabled={isSpeakerEnabled}
            toggleSpeaker={() => setIsSpeakerEnabled((v) => !v)}
            onToggleTranscript={() => setShowTranscript((v) => !v)}
            showTranscript={showTranscript}
          />
        </div>

        {/* Right: captions sidebar */}
        <AnimatePresence>
          {showTranscript && (
            <motion.aside
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 340, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="shrink-0 overflow-hidden"
              style={{ borderLeft: "1px solid rgba(8,65,87,0.7)" }}
            >
              <div className="w-[340px] h-full">
                <TranscriptionView onSegmentsChange={handleSegmentsChange} />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>


      {/* ── Agent-left overlay ── */}
      <AnimatePresence>
        {agentLeft && (
          <motion.div
            key="agent-left"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background: "rgba(5,12,20,0.88)", backdropFilter: "blur(8px)" }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center gap-5 text-center max-w-sm px-6"
            >
              {/* Icon */}
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center"
                style={{
                  background: "rgba(1,183,172,0.1)",
                  border: "1px solid rgba(1,183,172,0.25)",
                  boxShadow: "0 0 30px rgba(1,183,172,0.15)",
                }}
              >
                <CheckCircle2 className="w-8 h-8" style={{ color: "#01B7AC" }} />
              </div>

              <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-semibold text-white">
                  Interview Complete
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed">
                  The AI Interviewer has disconnected. Your responses have been
                  recorded and are being processed.
                </p>
              </div>

              {/* Duration summary */}
              <div
                className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-mono text-slate-400"
                style={{
                  border: "1px solid rgba(40,65,95,0.6)",
                  background: "rgba(6,24,38,0.5)",
                }}
              >
                Session duration:{" "}
                <span className="text-slate-200 font-semibold">{elapsed}</span>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                {transcriptSegments.length > 0 && (
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => exportTranscript(transcriptSegments)}
                    className="flex items-center gap-2 px-5 py-3 rounded-full text-sm font-semibold text-slate-300 transition-colors"
                    style={{
                      border: "1px solid rgba(8,65,87,0.7)",
                      background: "rgba(8,65,87,0.2)",
                    }}
                  >
                    <Download className="w-4 h-4" />
                    Export Transcript
                  </motion.button>
                )}

                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleClose}
                  className="flex items-center gap-2.5 px-7 py-3 rounded-full text-white text-sm font-semibold"
                  style={{
                    background: "linear-gradient(135deg, #f43f5e 0%, #dc2626 100%)",
                    boxShadow: "0 4px 20px rgba(244,63,94,0.35)",
                  }}
                >
                  <PhoneOff className="w-4 h-4" />
                  Leave Session
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Animated orb ─────────────────────────────────────────────────────────────
// Color and animation intensity vary per agent state:
//   connecting/initializing → dim blue-grey, no pulse
//   listening / thinking    → cyan, gentle pulse (thinking treated same as listening)
//   speaking                → bright cyan, fast strong pulse
//   disconnected            → grey, no pulse

function InterviewOrb({
  agentState,
  audioTrack,
}: {
  agentState: string;
  audioTrack: Parameters<typeof BarVisualizer>[0]["trackRef"];
}) {
  const isSpeaking = agentState === "speaking";
  const isInactive =
    agentState === "disconnected" ||
    agentState === "connecting" ||
    agentState === "initializing";

  const c = isInactive ? "34,124,157" : "1,183,172";
  const pulseDuration = isSpeaking ? 1.3 : isInactive ? 0 : 3.5;
  const pulseScale = isSpeaking ? 1.14 : 1.04;
  const baseOpacity = isInactive ? 0.28 : 1;

  const ringAnim = isInactive
    ? {}
    : {
        scale: [1, pulseScale, 1],
        opacity: isSpeaking ? [0.5, 0.9, 0.5] : [0.3, 0.6, 0.3],
      };
  const ringTransition = isInactive
    ? {}
    : { repeat: Infinity, duration: pulseDuration, ease: "easeInOut" as const };

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: 300, height: 300 }}
    >
      {/* Diffuse outer glow */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 300,
          height: 300,
          background: `radial-gradient(circle, rgba(${c},${isInactive ? 0.04 : 0.10}) 0%, transparent 70%)`,
          opacity: baseOpacity,
        }}
        animate={isInactive ? {} : { scale: [1, pulseScale * 1.02, 1] }}
        transition={
          isInactive
            ? {}
            : { repeat: Infinity, duration: pulseDuration, ease: "easeInOut" }
        }
      />

      {/* Outer ring */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 236,
          height: 236,
          border: `1px solid rgba(${c},${isInactive ? 0.10 : 0.18})`,
          background: `radial-gradient(circle, rgba(${c},0.04) 0%, transparent 70%)`,
          opacity: baseOpacity,
        }}
        animate={{ ...ringAnim, scale: isInactive ? 1 : [1, 1.07, 1] }}
        transition={{ ...ringTransition, delay: 0.3 }}
      />

      {/* Inner ring */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 180,
          height: 180,
          border: `1px solid rgba(${c},${isInactive ? 0.14 : 0.32})`,
          opacity: baseOpacity,
        }}
        animate={{ ...ringAnim, scale: isInactive ? 1 : [1, 1.04, 1] }}
        transition={{ ...ringTransition, delay: 0.15 }}
      />

      {/* Orb body */}
      <motion.div
        className="relative rounded-full flex items-center justify-center overflow-hidden"
        style={{
          width: 152,
          height: 152,
          background: `radial-gradient(circle at 38% 35%, rgba(${c},${isInactive ? 0.14 : 0.32}), rgba(${c},${isInactive ? 0.05 : 0.14}) 55%, rgba(0,30,50,0.08) 100%)`,
          boxShadow: `0 0 38px 12px rgba(${c},${isInactive ? 0.08 : 0.2}), 0 0 80px 25px rgba(${c},${isInactive ? 0.04 : 0.1}), inset 0 0 22px rgba(${c},${isInactive ? 0.04 : 0.08})`,
          opacity: baseOpacity,
        }}
        animate={
          isSpeaking
            ? {
                boxShadow: [
                  `0 0 38px 12px rgba(${c},0.22), 0 0 80px 28px rgba(${c},0.12)`,
                  `0 0 65px 28px rgba(${c},0.45), 0 0 120px 55px rgba(${c},0.22)`,
                  `0 0 38px 12px rgba(${c},0.22), 0 0 80px 28px rgba(${c},0.12)`,
                ],
              }
            : {}
        }
        transition={{
          repeat: Infinity,
          duration: 1.5,
        }}
      >
        {!isInactive ? (
          <div className="[&_.lk-audio-bar]:rounded-full [&_.lk-audio-bar]:bg-cyan-300/75">
            <BarVisualizer
              state={agentState as Parameters<typeof BarVisualizer>[0]["state"]}
              barCount={5}
              trackRef={audioTrack}
              className="h-12 w-24 gap-1"
              options={{ minHeight: 4 }}
            />
          </div>
        ) : (
          // Static dots when inactive / disconnected
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: `rgba(${c},0.4)` }}
              />
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}

function onDeviceFailure(error?: MediaDeviceFailure) {
  console.error(error);
  alert(
    "Error acquiring microphone permissions. Please grant the necessary permissions in your browser and reload the tab."
  );
}
