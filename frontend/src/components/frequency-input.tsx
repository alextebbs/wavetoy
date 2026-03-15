import { useCallback, useEffect, useRef, useState } from "react";
import { IMaskInput } from "react-imask";
import { Tooltip } from "@/components/ui/tooltip";

const MAX_KHZ = 30000;
const STEP_KHZ = 0.05;
const FINE_STEP_KHZ = 0.01;
const KNOB_SPEED = 0.5;
const KNOB_FINE_SPEED = 0.003;

function snap(v: number, step = STEP_KHZ): number {
  return Math.round(v / step) * step;
}

function formatFreq(v: number): string {
  return v.toFixed(2).padStart(8, "0");
}

interface FrequencyInputProps {
  value: number;
  onSubmit: (kHz: number) => void;
}

export function FrequencyInput({ value, onSubmit }: FrequencyInputProps) {
  const [editing, setEditing] = useState(false);
  const [draftVal, setDraftVal] = useState("");
  const maskedRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const knobRef = useRef<HTMLButtonElement>(null);
  const draggingKnob = useRef(false);
  const knobStartX = useRef(0);
  const knobStartValue = useRef(0);
  const [knobAngle, setKnobAngle] = useState(0);
  const knobStartAngle = useRef(0);

  const startEditing = useCallback(() => {
    if (editing) return;
    setDraftVal(formatFreq(value));
    setEditing(true);
  }, [editing, value]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        maskedRef.current?.focus();
        maskedRef.current?.select();
      });
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editing]);

  const parsedDraft = Number.parseFloat(draftVal);
  const isValid = Number.isFinite(parsedDraft) && parsedDraft > 0 && parsedDraft <= MAX_KHZ;

  const submit = useCallback(() => {
    if (isValid) {
      onSubmit(parsedDraft);
    }
    setEditing(false);
  }, [isValid, parsedDraft, onSubmit]);

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!draggingKnob.current) return;
      const dx = e.clientX - knobStartX.current;
      const fine = e.shiftKey;
      const speed = fine ? KNOB_FINE_SPEED : KNOB_SPEED;
      const delta = dx * speed;
      const next = snap(knobStartValue.current + delta, fine ? FINE_STEP_KHZ : STEP_KHZ);
      const clamped = Math.max(0, Math.min(next, MAX_KHZ));
      onSubmitRef.current(clamped);
      setKnobAngle(knobStartAngle.current + dx * 2);
    };

    const onPointerUp = () => {
      if (!draggingKnob.current) return;
      draggingKnob.current = false;
      document.body.style.cursor = "";
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const onKnobPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingKnob.current = true;
    knobStartX.current = e.clientX;
    knobStartValue.current = valueRef.current;
    knobStartAngle.current = knobAngle;
    document.body.style.cursor = "ew-resize";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [knobAngle]);

  const inputClasses =
    "font-xanh-mono bg-transparent p-0 text-left text-3xl leading-none font-normal tracking-wide outline-none md:text-4xl";

  return (
    <div ref={wrapperRef} className="relative flex h-full items-center gap-5">
      <Tooltip content="Hold shift for fine tuning">
        <button
          ref={knobRef}
          type="button"
          onPointerDown={onKnobPointerDown}
          className="flex size-8 cursor-ew-resize items-center justify-center rounded-full border-2 border-border bg-background text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground active:border-primary"
          style={{ transform: `rotate(${knobAngle}deg)` }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="1.5" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>

      <div className="relative flex h-full items-center border-x border-border px-6" style={{ zIndex: editing ? 50 : undefined }}>
        {editing && (
          <div className="absolute -inset-x-3 -inset-y-2 rounded-md border border-border bg-popover shadow-lg" />
        )}

        {editing ? (
          <IMaskInput
            inputRef={maskedRef}
            mask="00000.00"
            definitions={{ "0": /[0-9]/ }}
            placeholderChar=" "
            lazy={false}
            overwrite
            value={draftVal}
            onAccept={(val: string) => setDraftVal(val)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter") { e.preventDefault(); submit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
            className={`relative ${inputClasses} text-foreground caret-primary`}
            style={{ width: "8.5ch" }}
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className={`${inputClasses} cursor-pointer text-foreground transition-colors hover:text-primary`}
            style={{ width: "8.5ch" }}
          >
            {formatFreq(value)}
          </button>
        )}

        {editing && (
          <div className="absolute -inset-x-3 top-full flex rounded-b-md border border-t-0 border-border bg-popover shadow-lg" style={{ zIndex: 50 }}>
            <button
              type="button"
              disabled={!isValid}
              onClick={submit}
              className="flex-1 rounded-b-md px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              Set frequency
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
