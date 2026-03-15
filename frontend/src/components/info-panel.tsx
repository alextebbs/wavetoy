import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

export interface InfoPanelTab {
  id: string;
  icon: ReactNode;
  label: string;
  content: ReactNode;
  active?: boolean;
}

interface InfoPanelHolderProps {
  tabs: InfoPanelTab[];
  defaultTab?: string;
  actions?: ReactNode;
  className?: string;
}

export function InfoPanelHolder({
  tabs,
  defaultTab,
  actions,
  className,
}: InfoPanelHolderProps) {
  const [activeId, setActiveId] = useState(defaultTab ?? tabs[0]?.id ?? "");
  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-[54px] shrink-0 items-center gap-1 border-b px-3">
        {tabs.map((tab) => (
          <Tooltip key={tab.id} content={tab.label}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setActiveId(tab.id)}
              className={cn(
                tab.id === activeId
                  ? "text-foreground"
                  : "text-muted-foreground/60",
                tab.active && "ring-1 ring-primary/50",
              )}
            >
              {tab.icon}
            </Button>
          </Tooltip>
        ))}
        {actions && (
          <div className="ml-auto flex items-center gap-1">
            {actions}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab?.content}
      </div>
    </div>
  );
}
