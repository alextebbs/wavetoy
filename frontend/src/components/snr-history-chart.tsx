import { type SNRHistoryResponse, getSourceSNRHistory } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Range = "24h" | "7d" | "30d";

const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

type ChartPoint = {
  ts: number;
  snr: number;
};

function formatTime(ts: number, range: Range): string {
  const d = new Date(ts);
  if (range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

type SNRHistoryChartProps = {
  sourceId: string;
};

export function SNRHistoryChart({ sourceId }: SNRHistoryChartProps) {
  const [range, setRange] = useState<Range>("7d");
  const [data, setData] = useState<SNRHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const prevSourceRef = useRef<string>("");

  const load = useCallback(
    async (r: Range, sid: string) => {
      setLoading(true);
      try {
        const now = new Date();
        const from = new Date(now.getTime() - RANGE_MS[r]);
        const resp = await getSourceSNRHistory(
          sid,
          from.toISOString(),
          now.toISOString(),
        );
        setData(resp);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!sourceId) return;
    if (prevSourceRef.current !== sourceId) {
      prevSourceRef.current = sourceId;
      setData(null);
    }
    load(range, sourceId);
  }, [sourceId, range, load]);

  const points: ChartPoint[] =
    data?.readings.map((r) => ({
      ts: new Date(r.t).getTime(),
      snr: Math.round(r.snr * 10) / 10,
    })) ?? [];

  const hasData = points.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          SNR History
        </span>
        <div className="flex gap-1">
          {(["24h", "7d", "30d"] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded transition-colors ${
                range === r
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[120px] w-full">
        {loading && !hasData ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No SNR data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={points}
              margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
            >
              <defs>
                <linearGradient id="snrGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => formatTime(v, range)}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                tickLine={false}
                axisLine={false}
                width={40}
                tickFormatter={(v) => `${v}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "hsl(var(--foreground))",
                }}
                labelFormatter={(v) => {
                  const d = new Date(v as number);
                  return d.toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                }}
                formatter={(value) => [`${value} dB`, "SNR"]}
              />
              <Area
                type="monotone"
                dataKey="snr"
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                fill="url(#snrGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

    </div>
  );
}
