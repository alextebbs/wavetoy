import type { MapSourceCounts, Source } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FeatureCollection } from "geojson";
import WorldData from "geojson-world-map/lib/world";
import { useMemo, useState } from "react";
import MapLibreMap, {
  Layer,
  Marker,
  Source as MapSource,
} from "react-map-gl/maplibre";

const BASE_STYLE = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#000000",
      },
    },
  ],
};

type SourceMapPickerProps = {
  sources: Source[];
  counts: MapSourceCounts;
  selectedSourceId?: string;
  onSelectSource: (source: Source) => void;
  onHoverSource?: (source: Source | null) => void;
  className?: string;
  showCounts?: boolean;
};

const COUNTRIES_GEOJSON = WorldData as FeatureCollection;

function snrToDotColor(
  snr: number | undefined,
  minSNR: number,
  maxSNR: number,
) {
  if (!Number.isFinite(snr)) return "#facc15";
  const range = maxSNR - minSNR;
  const t = range > 0 ? ((snr ?? minSNR) - minSNR) / range : 0.5;
  const clamped = Math.max(0, Math.min(1, t));
  const hue = 8 + clamped * 112; // red-orange to green
  return `hsl(${hue} 95% 55%)`;
}

export function SourceMapPicker({
  sources,
  counts,
  selectedSourceId,
  onSelectSource,
  onHoverSource,
  className,
  showCounts = true,
}: SourceMapPickerProps) {
  const [hoveredID, setHoveredID] = useState<string | null>(null);

  const plottableSources = useMemo(
    () =>
      sources.filter(
        (s): s is Source & { latitude: number; longitude: number } =>
          typeof s.latitude === "number" && typeof s.longitude === "number",
      ),
    [sources],
  );

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

  return (
    <div className={cn("space-y-3", className)}>
      {showCounts ? (
        <p className="text-xs text-muted-foreground">
          {counts.included} sources shown, {counts.omitted} omitted (
          {counts.total} total)
        </p>
      ) : null}
      <div
        className={cn(
          "relative w-full",
          showCounts
            ? "h-[calc(100%-28px)] min-h-[520px]"
            : "h-full min-h-[520px]",
        )}
      >
        <MapLibreMap
          initialViewState={{ longitude: 0, latitude: 20, zoom: 1.6 }}
          maxZoom={14}
          minZoom={1}
          mapStyle={BASE_STYLE as never}
          attributionControl={false}
          dragRotate={false}
          touchPitch={false}
          style={{ width: "100%", height: "100%" }}
        >
          <MapSource id="countries" type="geojson" data={COUNTRIES_GEOJSON}>
            <Layer
              id="country-lines"
              type="line"
              paint={{
                "line-color": "#8a8a8a",
                "line-opacity": 0.72,
                "line-width": 1.1,
              }}
            />
          </MapSource>
          {plottableSources.map((source) => {
            const selected = source.id === selectedSourceId;
            const hoveredOnDot = hoveredID === source.id;
            return (
              <Marker
                key={source.id}
                latitude={source.latitude}
                longitude={source.longitude}
                anchor="center"
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
                  className="relative rounded-full border-none bg-transparent p-0"
                  style={{
                    width: 30,
                    height: 30,
                    cursor: "pointer",
                  }}
                  aria-label={`Select source ${source.name}`}
                >
                  <span
                    className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      width: selected ? 13 : hoveredOnDot ? 12 : 9,
                      height: selected ? 13 : hoveredOnDot ? 12 : 9,
                      background: snrToDotColor(
                        source.snr_dbm,
                        snrStats.min,
                        snrStats.max,
                      ),
                      boxShadow: selected ? "0 0 0 1px #fde68a" : "none",
                      transition:
                        "width 140ms ease, height 140ms ease, transform 140ms ease",
                    }}
                  />
                  {selected ? (
                    <>
                      <span className="absolute left-1/2 top-1/2 h-[2px] w-[28px] -translate-x-1/2 -translate-y-1/2 bg-yellow-200/90" />
                      <span className="absolute left-1/2 top-1/2 h-[28px] w-[2px] -translate-x-1/2 -translate-y-1/2 bg-yellow-200/90" />
                    </>
                  ) : null}
                </button>
              </Marker>
            );
          })}
        </MapLibreMap>
      </div>
    </div>
  );
}
