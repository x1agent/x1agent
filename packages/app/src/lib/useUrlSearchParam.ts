import { useCallback, useEffect, useState } from "react";

/**
 * Tiny hook that binds a React state value to a single URL search
 * parameter. Reads the current value on mount; writes with
 * `history.replaceState` so browser Back/Forward still works but
 * changes don't create history entries mid-flow. When `value` equals
 * the fallback the param is removed so the URL stays clean.
 *
 * Listens for `popstate` so browser Back updates the component state
 * without a full reload.
 */
export function useUrlSearchParam(
  key: string,
  fallback: string,
): [string, (next: string) => void] {
  const read = () => {
    if (typeof window === "undefined") return fallback;
    return new URLSearchParams(window.location.search).get(key) ?? fallback;
  };

  const [value, setValue] = useState<string>(read);

  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (next: string) => {
      setValue(next);
      const url = new URL(window.location.href);
      if (!next || next === fallback) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, next);
      }
      window.history.replaceState({}, "", url.toString());
    },
    [key, fallback],
  );

  return [value, update];
}
