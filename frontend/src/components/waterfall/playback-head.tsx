import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/lib/theme";
import { PauseIcon, PlayIcon } from "lucide-react";

interface PlaybackHeadProps {
  visible: boolean;
  isPlaying: boolean;
  onPlayPause: () => void;
}

export function PlaybackHead({ visible, isPlaying, onPlayPause }: PlaybackHeadProps) {
  const d = useThemeStore((s) => s.theme.display);

  return (
    <div
      className="absolute left-0 right-0 z-[30] transition-opacity duration-200 ease-out"
      style={{
        top: "10%",
        opacity: visible ? 1 : 0,
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{ backgroundColor: d.displayStatusPlaybackHead }}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        className={`absolute left-1.5 -top-3 border bg-black/65 hover:bg-black/80 ${visible ? "pointer-events-auto" : "pointer-events-none"}`}
        style={{
          borderColor: d.displayStatusPlaybackHead,
          color: d.displayStatusPlaybackHead,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onPlayPause();
        }}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
      </Button>
    </div>
  );
}
