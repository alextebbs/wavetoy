import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { InterpreterConfig } from "@/lib/api";
import { ClipboardCopyIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useCallback, useEffect, useRef } from "react";

interface Props {
  config: InterpreterConfig;
  onConfigChange: (config: InterpreterConfig) => void;
  text: string;
  wpm: number;
  detectedSidetoneHz: number;
  onClear: () => void;
}

export function InterpreterPanel({
  config,
  onConfigChange,
  text,
  wpm,
  detectedSidetoneHz,
  onClear,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    autoScrollRef.current = atBottom;
  }, []);

  const enabled = config.enabled ?? false;
  const isAutoSidetone = !config.sidetone_hz;
  const displaySidetoneHz = isAutoSidetone
    ? detectedSidetoneHz || 700
    : config.sidetone_hz!;
  const configWpm = config.wpm || 0;

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
  }, [text]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Controls */}
      <div className="space-y-4 border-b p-4">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-widest text-muted-foreground">
            Morse Decoder
          </Label>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              onConfigChange({
                ...config,
                type: "morse",
                enabled: checked,
              })
            }
          />
        </div>

        {enabled && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">
                  Sidetone
                </Label>
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
          </>
        )}
      </div>

      {/* Output */}
      {enabled && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Decoded
              </span>
              {wpm > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {wpm} WPM
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Tooltip content="Copy text">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCopy}
                  disabled={!text}
                >
                  <ClipboardCopyIcon className="size-3" />
                </Button>
              </Tooltip>
              <Tooltip content="Clear">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClear}
                  disabled={!text}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </Tooltip>
            </div>
          </div>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-auto bg-black/30 p-4 font-mono text-sm leading-relaxed text-green-400"
          >
            {text || (
              <span className="text-muted-foreground/40 italic">
                Waiting for signal…
              </span>
            )}
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-green-400/70" />
          </div>
        </div>
      )}
    </section>
  );
}
