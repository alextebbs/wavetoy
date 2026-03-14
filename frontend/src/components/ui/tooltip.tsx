import { useCallback, useRef, useState } from "react";

const DELAY_MS = 400;
const OFFSET_PX = 6;

type Side = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content: string;
  side?: Side;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
}

export function Tooltip({ content, side = "bottom", children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x: number;
    let y: number;
    switch (side) {
      case "top":
        x = r.left + r.width / 2;
        y = r.top - OFFSET_PX;
        break;
      case "bottom":
        x = r.left + r.width / 2;
        y = r.bottom + OFFSET_PX;
        break;
      case "left":
        x = r.left - OFFSET_PX;
        y = r.top + r.height / 2;
        break;
      case "right":
        x = r.right + OFFSET_PX;
        y = r.top + r.height / 2;
        break;
    }
    setPos({ x, y });
    setVisible(true);
  }, [side]);

  const onEnter = useCallback(() => {
    timerRef.current = setTimeout(show, DELAY_MS);
  }, [show]);

  const onLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  const transform = {
    top: "translate(-50%, -100%)",
    bottom: "translate(-50%, 0)",
    left: "translate(-100%, -50%)",
    right: "translate(0, -50%)",
  }[side];

  return (
    <>
      <span
        ref={triggerRef as React.Ref<HTMLSpanElement>}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        className="inline-flex"
      >
        {children}
      </span>
      {visible && (
        <div
          className="fixed z-[100] max-w-xs rounded bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md border border-border pointer-events-none"
          style={{
            left: pos.x,
            top: pos.y,
            transform,
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
