import type { ProbeResult } from "@/lib/api";
import type { ReactNode } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "./ui/button";

type ProbeStatus = "idle" | "probing" | "done";

interface ProbeStatusBoxProps {
  status: ProbeStatus;
  result: ProbeResult | null;
  actionLabel: ReactNode;
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
          {!passed && (
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {!result.connected
                  ? "Source didn't establish connection with us"
                  : !result.snd_ok
                    ? "Source never sent us sound"
                    : "Source never sent us waterfall data"}
              </p>
              <span className="text-destructive">:(</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
              <span>
                <span className="text-muted-foreground/50">INIT</span>{" "}
                <span className={result.connected ? "text-primary" : "text-destructive"}>
                  {result.connected ? "PASS" : "FAIL"}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground/50">SND</span>{" "}
                <span className={result.snd_ok ? "text-primary" : "text-destructive"}>
                  {result.snd_ok ? "PASS" : "FAIL"}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground/50">WF</span>{" "}
                <span className={result.wf_ok ? "text-primary" : "text-destructive"}>
                  {result.wf_ok ? "PASS" : "FAIL"}
                </span>
              </span>
            </div>
            <Button
              variant={passed ? "default" : "destructive"}
              size="sm"
              className="gap-1 text-xs"
              disabled={disabled}
              onClick={onAction}
            >
              {passed ? actionLabel : <>{actionLabel} anyway</>}
            </Button>
          </div>
        </>
      )}

      {status === "idle" && (
        <div className="flex justify-end">
          <Button
            size="sm"
            className="gap-1 text-xs"
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
