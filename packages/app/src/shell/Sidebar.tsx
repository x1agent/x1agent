import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/utils";

interface SidebarCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  isMobile: boolean;
}

const SidebarContext = createContext<SidebarCtx | null>(null);

/**
 * Minimal two-column shell. On desktop (>= md) the sidebar is pinned
 * at a fixed width. On mobile it collapses to an off-canvas drawer
 * toggled by the SidebarTrigger button. Not a port of shadcn's
 * sidebar primitive — a small, opinionated replacement for x1agent.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = "matches" in e ? e.matches : (e as MediaQueryListEvent).matches;
      setIsMobile(mobile);
      setOpen(!mobile);
    };
    onChange(mq);
    mq.addEventListener("change", onChange as (e: MediaQueryListEvent) => void);
    return () =>
      mq.removeEventListener(
        "change",
        onChange as (e: MediaQueryListEvent) => void,
      );
  }, []);

  return (
    <SidebarContext.Provider value={{ open, setOpen, isMobile }}>
      <div className="flex min-h-svh w-full bg-zinc-950 text-zinc-100">
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarCtx {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside SidebarProvider");
  return ctx;
}

export function Sidebar({ children }: { children: ReactNode }) {
  const { open, setOpen, isMobile } = useSidebar();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Escape closes the drawer on mobile.
  useEffect(() => {
    if (!isMobile || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, open, setOpen]);

  if (isMobile) {
    return (
      <>
        {open && (
          <div
            ref={overlayRef}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-black/50"
            aria-hidden
          />
        )}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-zinc-900 bg-zinc-950 transition-transform",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {children}
        </aside>
      </>
    );
  }

  return (
    <aside className="sticky top-0 flex h-svh w-60 shrink-0 flex-col border-r border-zinc-900 bg-zinc-950">
      {children}
    </aside>
  );
}

export function SidebarHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("p-3", className)}>{children}</div>;
}

export function SidebarBody({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto p-2">{children}</div>;
}

export function SidebarFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("border-t border-zinc-900 p-2", className)}>{children}</div>;
}

export function SidebarContent({ children }: { children: ReactNode }) {
  const { open, setOpen, isMobile } = useSidebar();
  // On mobile, the content area isn't shifted — the drawer is an overlay.
  useCallback(() => setOpen(!open), [open, setOpen]);
  return (
    <div className={cn("flex flex-1 flex-col min-w-0", isMobile && "w-full")}>
      {children}
    </div>
  );
}

export function SidebarTrigger() {
  const { open, setOpen, isMobile } = useSidebar();
  if (!isMobile) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
      aria-label="Toggle navigation"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
      >
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}
