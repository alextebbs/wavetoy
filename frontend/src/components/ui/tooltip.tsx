import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

interface TooltipProps {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  rich?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Tooltip({
  content,
  side = "bottom",
  align = "center",
  delayDuration = 400,
  rich = false,
  className,
  children,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              "z-[100] rounded bg-popover shadow-md border border-border text-popover-foreground",
              rich
                ? "max-w-sm px-3 py-2.5 text-[11px] leading-relaxed normal-case tracking-normal"
                : "max-w-xs px-2 py-1 text-[11px] uppercase tracking-widest",
              className,
              "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
              "data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2",
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
