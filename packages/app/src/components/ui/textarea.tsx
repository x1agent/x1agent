import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-md border border-border-strong bg-bg-elevated px-3 py-2 text-sm text-fg shadow-sm placeholder:text-fg-faint focus-visible:border-fg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";
