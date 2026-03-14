// ─── Color map definitions (universal, not theme-specific) ───────────────────

export type ColorMapFn = (t: number) => [number, number, number];

export type ColorMapName = "turbo" | "viridis" | "grayscale" | "kiwi" | "phosphor";

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
  phosphor: piecewiseLinear([
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

  turbo: piecewiseLinear([
    [0.0, 48, 18, 59],
    [0.07, 69, 55, 129],
    [0.13, 67, 95, 195],
    [0.2, 45, 135, 232],
    [0.27, 24, 170, 222],
    [0.33, 18, 198, 185],
    [0.4, 35, 220, 140],
    [0.47, 82, 235, 95],
    [0.53, 140, 241, 62],
    [0.6, 195, 237, 46],
    [0.67, 232, 222, 42],
    [0.73, 252, 196, 37],
    [0.8, 253, 161, 27],
    [0.87, 240, 118, 16],
    [0.93, 213, 73, 7],
    [1.0, 122, 4, 3],
  ]),

  viridis: piecewiseLinear([
    [0.0, 68, 1, 84],
    [0.1, 72, 36, 117],
    [0.2, 64, 67, 135],
    [0.3, 52, 94, 141],
    [0.4, 41, 120, 142],
    [0.5, 32, 144, 140],
    [0.6, 34, 167, 132],
    [0.7, 68, 190, 112],
    [0.8, 121, 209, 81],
    [0.9, 189, 222, 38],
    [1.0, 253, 231, 37],
  ]),

  grayscale: (t) => {
    const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
    return [v, v, v];
  },

  kiwi: piecewiseLinear([
    [0.0, 0, 0, 0],
    [0.15, 0, 0, 180],
    [0.3, 0, 140, 255],
    [0.45, 0, 255, 140],
    [0.6, 180, 255, 0],
    [0.75, 255, 180, 0],
    [0.88, 255, 60, 0],
    [1.0, 255, 255, 255],
  ]),
};

export function getColorMap(name: ColorMapName): ColorMapFn {
  return WATERFALL_COLOR_MAPS[name] ?? WATERFALL_COLOR_MAPS.turbo;
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
