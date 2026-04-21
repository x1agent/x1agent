import { log, spinner } from "@clack/prompts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Hard gates that must be satisfied before the wizard touches the
 * cluster. Each check is purely read-only — nothing is modified here.
 * A single failing check short-circuits the whole flow with a
 * remediation hint.
 */
export async function runPreflight(): Promise<boolean> {
  const s = spinner();
  s.start("Checking OrbStack + kubectl…");

  const kubeconfig = `${homedir()}/.orbstack/k8s/config.yml`;
  if (!existsSync(kubeconfig)) {
    s.stop("OrbStack Kubernetes not found.");
    log.error(
      `Missing ${kubeconfig}.\n` +
        "Start OrbStack and enable Kubernetes:\n" +
        "  orbctl start k8s",
    );
    return false;
  }

  const ctxProc = Bun.spawn(["kubectl", "config", "current-context"], {
    env: { ...process.env, KUBECONFIG: kubeconfig },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ctxOutput = (await new Response(ctxProc.stdout).text()).trim();
  await ctxProc.exited;

  if (ctxProc.exitCode !== 0 || !ctxOutput) {
    s.stop("kubectl can't reach OrbStack.");
    log.error(
      "Could not read the current kube context.\n" +
        "Try: orbctl stop k8s && orbctl start k8s",
    );
    return false;
  }
  if (ctxOutput !== "orbstack") {
    s.stop(`Current kube context is "${ctxOutput}", not "orbstack".`);
    log.error(
      "This wizard refuses to run against anything but the orbstack\n" +
        "context. Switch with: kubectl config use-context orbstack",
    );
    return false;
  }

  const clusterProc = Bun.spawn(["kubectl", "cluster-info"], {
    env: { ...process.env, KUBECONFIG: kubeconfig },
    stdout: "pipe",
    stderr: "pipe",
  });
  await clusterProc.exited;
  if (clusterProc.exitCode !== 0) {
    s.stop("OrbStack K8s control plane unreachable.");
    log.error(
      "`kubectl cluster-info` failed. Try:\n" +
        "  orbctl stop k8s && orbctl start k8s",
    );
    return false;
  }

  s.stop("OrbStack Kubernetes ready.");
  return true;
}
