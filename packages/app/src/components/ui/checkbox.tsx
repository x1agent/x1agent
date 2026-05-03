import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * Square checkbox matching the dark-theme tokens used by the rest of
 * the primitives. Supports an indeterminate state (`checked="indeterminate"`)
 * for "some-but-not-all selected" headers in tables.
 */
export const Checkbox = forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-zinc-700 bg-zinc-950 ring-offset-zinc-950 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-zinc-300 data-[state=checked]:bg-zinc-100 data-[state=checked]:text-zinc-950 data-[state=indeterminate]:border-zinc-300 data-[state=indeterminate]:bg-zinc-100 data-[state=indeterminate]:text-zinc-950",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("flex items-center justify-center text-current")}
    >
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" />
      ) : (
        <Check className="h-3 w-3" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
