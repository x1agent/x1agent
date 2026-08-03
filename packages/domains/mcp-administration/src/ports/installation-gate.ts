/** Installation-wide emergency gate for the administrative MCP. */
export interface AdministrativeMcpInstallationGate {
  isEnabled(): Promise<boolean>;
}
