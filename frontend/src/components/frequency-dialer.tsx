import { useCallback, useEffect, useRef, useState } from "react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

type Props = {
  currentKHz: number;
  onSubmit: (kHz: number) => void;
  onClose: () => void;
};

export function FrequencyDialer({ currentKHz, onSubmit, onClose }: Props) {
  const [draft, setDraft] = useState(String(currentKHz));
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const doFlash = useCallback((key: string) => {
    setFlash(key);
    setTimeout(() => setFlash(null), 120);
  }, []);

  const appendKey = useCallback(
    (key: string) => {
      if (key === "⌫") {
        setDraft((d) => d.slice(0, -1));
        doFlash(key);
        return;
      }
      if (key === "." && draft.includes(".")) return;
      setDraft((d) => d + key);
      doFlash(key);
    },
    [draft, doFlash],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (/^[0-9]*\.?[0-9]*$/.test(raw)) {
      const last = raw.slice(-1);
      if (last && last !== ".") doFlash(last);
      setDraft(raw);
    }
  };

  const MAX_KHZ = 30000;

  const handleSubmit = () => {
    const val = Number.parseFloat(draft);
    if (Number.isFinite(val) && val > 0) {
      onSubmit(Math.min(val, MAX_KHZ));
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const isValid = (() => {
    const val = Number.parseFloat(draft);
    return Number.isFinite(val) && val > 0;
  })();

  return (
    <div
      ref={panelRef}
      className="absolute top-full left-1/2 z-50 mt-4 -translate-x-1/2 rounded-md border border-border bg-background shadow-2xl"
      onKeyDown={handleKeyDown}
    >
      <table style={{ borderCollapse: "collapse", borderSpacing: 0, tableLayout: "fixed", width: 252 }}>
        <colgroup>
          <col style={{ width: 84 }} />
          <col style={{ width: 84 }} />
          <col style={{ width: 84 }} />
        </colgroup>
        <tbody>
          {[0, 1, 2, 3].map((row) => (
            <tr key={row}>
              {KEYS.slice(row * 3, row * 3 + 3).map((key, col) => (
                <td
                  key={key}
                  style={{
                    borderRight: col < 2 ? "1px solid hsl(var(--border))" : undefined,
                    borderBottom: row < 3 ? "1px solid hsl(var(--border))" : undefined,
                    padding: 0,
                  }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      appendKey(key);
                      inputRef.current?.focus();
                    }}
                    className={`font-xanh-mono flex h-14 w-full items-center justify-center text-xl transition-colors select-none ${
                      flash === key
                        ? "bg-primary/25 text-foreground"
                        : "text-muted-foreground hover:bg-primary/10 hover:text-foreground"
                    }`}
                  >
                    {key}
                  </button>
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td
              colSpan={2}
              style={{
                borderTop: "1px solid hsl(var(--border))",
                borderRight: "1px solid hsl(var(--border))",
                padding: 0,
              }}
            >
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={draft}
                onChange={handleInputChange}
                className="font-xanh-mono h-14 w-full bg-card px-3 text-center text-xl text-foreground outline-none focus-visible:bg-primary/5"
              />
            </td>
            <td
              style={{
                borderTop: "1px solid hsl(var(--border))",
                padding: 0,
              }}
            >
              <button
                type="button"
                disabled={!isValid}
                onClick={handleSubmit}
                className="flex h-14 w-full items-center justify-center bg-primary text-base font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
              >
                Go
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
