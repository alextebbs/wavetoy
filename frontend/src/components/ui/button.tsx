import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-yellow-500/40 bg-clip-padding text-xs font-medium tracking-wider uppercase whitespace-nowrap transition-all outline-none select-none focus-visible:border-yellow-500 focus-visible:ring-3 focus-visible:ring-yellow-400/40 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-yellow-400 text-yellow-950 hover:bg-yellow-300",
        outline:
          "border-yellow-500/40 bg-yellow-50 text-yellow-900 hover:bg-yellow-100 aria-expanded:bg-yellow-100 aria-expanded:text-yellow-950 dark:border-yellow-400/50 dark:bg-yellow-300/20 dark:text-yellow-100 dark:hover:bg-yellow-300/30",
        secondary:
          "bg-yellow-300 text-yellow-950 hover:bg-yellow-200 aria-expanded:bg-yellow-200 aria-expanded:text-yellow-950",
        ghost:
          "text-yellow-800 hover:bg-yellow-100 hover:text-yellow-950 aria-expanded:bg-yellow-100 aria-expanded:text-yellow-950 dark:text-yellow-100 dark:hover:bg-yellow-300/20",
        destructive: "bg-yellow-500 text-yellow-950 hover:bg-yellow-400",
        link: "text-yellow-700 underline-offset-4 hover:underline dark:text-yellow-300",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-sm px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-sm in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
