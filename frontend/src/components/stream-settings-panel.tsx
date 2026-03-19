import { useRef, useState } from "react";
import type { Stream } from "@/lib/api";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import {
  HardDriveIcon,
  HeartPulseIcon,
  PencilIcon,
  PlugIcon,
  ShieldCheckIcon,
  Skull,
} from "lucide-react";

interface StreamSettingsPanelProps {
  stream: Stream | null;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => Promise<void>;
}

function Toggle({
  active,
  label,
  icon,
  activeTooltip,
  inactiveTooltip,
  onToggle,
  disabled,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  activeTooltip: string;
  inactiveTooltip: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <span className="shrink-0 text-xs uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="flex justify-end">
        <Tooltip content={active ? activeTooltip : inactiveTooltip}>
          <Button
            variant={active ? "outline" : "ghost"}
            size="icon"
            className="h-6 w-6"
            onClick={onToggle}
            disabled={disabled}
          >
            {icon}
          </Button>
        </Tooltip>
      </span>
    </>
  );
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
        {/* Feature toggles */}
        <div className="border-b border-border/80 px-3 pt-3 pb-2">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
            <Toggle
              label="auto probe"
              active={stream.auto_probe}
              icon={<ShieldCheckIcon className="size-3" />}
              activeTooltip="Disable auto probe"
              inactiveTooltip="Enable auto probe"
              onToggle={() => onPatch({ auto_probe: !stream.auto_probe })}
              disabled
            />
            <Toggle
              label="keep alive"
              active={stream.keep_alive}
              icon={<PlugIcon className="size-3" />}
              activeTooltip="Disable keep alive"
              inactiveTooltip="Enable keep alive"
              onToggle={() => onPatch({ keep_alive: !stream.keep_alive })}
            />
            <Toggle
              label="quality fallback"
              active={stream.quality_fallback}
              icon={<HeartPulseIcon className="size-3" />}
              activeTooltip="Disable quality fallback"
              inactiveTooltip="Enable quality fallback"
              onToggle={() => onPatch({ quality_fallback: !stream.quality_fallback })}
              disabled
            />
            <Toggle
              label="chunk offload"
              active={stream.offload_chunks}
              icon={<HardDriveIcon className="size-3" />}
              activeTooltip="Disable chunk offloading"
              inactiveTooltip="Enable chunk offloading"
              onToggle={() => onPatch({ offload_chunks: !stream.offload_chunks })}
            />
          </div>
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
