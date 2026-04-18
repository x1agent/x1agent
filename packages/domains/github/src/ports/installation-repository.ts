import type { UserId } from "@x1agent/kernel";
import type { Installation, InstallationId } from "../domain/installation.js";

export interface InstallationRepository {
  findByInstallationId(id: InstallationId): Promise<Installation | null>;

  /** Active (non-revoked) installations for a user. */
  listByUser(userId: UserId): Promise<readonly Installation[]>;

  upsert(input: {
    installationId: InstallationId;
    accountLogin: string;
    accountType: "User" | "Organization";
    installedByUserId: UserId;
    repositorySelection: "all" | "selected";
  }): Promise<Installation>;

  /** Mark an installation as revoked. Called on uninstall webhook. */
  markRevoked(id: InstallationId, at: Date): Promise<void>;
}
