"use client";

import type { ReactNode } from "react";
import { AgentState, useLocalParticipant } from "@livekit/components-react";
import { motion } from "framer-motion";
import {
  Mic,
  MicOff,
  Captions,
  CaptionsOff,
  Video,
  PhoneOff,
} from "lucide-react";

interface InterviewControlBarProps {
  handleBack: () => void;
  agentState: AgentState;
  isSpeakerEnabled?: boolean;
  toggleSpeaker?: () => void;
  onToggleTranscript?: () => void;
  showTranscript?: boolean;
  fullPage?: boolean;
}

export function InterviewControlBar({
  handleBack,
  agentState,
  onToggleTranscript,
  showTranscript = true,
}: InterviewControlBarProps) {
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const micActive = !isMicrophoneEnabled;

  const toggleMic = () => {
    localParticipant?.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-2 px-5 py-4 rounded-2xl w-full max-w-xl"
      style={{
        background: "rgba(6,18,28,0.88)",
        border: "1px solid rgba(8,65,87,0.65)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      {/* Mute */}
      <ControlBtn
        icon={
          micActive ? (
            <MicOff className="w-5 h-5" />
          ) : (
            <Mic className="w-5 h-5" />
          )
        }
        label="MUTE"
        onClick={toggleMic}
        active={micActive}
        activeColor="red"
      />

      {/* Transcript */}
      <ControlBtn
        icon={
          showTranscript ? (
            <Captions className="w-5 h-5" />
          ) : (
            <CaptionsOff className="w-5 h-5" />
          )
        }
        label="TRANSCRIPT"
        onClick={onToggleTranscript ?? (() => {})}
        active={showTranscript}
        activeColor="cyan"
      />

      {/* Camera (display only) */}
      <ControlBtn
        icon={<Video className="w-5 h-5" />}
        label="CAMERA"
        onClick={() => {}}
        disabled
      />

      <div className="flex-1" />

      {/* End Interview */}
      <motion.button
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        onClick={handleBack}
        className="flex items-center gap-2.5 px-5 py-3 rounded-full text-white text-sm font-semibold transition-all shrink-0"
        style={{
          background: "linear-gradient(135deg, #f43f5e 0%, #dc2626 100%)",
          boxShadow: "0 4px 18px rgba(244,63,94,0.35)",
        }}
      >
        <PhoneOff className="w-4 h-4" />
        {agentState === "disconnected" ? "Leave" : "End Interview"}
      </motion.button>
    </motion.div>
  );
}

// ─── Single control button ────────────────────────────────────────────────────

function ControlBtn({
  icon,
  label,
  onClick,
  active = false,
  activeColor = "cyan",
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  activeColor?: "cyan" | "red";
  disabled?: boolean;
}) {
  const isRed = activeColor === "red" && active;
  const isCyan = activeColor === "cyan" && active;

  const ringBg = isRed
    ? "rgba(244,63,94,0.18)"
    : isCyan
    ? "rgba(1,183,172,0.14)"
    : "rgba(8,40,58,0.65)";

  const ringBorder = isRed
    ? "rgba(244,63,94,0.45)"
    : isCyan
    ? "rgba(1,183,172,0.38)"
    : "rgba(8,65,87,0.65)";

  const iconColor = isRed ? "#f43f5e" : isCyan ? "#01B7AC" : "#64748b";
  const labelColor = isRed ? "#f87171" : isCyan ? "#01B7AC" : "#475569";

  return (
    <motion.button
      whileTap={disabled ? {} : { scale: 0.9 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-1.5 px-3 py-2 rounded-xl transition-colors ${
        disabled
          ? "opacity-30 cursor-not-allowed"
          : "hover:bg-white/5 cursor-pointer"
      }`}
    >
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center transition-all"
        style={{
          background: ringBg,
          border: `1px solid ${ringBorder}`,
          color: iconColor,
        }}
      >
        {icon}
      </div>
      <span
        className="text-[9px] font-bold tracking-widest"
        style={{ color: labelColor }}
      >
        {label}
      </span>
    </motion.button>
  );
}
