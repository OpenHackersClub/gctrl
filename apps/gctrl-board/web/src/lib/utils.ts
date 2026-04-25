// shadcn/ui canonical helper. Combines clsx (conditional class merging)
// with tailwind-merge (de-duplication of conflicting Tailwind classes,
// so `cn("p-2", isWide && "p-6")` produces `p-6` instead of `p-2 p-6`).

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
