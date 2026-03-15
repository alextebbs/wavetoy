import type { ProbeResult } from "@/lib/api";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "./ui/button";

type ProbeStatus = "idle" | "probing" | "done";

interface ProbeStatusBoxProps {
  status: ProbeStatus;
  result: ProbeResult | null;
  actionLabel: string;
  disabled?: boolean;
  onAction: () => void;
  onSkip?: () => void;
}

export function ProbeStatusBox({
  status,
  result,
  actionLabel,
  disabled = false,
  onAction,
  onSkip,
}: ProbeStatusBoxProps) {
  const passed = result
    ? result.connected && result.snd_ok && result.wf_ok
    : false;

  return (
    <div className="text-xs">
      {status === "probing" && (
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 uppercase tracking-widest text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            probing connection
          </p>
          {onSkip && (
            <Button variant="ghost" size="sm" className="text-xs" onClick={onSkip}>
              Skip
            </Button>
          )}
        </div>
      )}

      {status === "done" && result && (
        <>
          <div className="space-y-1 text-muted-foreground">
            <p>
              Connect:{" "}
              <span className={result.connected ? "text-primary" : "text-destructive"}>
                {result.connected ? "OK" : "Failed"}
              </span>
            </p>
            <p>
              Audio (SND):{" "}
              <span className={result.snd_ok ? "text-primary" : "text-destructive"}>
                {result.snd_ok ? "OK" : "Failed"}
              </span>
            </p>
            <p>
              Waterfall (WF):{" "}
              <span className={result.wf_ok ? "text-primary" : "text-destructive"}>
                {result.wf_ok ? "OK" : "Failed"}
              </span>
            </p>
            {result.error && (
              <p className="mt-1 text-destructive/80">{result.error}</p>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant={passed ? "default" : "destructive"}
              size="sm"
              className="text-xs"
              disabled={disabled}
              onClick={onAction}
            >
              {passed ? actionLabel : `${actionLabel} anyway`}
            </Button>
          </div>
        </>
      )}

      {status === "idle" && (
        <div className="flex justify-end">
          <Button
            size="sm"
            className="text-xs"
            disabled={disabled}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
