import { AppShell } from "../../shell/AppShell";
import { SignInButton } from "./SignInButton";

export function LandingRoot() {
  return (
    <AppShell chrome={false}>
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              x1agent
            </h1>
            <p className="mt-2 text-sm text-fg-muted">
              Open-source, Kubernetes-native agent platform.
            </p>
          </div>
          <SignInButton />
        </div>
      </div>
    </AppShell>
  );
}
