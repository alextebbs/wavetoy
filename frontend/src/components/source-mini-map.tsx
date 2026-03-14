import type { Source } from "@/lib/api";
import { useThemeStore } from "@/lib/theme";
import type { FeatureCollection } from "geojson";
import WorldData from "geojson-world-map/lib/world";
import { useMemo } from "react";
import MapLibreMap, {
  Layer,
  Marker,
  Source as MapSource,
} from "react-map-gl/maplibre";

const COUNTRIES_GEOJSON = WorldData as FeatureCollection;

type SourceMiniMapProps = {
  source: Source | null;
  className?: string;
};

export function SourceMiniMap({ source, className }: SourceMiniMapProps) {
  const mapColors = useThemeStore((s) => s.theme.map);
  const hasCoords =
    source &&
    typeof source.latitude === "number" &&
    typeof source.longitude === "number";

  const mapStyle = useMemo(
    () => ({
      version: 8,
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": mapColors.background },
        },
      ],
    }),
    [mapColors.background]
  );

  return (
    <div className={className ?? "h-32 w-full overflow-hidden"}>
      <MapLibreMap
        key={hasCoords ? `${source.latitude},${source.longitude}` : "empty"}
        initialViewState={{
          longitude: hasCoords ? source.longitude! : 0,
          latitude: hasCoords ? source.latitude! : 20,
          zoom: hasCoords ? 1.8 : 0.8,
        }}
        interactive={false}
        mapStyle={mapStyle as never}
        attributionControl={false}
        style={{ width: "100%", height: "100%" }}
      >
        <MapSource id="countries" type="geojson" data={COUNTRIES_GEOJSON}>
          <Layer
            id="country-lines"
            type="line"
            paint={{
              "line-color": mapColors.countryLines,
              "line-opacity": mapColors.countryLineOpacity,
              "line-width": 0.8,
            }}
          />
        </MapSource>
        {hasCoords && (
          <Marker
            latitude={source.latitude!}
            longitude={source.longitude!}
            anchor="center"
          >
            <span
              className="block size-1.5 rounded-full"
              style={{
                backgroundColor: mapColors.markerColor,
                boxShadow: `0 0 4px ${mapColors.markerGlow}`,
              }}
            />
          </Marker>
        )}
      </MapLibreMap>
    </div>
  );
}
