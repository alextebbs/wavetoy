import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { CONTROL_THROTTLE_MS } from "@/lib/timing";

const ZOOM_BASE = 0.9995;

export function computeOptimalWFConfig(
  viewStartKHz: number,
  viewEndKHz: number,
  maxBwKHz: number
): {
  zoom: number;
  centerKHz: number;
  dataStartKHz: number;
  dataEndKHz: number;
} {
  const viewSpan = viewEndKHz - viewStartKHz;
  const viewCenter = (viewStartKHz + viewEndKHz) / 2;

  const desiredSpan = viewSpan * 1.3;
  const zoom = Math.max(
    0,
    Math.min(14, Math.floor(Math.log2(maxBwKHz / desiredSpan)))
  );

  const dataSpan = maxBwKHz / Math.pow(2, zoom);
  let dataStart = viewCenter - dataSpan / 2;
  let dataEnd = viewCenter + dataSpan / 2;

  if (dataStart < 0) {
    dataEnd += -dataStart;
    dataStart = 0;
  }
  if (dataEnd > maxBwKHz) {
    dataStart -= dataEnd - maxBwKHz;
    dataEnd = maxBwKHz;
  }
  dataStart = Math.max(0, dataStart);
  dataEnd = Math.min(maxBwKHz, dataEnd);

  return {
    zoom,
    centerKHz: (dataStart + dataEnd) / 2,
    dataStartKHz: dataStart,
    dataEndKHz: dataEnd,
  };
}

interface BandViewportProps {
  className?: string;
  children: ReactNode;
  zoomToCenter?: boolean;
  onClickFrequency?: (freqKHz: number) => void;
  onWFConfigChange?: (
    zoom: number,
    centerKHz: number,
    viewStartKHz: number,
    viewEndKHz: number
  ) => void;
  onDataCoverageChange?: (startKHz: number, endKHz: number) => void;
}

export function BandViewport({
  className,
  children,
  zoomToCenter,
  onClickFrequency,
  onWFConfigChange,
  onDataCoverageChange,
}: BandViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // --- WF config orchestration refs ---
  const lastConfigRef = useRef({
    zoom: 0,
    centerKHz: 15000,
    dataStartKHz: 0,
    dataEndKHz: 30000,
  });
  const configTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastConfigSentRef = useRef(0);

  // --- Interaction refs ---
  const dragRef = useRef({
    active: false,
    startX: 0,
    lastX: 0,
    velocityX: 0,
    lastTime: 0,
    wasDrag: false,
  });
  const momentumRef = useRef<number | null>(null);
  const touchRef = useRef<{ id1: number; id2: number; dist: number } | null>(
    null
  );

  const storeRef = useRef(useBandViewStore.getState());
  useEffect(
    () => useBandViewStore.subscribe((s) => { storeRef.current = s; }),
    []
  );

  // --- Stable callback refs so subscriptions don't churn ---
  const onWFConfigChangeRef = useRef(onWFConfigChange);
  onWFConfigChangeRef.current = onWFConfigChange;
  const onDataCoverageChangeRef = useRef(onDataCoverageChange);
  onDataCoverageChangeRef.current = onDataCoverageChange;
  const onClickFrequencyRef = useRef(onClickFrequency);
  onClickFrequencyRef.current = onClickFrequency;
  const zoomToCenterRef = useRef(zoomToCenter);
  zoomToCenterRef.current = zoomToCenter;

  // --- Throttled WF config on local view changes ---
  useEffect(
    () =>
      useBandViewStore.subscribe((state) => {
        if (!onWFConfigChangeRef.current) return;
        if (!state.initialized) return;
        if (state.viewSource !== "local") return;

        const maxBw = state.maxBandwidthKHz;
        if (maxBw <= 0) return;

        const sendConfig = () => {
          lastConfigSentRef.current = Date.now();
          const freshState = useBandViewStore.getState();
          const fresh = computeOptimalWFConfig(
            freshState.startKHz,
            freshState.endKHz,
            freshState.maxBandwidthKHz
          );
          lastConfigRef.current = {
            zoom: fresh.zoom,
            centerKHz: fresh.centerKHz,
            dataStartKHz: fresh.dataStartKHz,
            dataEndKHz: fresh.dataEndKHz,
          };
          onDataCoverageChangeRef.current?.(
            fresh.dataStartKHz,
            fresh.dataEndKHz
          );
          onWFConfigChangeRef.current?.(
            fresh.zoom,
            fresh.centerKHz,
            freshState.startKHz,
            freshState.endKHz
          );
        };

        const elapsed = Date.now() - lastConfigSentRef.current;
        if (elapsed >= CONTROL_THROTTLE_MS) {
          if (configTimerRef.current) {
            clearTimeout(configTimerRef.current);
            configTimerRef.current = null;
          }
          sendConfig();
        } else if (!configTimerRef.current) {
          configTimerRef.current = setTimeout(() => {
            configTimerRef.current = null;
            sendConfig();
          }, CONTROL_THROTTLE_MS - elapsed);
        }
      }),
    []
  );

  // --- Remote peer view changes: recompute data coverage once per message ---
  useEffect(
    () =>
      useBandViewStore.subscribe((state) => {
        if (!state.initialized) return;
        if (state.viewSource !== "remote") return;
        const maxBw = state.maxBandwidthKHz;
        if (maxBw <= 0) return;

        const { zoom, centerKHz, dataStartKHz, dataEndKHz } =
          computeOptimalWFConfig(state.startKHz, state.endKHz, maxBw);
        lastConfigRef.current = { zoom, centerKHz, dataStartKHz, dataEndKHz };
        onDataCoverageChangeRef.current?.(dataStartKHz, dataEndKHz);
      }),
    []
  );

  // --- Zoom (wheel) ---
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const normX = zoomToCenterRef.current
      ? 0.5
      : (e.clientX - rect.left) / rect.width;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 30;
    dy = Math.sign(dy) * Math.min(Math.abs(dy), 300);
    const factor = Math.pow(ZOOM_BASE, dy);
    useBandViewStore.getState().zoomAtNorm(normX, factor);
  }, []);

  // --- Pan (drag) + momentum ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current);
      momentumRef.current = null;
    }
    const el = overlayRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      lastX: e.clientX,
      velocityX: 0,
      lastTime: performance.now(),
      wasDrag: false,
    };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const el = overlayRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const dx = e.clientX - d.lastX;
    const now = performance.now();
    const dt = now - d.lastTime;

    if (Math.abs(e.clientX - d.startX) > 3) d.wasDrag = true;

    const normDelta = -dx / rect.width;
    useBandViewStore.getState().panByNorm(normDelta);

    if (dt > 0) {
      const instantVel = dx / dt;
      d.velocityX = d.velocityX * 0.6 + instantVel * 0.4;
    }

    d.lastX = e.clientX;
    d.lastTime = now;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const el = overlayRef.current;
    if (el) el.releasePointerCapture(e.pointerId);
    const d = dragRef.current;
    if (!d.active) return;
    const wasDrag = d.wasDrag;
    const velocity = d.velocityX;
    d.active = false;

    if (!wasDrag && onClickFrequencyRef.current) {
      const rect = el?.getBoundingClientRect();
      if (rect) {
        const normX = (e.clientX - rect.left) / rect.width;
        const s = storeRef.current;
        const freqKHz = s.startKHz + normX * (s.endKHz - s.startKHz);
        onClickFrequencyRef.current(Math.round(freqKHz * 100) / 100);
      }
      return;
    }

    if (Math.abs(velocity) > 0.05) {
      let vel = velocity;
      let lastT = performance.now();
      const decay = 0.95;
      const step = () => {
        const now = performance.now();
        const dt = now - lastT;
        lastT = now;
        vel *= Math.pow(decay, dt / 16);
        if (Math.abs(vel) < 0.01) {
          momentumRef.current = null;
          return;
        }
        const rect = overlayRef.current?.getBoundingClientRect();
        if (!rect) return;
        const normDelta = -(vel * dt) / rect.width;
        useBandViewStore.getState().panByNorm(normDelta);
        momentumRef.current = requestAnimationFrame(step);
      };
      momentumRef.current = requestAnimationFrame(step);
    }
  }, []);

  // --- Touch pinch-to-zoom ---
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      touchRef.current = {
        id1: t0.identifier,
        id2: t1.identifier,
        dist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
      };
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const pinch = touchRef.current;
    if (!pinch || e.touches.length < 2) return;
    let t0: React.Touch | undefined;
    let t1: React.Touch | undefined;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === pinch.id1) t0 = e.touches[i];
      if (e.touches[i].identifier === pinch.id2) t1 = e.touches[i];
    }
    if (!t0 || !t1) return;
    const newDist = Math.hypot(
      t1.clientX - t0.clientX,
      t1.clientY - t0.clientY
    );
    const scale = pinch.dist / newDist;
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const midX = zoomToCenterRef.current
      ? 0.5
      : ((t0.clientX + t1.clientX) / 2 - rect.left) / rect.width;
    useBandViewStore.getState().zoomAtNorm(midX, scale);
    pinch.dist = newDist;
  }, []);

  const handleTouchEnd = useCallback(() => {
    touchRef.current = null;
  }, []);

  // --- Attach wheel listener to container so it works over child overlays too ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
      if (momentumRef.current !== null) {
        cancelAnimationFrame(momentumRef.current);
      }
      if (configTimerRef.current) {
        clearTimeout(configTimerRef.current);
      }
    };
  }, [handleWheel]);

  return (
    <div ref={containerRef} className={`relative flex flex-col ${className ?? ""}`}>
      {children}
      {/* Transparent interaction overlay on top of everything */}
      <div
        ref={overlayRef}
        className="absolute inset-0 z-20 cursor-crosshair touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
}
