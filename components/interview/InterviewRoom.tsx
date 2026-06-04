"use client";

import { useEffect, useState } from "react";
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
} from "livekit-client";
import "@livekit/components-styles";

import { InterviewControlBar } from "./InterviewControlBar";
import { TranscriptionView } from "./TranscriptionView";

interface InterviewRoomProps {
  token: string;
  serverUrl: string;
  fullPage?: boolean;
  onClose?: () => void;
  onDisconnected?: () => void;
  onRoomConnected?: (roomSid: string) => void;
}

export function InterviewRoom({
  token,
  serverUrl,
  fullPage = true,
  onClose,
  onDisconnected,
  onRoomConnected,
}: InterviewRoomProps) {
  const [activeToken, setActiveToken] = useState<string | undefined>(token);
  const [hadPreviousConnection, setHadPreviousConnection] = useState(false);

  useEffect(() => {
    setActiveToken(token);
  }, [token]);

  const handleBack = () => {
    onClose?.();
  };

  return (
    <main
      className={`${
        fullPage ? "h-screen w-screen" : "h-full w-full relative min-h-[400px]"
      } bg-background overflow-hidden`}
    >
      <LiveKitRoom
        token={activeToken}
        serverUrl={serverUrl}
        connect={!!activeToken}
        audio={true}
        video={false}
        onMediaDeviceFailure={onDeviceFailure}
        onDisconnected={() => {
          setActiveToken(undefined);
          setHadPreviousConnection(true);
          onDisconnected?.();
        }}
        className="h-full w-full flex flex-col"
      >
        <InterviewView
          handleBack={handleBack}
          hadPreviousConnection={hadPreviousConnection}
          fullPage={fullPage}
          onRoomConnected={onRoomConnected}
        />
      </LiveKitRoom>
    </main>
  );
}

function InterviewView({
  handleBack,
  hadPreviousConnection,
  fullPage,
  onRoomConnected,
}: {
  handleBack: () => void;
  hadPreviousConnection: boolean;
  fullPage: boolean;
  onRoomConnected?: (roomSid: string) => void;
}) {
  const room = useMaybeRoomContext();
  const { state: agentState } = useVoiceAssistant();
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true);

  useEffect(() => {
    if (!room || !onRoomConnected) return;

    const roomObj = room as unknown as { roomInfo?: { sid?: string } };
    const sid = roomObj?.roomInfo?.sid;
    if (sid) {
      onRoomConnected(sid);
      return;
    }

    const handleConnected = () => {
      const sid = (room as unknown as { roomInfo?: { sid?: string } })?.roomInfo
        ?.sid;
      if (sid) onRoomConnected(sid);
    };

    room.on(RoomEvent.Connected, handleConnected);
    return () => {
      room.off(RoomEvent.Connected, handleConnected);
    };
  }, [room, onRoomConnected]);

  useEffect(() => {
    if (!room) return;

    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      p.audioTrackPublications.forEach((pub: RemoteTrackPublication) => {
        if (pub.track && pub.kind === Track.Kind.Audio) {
          (pub.track as RemoteAudioTrack).setVolume(isSpeakerEnabled ? 1 : 0);
        }
      });
    });

    const handleTrackSubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        (track as RemoteAudioTrack).setVolume(isSpeakerEnabled ? 1 : 0);
      }
    };

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, isSpeakerEnabled]);

  return (
    <div className="flex h-full justify-center">
      <div
        className={`flex flex-col gap-3 w-full ${
          fullPage ? "md:w-[60%] lg:w-[50%] py-4" : "p-3"
        } h-full mx-auto`}
      >
        <div
          className={`flex items-center justify-between px-1 ${
            fullPage ? "" : "hidden"
          }`}
        >
          <span className="text-sm font-medium text-foreground">
            {agentState === "disconnected" ? "Interview ended" : "Interview in progress"}
          </span>
          <span
            className={`flex items-center gap-1.5 text-xs ${
              agentState === "disconnected"
                ? "text-muted-foreground"
                : "text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {agentState !== "disconnected" && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            )}
            {agentState === "disconnected"
              ? ""
              : agentState === "connecting"
              ? "Connecting…"
              : "Live"}
          </span>
        </div>

        <div className="flex-col flex-1 w-full justify-center overflow-y-auto">
          {agentState === "connecting" ? (
            <div className={`${fullPage ? "h-60" : "h-32"} mx-auto`}>
              <div
                className={`${
                  fullPage ? "text-xl" : "text-base"
                } mb-4 tracking-wider text-center`}
              >
                Establishing connection…
              </div>
              <BarVisualizer
                state="connecting"
                barCount={fullPage ? 8 : 6}
                trackRef={undefined}
                className="agent-visualizer gap-2"
                options={{ minHeight: fullPage ? 30 : 16 }}
              />
            </div>
          ) : agentState !== "disconnected" || hadPreviousConnection ? (
            <TranscriptionView fullPage={fullPage} />
          ) : null}
        </div>

        <div className="w-full">
          <InterviewControlBar
            handleBack={handleBack}
            agentState={agentState}
            isSpeakerEnabled={isSpeakerEnabled}
            toggleSpeaker={() => setIsSpeakerEnabled((v) => !v)}
            fullPage={fullPage}
          />
        </div>

        <RoomAudioRenderer />
      </div>
    </div>
  );
}

function onDeviceFailure(error?: MediaDeviceFailure) {
  console.error(error);
  alert(
    "Error acquiring microphone permissions. Please grant the necessary permissions in your browser and reload the tab."
  );
}
