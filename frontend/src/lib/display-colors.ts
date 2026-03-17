// ─── Color map definitions (one per theme) ───────────────────────────────────

export type ColorMapFn = (t: number) => [number, number, number];

export type ColorMapName = "default" | "muted" | "alert";

type ColorStop = [position: number, r: number, g: number, b: number];

function piecewiseLinear(stops: ColorStop[]): ColorMapFn {
  return (t: number) => {
    t = Math.max(0, Math.min(1, t));
    if (t <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
    const last = stops[stops.length - 1];
    if (t >= last[0]) return [last[1], last[2], last[3]];

    let i = 1;
    while (i < stops.length && stops[i][0] < t) i++;
    const a = stops[i - 1];
    const b = stops[i];
    const f = (t - a[0]) / (b[0] - a[0]);
    return [
      Math.round(a[1] + f * (b[1] - a[1])),
      Math.round(a[2] + f * (b[2] - a[2])),
      Math.round(a[3] + f * (b[3] - a[3])),
    ];
  };
}

export const WATERFALL_COLOR_MAPS: Record<ColorMapName, ColorMapFn> = {
  default: piecewiseLinear([
    [0.0,   2,   4,  10],
    [0.1,   4,  22,  38],
    [0.2,   6,  50,  60],
    [0.35, 10, 105,  95],
    [0.5,  20, 185,  85],
    [0.65, 85, 232,  55],
    [0.78, 200, 242,  62],
    [0.9, 255, 205,  80],
    [1.0, 255, 255, 225],
  ]),

  muted: (t) => {
    const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
    return [v, v, v];
  },

  alert: piecewiseLinear([
    [0.0,    4,   0,   0],
    [0.12,  30,   2,   2],
    [0.25,  80,   8,   4],
    [0.4,  150,  20,   8],
    [0.55, 200,  45,  10],
    [0.7,  235,  90,  15],
    [0.82, 250, 150,  30],
    [0.92, 255, 210,  80],
    [1.0,  255, 250, 200],
  ]),
};

export function getColorMap(name: ColorMapName): ColorMapFn {
  return WATERFALL_COLOR_MAPS[name] ?? WATERFALL_COLOR_MAPS.default;
}

/**
 * Sample a colormap into SVG feComponentTransfer tableValues strings.
 * Each channel gets N+1 values mapping grayscale input [0,1] → colored output [0,1].
 */
export function colorMapToFilterTables(
  fn: ColorMapFn,
  samples = 64,
): { r: string; g: string; b: string } {
  const rVals: string[] = [];
  const gVals: string[] = [];
  const bVals: string[] = [];

  for (let i = 0; i <= samples; i++) {
    const [r, g, b] = fn(i / samples);
    rVals.push((r / 255).toFixed(4));
    gVals.push((g / 255).toFixed(4));
    bVals.push((b / 255).toFixed(4));
  }

  return { r: rVals.join(" "), g: gVals.join(" "), b: bVals.join(" ") };
}

export function buildLUT(colorMap: ColorMapFn): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = colorMap(i / 255);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
