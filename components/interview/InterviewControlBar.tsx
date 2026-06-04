"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AgentState,
  BarVisualizer,
  VoiceAssistantControlBar,
  useVoiceAssistant,
} from "@livekit/components-react";
import { Volume2, VolumeOff, PhoneOff } from "lucide-react";

interface InterviewControlBarProps {
  handleBack: () => void;
  agentState: AgentState;
  isSpeakerEnabled: boolean;
  toggleSpeaker: () => void;
  fullPage?: boolean;
}

export function InterviewControlBar({
  handleBack,
  agentState,
  isSpeakerEnabled,
  toggleSpeaker,
  fullPage = true,
}: InterviewControlBarProps) {
  const { audioTrack } = useVoiceAssistant();

  return (
    <div className={`relative ${fullPage ? "h-15" : "h-14"} w-full`}>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 1, top: 0 }}
          animate={{ opacity: 1, top: 0 }}
          exit={{ opacity: 0, top: "-10px" }}
          transition={{ duration: 0.4, ease: [0.09, 1.04, 0.245, 1.055] }}
          className="flex absolute w-full h-full items-center bg-card rounded-xl border border-border px-4 gap-3"
        >
          {/* Agent voice visualizer */}
          <div className="flex-1 flex justify-start">
            <BarVisualizer
              state={agentState}
              barCount={fullPage ? 5 : 4}
              trackRef={audioTrack}
              className={`gap-1 ${fullPage ? "h-8 w-20" : "h-6 w-14"}`}
              options={{ minHeight: fullPage ? 10 : 8 }}
            />
          </div>

          {/* Mic controls */}
          <div className="flex justify-center">
            {agentState !== "disconnected" && (
              <VoiceAssistantControlBar
                controls={{ leave: false }}
                className={`[&_button]:flex [&_button]:items-center [&_button]:justify-center [&_button]:rounded-full [&_button]:bg-muted [&_button]:border [&_button]:border-border [&_button]:text-foreground [&_button:hover]:bg-muted/70 [&_button]:transition-all
                  ${
                    fullPage
                      ? "[&_button]:h-10 [&_button]:w-10 [&_button]:p-2"
                      : "[&_button]:h-8 [&_button]:w-8 [&_button]:p-1.5"
                  }`}
              />
            )}
          </div>

          {/* Speaker toggle */}
          <button
            onClick={toggleSpeaker}
            className={`${
              fullPage ? "h-10 w-10" : "h-8 w-8"
            } rounded-full bg-muted border border-border text-foreground hover:bg-muted/70 transition-colors flex items-center justify-center shrink-0`}
            aria-label={isSpeakerEnabled ? "Mute speaker" : "Unmute speaker"}
          >
            {isSpeakerEnabled ? (
              <Volume2 className={fullPage ? "h-4 w-4" : "h-3.5 w-3.5"} />
            ) : (
              <VolumeOff className={fullPage ? "h-4 w-4" : "h-3.5 w-3.5"} />
            )}
          </button>

          {/* End call */}
          <button
            className={`${
              fullPage ? "h-10 px-4 text-sm" : "h-8 px-3 text-xs"
            } rounded-full bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition-colors flex items-center justify-center gap-1.5 shrink-0 font-medium`}
            onClick={handleBack}
          >
            <PhoneOff className={fullPage ? "h-4 w-4" : "h-3 w-3"} />
            {agentState === "disconnected" ? "Leave" : "End"}
          </button>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
