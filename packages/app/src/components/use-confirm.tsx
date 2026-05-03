import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

/**
 * Promise-based confirmation hook backed by the shadcn AlertDialog.
 * Replaces `window.confirm()` so destructive actions get a styled
 * modal that matches the rest of the app (and renders inside our
 * z-index/portal stack instead of the native browser chrome).
 *
 * Usage:
 *
 *   const { confirm, dialog } = useConfirm();
 *
 *   async function onDelete() {
 *     const ok = await confirm({
 *       title: "Delete secret?",
 *       description: "This cannot be undone.",
 *       confirmText: "Delete",
 *       variant: "destructive",
 *     });
 *     if (!ok) return;
 *     // ...
 *   }
 *
 *   return <>{dialog}<Button onClick={onDelete}>Delete</Button></>;
 */
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** Defaults to "destructive" because confirms are almost always for
   * irreversible actions. Pass "default" for non-destructive prompts. */
  variant?: "default" | "destructive";
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Hold the resolver in a ref so we never resolve twice — radix can
  // fire onOpenChange(false) for both Cancel and a successful Action,
  // and we want exactly one resolution per call.
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = (ok: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    if (r) r(ok);
  };

  const dialog = pending ? (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Esc / outside-click counts as cancel.
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending.title}</AlertDialogTitle>
          {pending.description && (
            <AlertDialogDescription>
              {pending.description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {pending.cancelText ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={pending.variant ?? "destructive"}
            onClick={() => settle(true)}
          >
            {pending.confirmText ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  return { confirm, dialog };
}
