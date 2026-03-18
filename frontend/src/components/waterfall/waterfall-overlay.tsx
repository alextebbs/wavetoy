import { forwardRef, useImperativeHandle, useRef } from "react";
import type { OverlayState } from "./waterfall-renderer";

export interface WaterfallMarker {
  id: string;
  row: number;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface WaterfallOverlayHandle {
  addMarker(marker: WaterfallMarker): void;
  removeMarker(id: string): void;
  update(state: OverlayState): void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export const WaterfallOverlayLayer = forwardRef<WaterfallOverlayHandle>(
  function WaterfallOverlayLayer(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const markersRef = useRef<Map<string, WaterfallMarker>>(new Map());
    const nodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

    function createMarkerNode(marker: WaterfallMarker): HTMLDivElement {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.left = "0";
      el.style.width = "100%";
      el.style.display = "none";
      el.style.pointerEvents = "none";
      el.style.willChange = "transform";

      const line = document.createElement("div");
      line.style.position = "absolute";
      line.style.top = "0";
      line.style.left = "0";
      line.style.right = "0";
      line.style.height = "1px";
      line.style.backgroundColor = "rgba(255, 255, 255, 0.3)";
      el.appendChild(line);

      const pill = document.createElement("div");
      pill.style.position = "absolute";
      pill.style.top = "2px";
      pill.style.left = "4px";
      pill.style.fontSize = "10px";
      pill.style.lineHeight = "14px";
      pill.style.padding = "1px 5px";
      pill.style.borderRadius = "3px";
      pill.style.backgroundColor = "rgba(0, 0, 0, 0.55)";
      pill.style.color = "rgba(255, 255, 255, 0.7)";
      pill.style.whiteSpace = "nowrap";
      pill.style.pointerEvents = "auto";
      pill.style.fontFamily = "system-ui, sans-serif";
      pill.style.letterSpacing = "0.01em";

      const timeStr = marker.metadata?.started_at
        ? formatTime(marker.metadata.started_at as string)
        : marker.label;
      pill.textContent = timeStr;
      el.appendChild(pill);

      return el;
    }

    useImperativeHandle(ref, () => ({
      addMarker(marker: WaterfallMarker) {
        const existing = nodesRef.current.get(marker.id);
        if (existing) existing.remove();
        markersRef.current.set(marker.id, marker);
        const node = createMarkerNode(marker);
        nodesRef.current.set(marker.id, node);
        containerRef.current?.appendChild(node);
      },

      removeMarker(id: string) {
        markersRef.current.delete(id);
        const node = nodesRef.current.get(id);
        if (node) {
          node.remove();
          nodesRef.current.delete(id);
        }
      },

      update(state: OverlayState) {
        const { totalRows, scrollOffset, rowScale, height, dpr } = state;
        const cssHeight = height / dpr;

        for (const [id, marker] of markersRef.current) {
          const node = nodesRef.current.get(id);
          if (!node) continue;

          const canvasY = (totalRows - marker.row - scrollOffset) * rowScale;
          const cssY = canvasY / dpr;

          if (cssY < -20 || cssY > cssHeight + 20) {
            node.style.display = "none";
          } else {
            node.style.display = "";
            node.style.transform = `translateY(${cssY}px)`;
          }
        }
      },
    }));

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 z-10 pointer-events-none overflow-hidden"
      />
    );
  }
);
