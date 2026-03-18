import type { MapSourceCounts, Source } from "@/lib/api";
import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { FeatureCollection } from "geojson";
import WorldData from "geojson-world-map/lib/world";
import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import MapLibreMap, { Marker, type MapRef } from "react-map-gl/maplibre";

export type SourceMapPickerHandle = {
  flyTo: (latitude: number, longitude: number, zoom?: number) => void;
};

type SourceMapPickerProps = {
  sources: Source[];
  counts: MapSourceCounts;
  selectedSourceId?: string;
  favoriteIds?: Set<string>;
  onSelectSource: (source: Source) => void;
  onDeselectSource?: () => void;
  onHoverSource?: (source: Source | null) => void;
  className?: string;
  showCounts?: boolean;
};

const COUNTRIES_GEOJSON = WorldData as FeatureCollection;

function computeTerminator(time: Date): FeatureCollection {
  const start = Date.UTC(time.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((time.getTime() - start) / 86400000) + 1;

  let decDeg = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  if (Math.abs(decDeg) < 0.1) decDeg = decDeg >= 0 ? 0.1 : -0.1;
  const decRad = (decDeg * Math.PI) / 180;

  const B = (2 * Math.PI / 365) * (dayOfYear - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  const utcH = time.getUTCHours() + time.getUTCMinutes() / 60 + time.getUTCSeconds() / 3600;
  let sunLon = (12 - utcH - eot / 60) * 15;
  while (sunLon > 180) sunLon -= 360;
  while (sunLon < -180) sunLon += 360;

  const allCoords: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon++) {
    const ha = ((lon - sunLon) * Math.PI) / 180;
    const lat = Math.atan(-Math.cos(ha) / Math.tan(decRad)) * (180 / Math.PI);
    allCoords.push([lon, lat]);
  }

  const pole = decDeg >= 0 ? -90 : 90;
  const ring: [number, number][] = [...allCoords, [180, pole], [-180, pole]];

  const maxLat = 85;
  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const pt of allCoords) {
    if (Math.abs(pt[1]) <= maxLat) {
      cur.push(pt);
    } else if (cur.length >= 2) {
      segments.push(cur);
      cur = [];
    } else {
      cur = [];
    }
  }
  if (cur.length >= 2) segments.push(cur);

  const lineFeatures = segments.map((s) => ({
    type: "Feature" as const,
    properties: { role: "line" },
    geometry: { type: "LineString" as const, coordinates: s },
  }));

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { role: "shade" },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
      ...lineFeatures,
    ],
  };
}

function snrToDotColor(
  snr: number | undefined,
  minSNR: number,
  maxSNR: number,
  mapColors: ReturnType<typeof useThemeStore.getState>["theme"]["map"],
) {
  if (!Number.isFinite(snr)) return mapColors.snrFallback;
  const range = maxSNR - minSNR;
  const t = range > 0 ? ((snr ?? minSNR) - minSNR) / range : 0.5;
  const clamped = Math.max(0, Math.min(1, t));
  const [lo, hi] = mapColors.snrHueRange;
  const hue = lo + clamped * (hi - lo);
  return `hsl(${hue} ${mapColors.snrSaturation}% ${mapColors.snrLightness}%)`;
}

export const SourceMapPicker = memo(forwardRef<SourceMapPickerHandle, SourceMapPickerProps>(function SourceMapPicker({
  sources,
  counts,
  selectedSourceId,
  favoriteIds,
  onSelectSource,
  onDeselectSource,
  onHoverSource,
  className,
  showCounts = true,
}, ref) {
  const mapColors = useThemeStore((s) => s.baseTheme.map);
  const [hoveredID, setHoveredID] = useState<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  useImperativeHandle(ref, () => ({
    flyTo: (latitude: number, longitude: number, zoom = 6) => {
      mapRef.current?.flyTo({
        center: [longitude, latitude],
        zoom,
        duration: 1500,
      });
    },
  }), []);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const terminatorData = useMemo(() => computeTerminator(now), [now]);

  const mapStyle = useMemo(
    () =>
      ({
        version: 8,
        sources: {
          countries: {
            type: "geojson",
            data: COUNTRIES_GEOJSON,
          },
          terminator: {
            type: "geojson",
            data: terminatorData,
          },
        },
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#000000" },
          },
          {
            id: "country-fill",
            type: "fill",
            source: "countries",
            paint: {
              "fill-color": mapColors.countryLines,
              "fill-opacity": 0.25,
            },
          },
          {
            id: "country-lines",
            type: "line",
            source: "countries",
            paint: {
              "line-color": mapColors.countryLines,
              "line-opacity": mapColors.countryLineOpacity,
              "line-width": 1.1,
            },
          },
          {
            id: "night-shade",
            type: "fill",
            source: "terminator",
            filter: ["==", ["get", "role"], "shade"],
            paint: {
              "fill-color": "#000000",
              "fill-opacity": 0.3,
            },
          },
          {
            id: "grey-line",
            type: "line",
            source: "terminator",
            filter: ["==", ["get", "role"], "line"],
            paint: {
              "line-color": "#888888",
              "line-width": 1.5,
              "line-opacity": 0.6,
            },
          },
        ],
      }) as never,
    [mapColors.countryLines, mapColors.countryLineOpacity, terminatorData],
  );

  const plottableSources = useMemo(() => {
    const seen = new Set<string>();
    return sources.filter(
      (s): s is Source & { latitude: number; longitude: number } => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return typeof s.latitude === "number" && typeof s.longitude === "number";
      },
    );
  }, [sources]);

  const snrStats = useMemo(() => {
    const snrs = plottableSources
      .map((s) => s.snr_dbm)
      .filter((v): v is number => Number.isFinite(v));
    if (snrs.length === 0) {
      return { min: -10, max: 40 };
    }
    return {
      min: Math.min(...snrs),
      max: Math.max(...snrs),
    };
  }, [plottableSources]);

  const [initialZoom] = useState(() => {
    const h = typeof window !== "undefined" ? window.innerHeight : 800;
    if (h >= 1200) return 2.2;
    if (h >= 900) return 1.8;
    if (h >= 700) return 1.5;
    return 1.2;
  });

  return (
    <div className={cn("relative h-full w-full", className)}>
      {showCounts ? (
        <p className="absolute left-4 top-4 z-10 text-xs text-muted-foreground">
          {counts.included} sources shown, {counts.omitted} omitted (
          {counts.total} total)
        </p>
      ) : null}
      <MapLibreMap
        ref={mapRef}
        initialViewState={{ longitude: 0, latitude: 20, zoom: initialZoom }}
        maxZoom={14}
        minZoom={1}
        projection="globe"
        mapStyle={mapStyle}
        attributionControl={false}
        touchPitch={false}
        style={{ width: "100%", height: "100%" }}
        onClick={(e) => {
          if (e.originalEvent.target instanceof HTMLElement && e.originalEvent.target.closest(".maplibregl-marker")) return;
          onDeselectSource?.();
        }}
      >
          {plottableSources.map((source) => {
            const selected = source.id === selectedSourceId;
            const hovered = hoveredID === source.id;
            const isFav = favoriteIds?.has(source.id) ?? false;
            const color = selected ? "#ff2d9b" : snrToDotColor(source.snr_dbm, snrStats.min, snrStats.max, mapColors);
            const size = selected ? 12 : hovered ? (isFav ? 10 : 8) : (isFav ? 7 : 5);
            return (
              <Marker
                key={source.id}
                latitude={source.latitude}
                longitude={source.longitude}
                anchor="center"
                opacityWhenCovered="0"
              >
                <button
                  type="button"
                  onClick={() => onSelectSource(source)}
                  onMouseEnter={() => {
                    setHoveredID(source.id);
                    onHoverSource?.(source);
                  }}
                  onMouseLeave={() => {
                    setHoveredID((prev) => (prev === source.id ? null : prev));
                    onHoverSource?.(null);
                  }}
                  className="block cursor-pointer rounded-full border-none p-0 transition-[width,height] duration-100"
                  style={{
                    width: size,
                    height: size,
                    background: color,
                    boxShadow: isFav && !selected ? "0 0 0 1.5px #f59e0b" : undefined,
                  }}
                  aria-label={`Select source ${source.name}`}
                />
              </Marker>
            );
          })}
        </MapLibreMap>
    </div>
  );
}));
