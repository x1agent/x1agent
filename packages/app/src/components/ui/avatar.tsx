import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface AvatarProps {
  src?: string | null;
  fallback: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

/**
 * Minimal avatar: shows the image if loaded, falls back to the text
 * (typically initials). No Radix/base-ui dep — just native img with a
 * sibling fallback that's visible when the image is missing or broken.
 */
export function Avatar({
  src,
  fallback,
  className,
  size = "md",
}: AvatarProps) {
  const sizeClasses =
    size === "sm" ? "size-6 text-[10px]" : size === "lg" ? "size-10 text-sm" : "size-8 text-xs";
  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full bg-bg-muted font-medium text-fg-muted",
        sizeClasses,
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
      <span className="absolute inset-0 flex items-center justify-center">
        {fallback}
      </span>
    </div>
  );
}

export function initials(name: string | undefined | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function workspaceInitials(name?: string): ReactNode {
  if (!name) return "W";
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2)
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
