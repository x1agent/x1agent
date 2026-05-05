import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

const STORAGE_KEY = "x1agent.theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage can throw in private mode; theme still applies for the session.
  }
}

/**
 * Header-mounted toggle. The initial theme is set by the inline script
 * in Layout.astro before render — this component just reflects + flips
 * that state. Persists through localStorage; respects system pref on
 * first visit when no value is stored.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // Hydrate from the document on mount. Layout.astro already set the
  // attribute — we read it back so server-rendered HTML and client
  // state stay in sync without re-running the resolution logic.
  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-bg-muted hover:text-fg transition"
    >
      <Icon className="size-3.5" />
    </button>
  );
}
