// shadcn/ui — ToggleGroup (Radix). Used for the view-mode switcher
// (List / Timeline / Heatmap) and any future small enum picker.

import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleGroupVariants = cva(
  "inline-flex items-center gap-px bg-secondary/60 p-px",
  {
    variants: {
      size: {
        sm: "",
        default: "",
      },
    },
    defaultVariants: { size: "default" },
  },
)

const toggleGroupItemVariants = cva(
  "px-2.5 py-1 text-[11px] font-mono tracking-wide cursor-pointer transition-colors bg-card/60 text-muted-foreground hover:text-foreground data-[state=on]:bg-primary/15 data-[state=on]:text-primary disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  {
    variants: {
      size: {
        sm: "px-2 py-0.5 text-[10px]",
        default: "",
      },
    },
    defaultVariants: { size: "default" },
  },
)

const ToggleGroupContext = React.createContext<{
  size?: VariantProps<typeof toggleGroupItemVariants>["size"]
}>({})

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
    VariantProps<typeof toggleGroupVariants>
>(({ className, size, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(toggleGroupVariants({ size }), className)}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ size }}>
      {children}
    </ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
))
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
    VariantProps<typeof toggleGroupItemVariants>
>(({ className, size, ...props }, ref) => {
  const ctx = React.useContext(ToggleGroupContext)
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(toggleGroupItemVariants({ size: size ?? ctx.size }), className)}
      {...props}
    />
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
