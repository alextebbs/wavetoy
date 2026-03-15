import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

type SourceOverlayProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  globe: ReactNode;
  sidebar: ReactNode;
  showSidebar?: boolean;
  leftPanel?: ReactNode;
  showLeftPanel?: boolean;
};

export function SourceOverlay({
  open,
  onClose,
  title = "Change Source",
  globe,
  sidebar,
  showSidebar = true,
  leftPanel,
  showLeftPanel = true,
}: SourceOverlayProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => !next && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-[fade-in_220ms_ease-out] data-[state=closed]:animate-[fade-out_180ms_ease-in]" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 outline-none"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Select a source on the globe
          </DialogPrimitive.Description>

          {/* Globe canvas — full screen behind everything */}
          <div className="source-overlay-globe absolute inset-0">
            {globe}
          </div>

          {/* Left panel — entrance animation on wrapper, dynamic show/hide on inner */}
          {leftPanel && (
            <div className="source-overlay-left absolute left-0 top-0 h-full w-[340px] p-4">
              <div
                className={cn(
                  "h-full transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  showLeftPanel ? "translate-x-0" : "-translate-x-full",
                )}
              >
                <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/80 bg-background">
                  {leftPanel}
                </div>
              </div>
            </div>
          )}

          {/* Sidebar — entrance animation on wrapper, dynamic show/hide on inner */}
          <div className="source-overlay-sidebar absolute right-0 top-0 h-full w-[380px] p-4">
            <div
              className={cn(
                "h-full transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                showSidebar ? "translate-x-0" : "translate-x-full",
              )}
            >
              <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/80 bg-background">
                {sidebar}
              </div>
            </div>
          </div>

          {/* Close button — bottom center, on top of canvas */}
          <div
            className={cn(
              "source-overlay-globe pointer-events-none absolute bottom-0 flex justify-center pb-6 transition-[left,right] duration-300",
              leftPanel && showLeftPanel ? "left-[340px]" : "left-0",
              showSidebar ? "right-[380px]" : "right-0",
            )}
          >
            <Button variant="outline" onClick={onClose} className="pointer-events-auto">
              <X /> Cancel
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const BottomDrawer = SourceOverlay;
