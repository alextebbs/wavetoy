export interface FrequencyBand {
  name: string;
  startKHz: number;
  endKHz: number;
}

export const AMATEUR_BANDS: FrequencyBand[] = [
  { name: "2200m", startKHz: 135.7, endKHz: 137.8 },
  { name: "630m", startKHz: 472, endKHz: 479 },
  { name: "160m", startKHz: 1800, endKHz: 2000 },
  { name: "80m", startKHz: 3500, endKHz: 4000 },
  { name: "60m", startKHz: 5351.5, endKHz: 5366.5 },
  { name: "40m", startKHz: 7000, endKHz: 7300 },
  { name: "30m", startKHz: 10100, endKHz: 10150 },
  { name: "20m", startKHz: 14000, endKHz: 14350 },
  { name: "17m", startKHz: 18068, endKHz: 18168 },
  { name: "15m", startKHz: 21000, endKHz: 21450 },
  { name: "12m", startKHz: 24890, endKHz: 24990 },
  { name: "10m", startKHz: 28000, endKHz: 29700 },
];

export const BROADCAST_BANDS: FrequencyBand[] = [
  { name: "LW", startKHz: 148.5, endKHz: 283.5 },
  { name: "MW", startKHz: 526.5, endKHz: 1606.5 },
  { name: "120m", startKHz: 2300, endKHz: 2495 },
  { name: "90m", startKHz: 3200, endKHz: 3400 },
  { name: "75m", startKHz: 3900, endKHz: 4000 },
  { name: "60m", startKHz: 4750, endKHz: 5060 },
  { name: "49m", startKHz: 5900, endKHz: 6200 },
  { name: "41m", startKHz: 7200, endKHz: 7450 },
  { name: "31m", startKHz: 9400, endKHz: 9900 },
  { name: "25m", startKHz: 11600, endKHz: 12100 },
  { name: "22m", startKHz: 13570, endKHz: 13870 },
  { name: "19m", startKHz: 15100, endKHz: 15830 },
  { name: "16m", startKHz: 17480, endKHz: 17900 },
  { name: "15m", startKHz: 18900, endKHz: 19020 },
  { name: "13m", startKHz: 21450, endKHz: 21850 },
  { name: "11m", startKHz: 25670, endKHz: 26100 },
];
