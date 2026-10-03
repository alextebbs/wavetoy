import { useRef, useState } from "react";
import type { Stream } from "@/lib/api";
import { useScrollBackStore } from "@/lib/scroll-back-store";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import {
  ActivityIcon,
  PencilIcon,
  Skull,
} from "lucide-react";

interface StreamSettingsPanelProps {
  stream: Stream | null;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => Promise<void>;
}

export function StreamSettingsPanel({ stream, onPatch, onDelete }: StreamSettingsPanelProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!stream) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">No stream</p>
      </div>
    );
  }

  const startEditing = () => {
    setDraft(stream.name ?? "");
    setEditing(true);
    requestAnimationFrame(() => {
      const el = nameRef.current;
      if (el) { el.focus(); el.select(); }
    });
  };

  const commitName = () => {
    const name = draft.trim();
    if (name && name !== stream.name) onPatch({ name });
    setEditing(false);
  };

  const displayName = editing ? draft : (stream.name || "Untitled stream");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Name — flush box at top */}
      <div
        className="group/name relative shrink-0 cursor-pointer border-b border-border/80 px-3 py-2.5 transition-colors duration-150 hover:bg-teal-500/10"
        onClick={() => { if (!editing) startEditing(); }}
      >
        <input
          ref={nameRef}
          type="text"
          readOnly={!editing}
          value={displayName}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { nameRef.current?.blur(); }
            if (e.key === "Escape") { setEditing(false); setDraft(""); }
          }}
          onBlur={commitName}
          onClick={(e) => { if (!editing) { e.stopPropagation(); startEditing(); } }}
          placeholder="Untitled stream"
          className={
            "font-xanh-mono w-full truncate bg-transparent text-2xl text-foreground outline-none" +
            (editing ? " cursor-text" : " pointer-events-none")
          }
        />
        {!editing && (
          <PencilIcon className="pointer-events-none absolute right-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/0 transition-colors duration-150 group-hover/name:text-muted-foreground/50" />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* Monitor mode toggle */}
        <div className="border-b border-border/80 px-3 py-2.5">
          <MonitorModeToggle onPatch={onPatch} />
        </div>

        {/* Stream info */}
        <div className="px-3 pt-3 pb-2">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">id</span>
            <span className="min-w-0 select-all truncate text-right text-white" title={stream.id}>{stream.id}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">state</span>
            <span className="min-w-0 truncate text-right text-white">{stream.state}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">source</span>
            <span className="min-w-0 truncate text-right text-white" title={stream.source_id}>{stream.source_id}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">frequency</span>
            <span className="min-w-0 truncate text-right text-white">{stream.frequency_khz} kHz</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">mode</span>
            <span className="min-w-0 truncate text-right text-white">{stream.mode}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">bandwidth</span>
            <span className="min-w-0 truncate text-right text-white">{stream.bandwidth_low_hz} / {stream.bandwidth_high_hz} Hz</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">agc</span>
            <span className="min-w-0 truncate text-right text-white">
              {stream.agc_on ? `on${stream.agc_gain_db != null ? ` (${stream.agc_gain_db}dB)` : ""}` : "off"}
            </span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">buffer</span>
            <span className="min-w-0 truncate text-right text-white">{stream.buffer_minutes} min</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">log level</span>
            <span className="min-w-0 truncate text-right text-white">{stream.log_level ?? "info"}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">version</span>
            <span className="min-w-0 truncate text-right text-white">{stream.version}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">created</span>
            <span className="min-w-0 truncate text-right text-white">{new Date(stream.created_at).toLocaleDateString()}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">auto probe</span>
            <span className={`min-w-0 truncate text-right ${stream.auto_probe ? "text-white" : "text-muted-foreground"}`}>{stream.auto_probe ? "on" : "off"}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">keep alive</span>
            <span className={`min-w-0 truncate text-right ${stream.keep_alive ? "text-white" : "text-muted-foreground"}`}>{stream.keep_alive ? "on" : "off"}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">quality fallback</span>
            <span className={`min-w-0 truncate text-right ${stream.quality_fallback ? "text-white" : "text-muted-foreground"}`}>{stream.quality_fallback ? "on" : "off"}</span>

            <span className="shrink-0 uppercase tracking-widest text-muted-foreground">chunk offload</span>
            <span className={`min-w-0 truncate text-right ${stream.offload_chunks ? "text-white" : "text-muted-foreground"}`}>{stream.offload_chunks ? "on" : "off"}</span>
          </div>
        </div>
      </div>

      {/* Kill zone — flush container */}
      <div className="shrink-0 border-t border-destructive/20">
        {confirmDelete ? (
          <div className="flex min-h-12 items-center justify-between bg-destructive/10 px-3 py-3">
            <span className="text-xs text-destructive">Kill this stream?</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDelete();
                  } finally {
                    setDeleting(false);
                    setConfirmDelete(false);
                  }
                }}
              >
                <Skull className="mr-1 size-3" />
                {deleting ? "Killing..." : "Kill"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full min-h-12 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive px-3 py-3"
            onClick={() => setConfirmDelete(true)}
          >
            <Skull className="mr-1 size-3" />
            Kill
          </Button>
        )}
      </div>
    </div>
  );
}

function MonitorModeToggle({ onPatch }: { onPatch: (patch: Record<string, unknown>) => void }) {
  const monitorMode = useScrollBackStore((s) => s.monitorMode);
  const streamLocked = useScrollBackStore((s) => s.streamLocked);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleSwitchClick = () => {
    if (streamLocked) return;
    setConfirmOpen(true);
  };

  const confirm = () => {
    const next = !monitorMode;
    onPatch({
      auto_probe: next,
      quality_fallback: next,
      keep_alive: next,
      offload_chunks: next,
      ...(next ? { locked: true } : {}),
    });
    setConfirmOpen(false);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ActivityIcon className={`size-3.5 ${monitorMode ? "text-purple-400" : "text-muted-foreground"}`} />
          <span className={`text-xs uppercase tracking-widest ${monitorMode ? "text-purple-400" : "text-muted-foreground"}`}>
            Monitor mode
          </span>
        </div>
        <Switch
          checked={monitorMode}
          onCheckedChange={handleSwitchClick}
          disabled={streamLocked}
          className="data-[state=checked]:bg-purple-600"
        />
      </div>

      <DialogPrimitive.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-[fade-in_220ms_ease-out] data-[state=closed]:animate-[fade-out_180ms_ease-in]" />
          <DialogPrimitive.Content className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none">
            <div className="w-full max-w-lg rounded-lg border border-purple-500/30 bg-background p-5 shadow-lg">
              <DialogPrimitive.Title className="font-xanh-mono flex items-center gap-2 text-base uppercase tracking-wide text-purple-400">
                <ActivityIcon className="size-4" />
                {monitorMode ? "Disable" : "Enable"} monitoring
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <div className="mt-3 space-y-2 text-sm leading-relaxed text-purple-200/70 [&_strong]:font-normal [&_strong]:text-purple-400">
                  {monitorMode ? (
                    <p>The stream will no longer automatically recover from source failures, stay alive, or archive data.</p>
                  ) : (
                    <>
                      <p>This stream <strong>will never die</strong>, even if no one is listening to it.</p>
                      <p>This stream will automatically <strong>scan for backup sources</strong> and switch to them to <strong>recover from source failures</strong>.</p>
                      <p>This stream will <strong>archive all data</strong> (audio and waterfall) to long term storage (30 days history preserved).</p>
                      <p>Turning on monitor mode will also <strong>lock your stream settings</strong>, but you can unlock them if you wish.</p>
                      <p className="mt-3 text-purple-400">Please make sure you understand the implications of your decision.</p>
                    </>
                  )}
                </div>
              </DialogPrimitive.Description>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-purple-400/60 hover:text-purple-300"
                  onClick={() => setConfirmOpen(false)}
                >
                  {monitorMode ? "Cancel" : "Don\u2019t enable"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-purple-500/40 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300"
                  onClick={confirm}
                >
                  {monitorMode ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
