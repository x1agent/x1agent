import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-muted disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // Primary CTA — high-contrast neutral. Pairs with both light
        // and dark canvases without depending on accent saturation.
        default: "bg-fg text-canvas hover:opacity-90",
        accent:
          "bg-accent text-accent-fg hover:opacity-90",
        destructive: "bg-red-600 text-white hover:bg-red-500",
        outline:
          "border border-border-strong bg-transparent text-fg hover:bg-surface-muted",
        secondary:
          "bg-surface-elevated text-fg hover:bg-surface-muted",
        ghost: "bg-transparent text-fg hover:bg-surface-muted",
        link: "bg-transparent text-fg underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
