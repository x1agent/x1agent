import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "danger"
  | "info";

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  default: "border-transparent bg-zinc-200 text-zinc-900",
  secondary: "border-transparent bg-zinc-800 text-zinc-200",
  outline: "border-zinc-800 text-zinc-300",
  success: "border-transparent bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30",
  warning: "border-transparent bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30",
  danger: "border-transparent bg-red-500/15 text-red-400 ring-1 ring-inset ring-red-500/30",
  info: "border-transparent bg-blue-500/15 text-blue-400 ring-1 ring-inset ring-blue-500/30",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium leading-none",
        VARIANT_STYLES[variant],
        className,
      )}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
