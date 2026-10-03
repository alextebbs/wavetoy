import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/lib/theme";
import { ChevronsUpDownIcon, PauseIcon, PlayIcon } from "lucide-react";

interface PlaybackHeadProps {
  visible: boolean;
  isPlaying: boolean;
  onPlayPause: () => void;
  onDragScroll?: (deltaRows: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function PlaybackHead({ visible, isPlaying, onPlayPause, onDragScroll, onDragStart, onDragEnd }: PlaybackHeadProps) {
  const d = useThemeStore((s) => s.theme.display);
  const draggingRef = useRef(false);
  const lastYRef = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    lastYRef.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart?.();
  }, [onDragStart]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !onDragScroll) return;
    const dy = e.clientY - lastYRef.current;
    if (dy !== 0) {
      onDragScroll(-dy);
      lastYRef.current = e.clientY;
    }
  }, [onDragScroll]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onDragEnd?.();
  }, [onDragEnd]);

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

      <div
        className={`absolute right-1.5 -top-3 flex items-center justify-center size-6 rounded-sm border bg-black/65 hover:bg-black/80 cursor-grab active:cursor-grabbing ${visible ? "pointer-events-auto" : "pointer-events-none"}`}
        style={{
          borderColor: d.displayStatusPlaybackHead,
          color: d.displayStatusPlaybackHead,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <ChevronsUpDownIcon className="size-3" />
      </div>
    </div>
  );
}
