import { useEffect } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useGitHubStore } from "../../stores/githubStore";

/**
 * Shows on /account. Renders either (a) "not configured" — server-side
 * GitHub App env is missing, or (b) the user's installations with a
 * button to install another.
 */
export function GitHubInstallationsCard() {
  const {
    config,
    installations,
    status,
    loadConfig,
    loadInstallations,
    startInstall,
  } = useGitHubStore();

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (config?.configured) loadInstallations();
  }, [config?.configured, loadInstallations]);

  if (!config) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-zinc-400">
          Loading GitHub…
        </CardContent>
      </Card>
    );
  }

  if (!config.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            GitHub App not configured on this server. Set the
            <code className="mx-1 rounded bg-zinc-900 px-1 py-0.5 text-xs">
              GITHUB_APP_*
            </code>
            environment variables.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Connect the x1agent GitHub App to your user or an org. Agents
            link repos from the installations listed here.
          </CardDescription>
        </div>
        <Button size="sm" onClick={startInstall}>
          {installations.length === 0
            ? "Connect GitHub"
            : "Add installation"}
        </Button>
      </CardHeader>
      <CardContent>
        {status === "loading" && (
          <div className="text-sm text-zinc-400">Loading installations…</div>
        )}
        {status === "ready" && installations.length === 0 && (
          <div className="text-sm text-zinc-500">No installations yet.</div>
        )}
        {installations.length > 0 && (
          <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {installations.map((inst) => (
              <li
                key={inst.installation_id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div>
                  <div className="text-zinc-100">
                    {inst.account_login}
                    <span className="ml-2 text-xs text-zinc-500">
                      ({inst.account_type.toLowerCase()})
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    repos: {inst.repository_selection} · installation #
                    {inst.installation_id}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
