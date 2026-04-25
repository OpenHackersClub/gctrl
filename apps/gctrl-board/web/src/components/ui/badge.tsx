// shadcn/ui — Badge. Operator-tool variants beyond shadcn defaults:
// `live` (pulsing emerald dot) and `neutral` for muted labels.

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "text-foreground",
        muted: "text-muted-foreground",
        success: "text-primary",
        destructive: "text-destructive",
        warn: "text-amber-400",
        info: "text-sky-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show a leading status dot. `pulse` adds the live-indicator animation. */
  dot?: boolean
  pulse?: boolean
}

function Badge({
  className,
  variant,
  dot,
  pulse,
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            variant === "success" && "bg-primary",
            variant === "destructive" && "bg-destructive",
            variant === "warn" && "bg-amber-400",
            variant === "info" && "bg-sky-400",
            (!variant || variant === "default" || variant === "muted") &&
              "bg-muted-foreground",
            pulse && "animate-pulse",
          )}
        />
      )}
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
