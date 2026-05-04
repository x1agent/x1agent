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
      "peer h-4 w-4 shrink-0 rounded-sm border border-border-strong bg-bg ring-offset-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-muted disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-border-strong data-[state=checked]:bg-fg data-[state=checked]:text-canvas data-[state=indeterminate]:border-border-strong data-[state=indeterminate]:bg-fg data-[state=indeterminate]:text-canvas",
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
