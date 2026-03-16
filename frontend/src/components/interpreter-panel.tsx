import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { InterpreterConfig } from "@/lib/api";
import { ClipboardCopyIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";

export interface VoiceChunk {
  text: string;
  receivedAt: number;
}

function formatRelative(ms: number): string {
  if (ms < 5_000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

type Mode = "off" | "morse" | "voice";

interface Props {
  config: InterpreterConfig;
  onConfigChange: (config: InterpreterConfig) => void;
  morseText: string;
  voiceChunks: VoiceChunk[];
  wpm: number;
  detectedSidetoneHz: number;
  voiceProgress: number;
  onClear: () => void;
}

export function InterpreterPanel({
  config,
  onConfigChange,
  morseText,
  voiceChunks,
  wpm,
  detectedSidetoneHz,
  voiceProgress,
  onClear,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const mode: Mode = config.enabled ? (config.type as Mode) || "morse" : "off";
  const isMorse = mode === "morse";
  const isVoice = mode === "voice";

  const setMode = useCallback(
    (m: Mode) => {
      if (m === "off") {
        onConfigChange({ ...config, enabled: false });
      } else {
        onConfigChange({ ...config, type: m, enabled: true });
      }
    },
    [config, onConfigChange],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isMorse && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (isVoice) {
      el.scrollTop = 0;
    }
  }, [morseText, voiceChunks.length, isMorse, isVoice]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    autoScrollRef.current = atBottom;
  }, []);

  const isAutoSidetone = !config.sidetone_hz;
  const displaySidetoneHz = isAutoSidetone
    ? detectedSidetoneHz || 700
    : config.sidetone_hz!;
  const configWpm = config.wpm || 0;

  const hasContent = isMorse ? !!morseText : voiceChunks.length > 0;
  const allText = isMorse
    ? morseText
    : voiceChunks.map((c) => c.text).join("\n");

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(allText);
  }, [allText]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isVoice || voiceChunks.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [isVoice, voiceChunks.length]);

  const MODES: { value: Mode; label: string }[] = [
    { value: "off", label: "OFF" },
    { value: "morse", label: "MORSE" },
    { value: "voice", label: "VOICE" },
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Mode toggle */}
      <div className="border-b p-4">
        <div className="inline-flex rounded-md border border-border">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === m.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              } ${m.value === "off" ? "rounded-l-[calc(theme(borderRadius.md)-1px)]" : ""} ${m.value === "voice" ? "rounded-r-[calc(theme(borderRadius.md)-1px)]" : ""}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Morse controls */}
      {isMorse && (
        <div className="space-y-4 border-b p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Sidetone</Label>
              <div className="flex items-center gap-2">
                {isAutoSidetone && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {detectedSidetoneHz > 0 ? "detected" : "scanning…"}
                  </span>
                )}
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {displaySidetoneHz} Hz
                </span>
              </div>
            </div>
            <Slider
              min={200}
              max={1200}
              step={10}
              value={[displaySidetoneHz]}
              onValueChange={([v]) =>
                onConfigChange({ ...config, sidetone_hz: v })
              }
            />
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground/60">
                {isAutoSidetone
                  ? "Auto-detecting tone frequency"
                  : "Manual override — drag to 0 or click reset for auto"}
              </p>
              {!isAutoSidetone && (
                <button
                  type="button"
                  className="text-[10px] text-primary hover:underline"
                  onClick={() =>
                    onConfigChange({ ...config, sidetone_hz: 0 })
                  }
                >
                  Auto
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">WPM</Label>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {configWpm === 0 ? "Auto" : configWpm}
              </span>
            </div>
            <Slider
              min={0}
              max={50}
              step={1}
              value={[configWpm]}
              onValueChange={([v]) =>
                onConfigChange({ ...config, wpm: v })
              }
            />
            <p className="text-[10px] text-muted-foreground/60">
              0 = auto-detect speed
            </p>
          </div>
        </div>
      )}

      {/* Output */}
      {mode !== "off" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isMorse ? (
                <>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Decoded
                  </span>
                  {wpm > 0 && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {wpm} WPM
                    </span>
                  )}
                </>
              ) : (
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/30">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500 ease-linear"
                    style={{ width: `${Math.round(voiceProgress * 100)}%` }}
                  />
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 pl-2">
              <Tooltip content="Copy text">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCopy}
                  disabled={!hasContent}
                >
                  <ClipboardCopyIcon className="size-3" />
                </Button>
              </Tooltip>
              <Tooltip content="Clear">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClear}
                  disabled={!hasContent}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </Tooltip>
            </div>
          </div>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-auto bg-black/30"
          >
            {isMorse ? (
              <div className="p-4 font-mono text-sm leading-relaxed text-green-400">
                {morseText || (
                  <span className="text-muted-foreground/40 italic">
                    Waiting for signal…
                  </span>
                )}
              </div>
            ) : voiceChunks.length === 0 ? (
              <div className="p-4 font-mono text-sm text-muted-foreground/40 italic">
                Waiting for speech…
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {[...voiceChunks].reverse().map((chunk, ri) => (
                  <div key={voiceChunks.length - ri} className="px-4 py-3">
                    <p className="mb-1 font-mono text-[10px] text-muted-foreground/50">
                      {formatRelative(now - chunk.receivedAt)}
                    </p>
                    <p className="font-mono text-sm leading-relaxed text-foreground">
                      {chunk.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
