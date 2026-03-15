import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

type BottomDrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  hideHeader?: boolean;
};

export function BottomDrawer({
  open,
  onClose,
  title = "Drawer",
  description,
  children,
  className,
  hideHeader = false,
}: BottomDrawerProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => !next && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-[drawer-overlay-in_220ms_ease-out] data-[state=closed]:animate-[drawer-overlay-out_180ms_ease-in]" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 h-[calc(100vh-54px)] overflow-hidden border-t border-border/80 bg-background outline-none data-[state=open]:animate-[drawer-slide-in_260ms_cubic-bezier(0.16,1,0.3,1)] data-[state=closed]:animate-[drawer-slide-out_200ms_cubic-bezier(0.4,0,1,1)]",
            className,
          )}
        >
          <div className="h-full">
            {hideHeader ? (
              <DialogPrimitive.Title className="sr-only">
                {title}
              </DialogPrimitive.Title>
            ) : (
              <div className="space-y-4 px-4 pb-4 pt-4 md:px-6">
                <div className="space-y-1">
                  <DialogPrimitive.Title className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    {title}
                  </DialogPrimitive.Title>
                  {description ? (
                    <DialogPrimitive.Description className="text-sm text-muted-foreground">
                      {description}
                    </DialogPrimitive.Description>
                  ) : null}
                </div>
              </div>
            )}
            <div className={cn(hideHeader ? "h-full" : "h-[calc(100%-84px)]")}>
              {children}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
