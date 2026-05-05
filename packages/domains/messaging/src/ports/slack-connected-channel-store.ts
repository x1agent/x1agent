import type { SlackInstallId } from "../domain/slack-install.js";

export interface SlackConnectedChannel {
  id: string;
  installId: SlackInstallId;
  channelId: string;
  channelName: string | null;
  ambient: boolean;
  registeredAt: Date;
  removedAt: Date | null;
}

/**
 * Channel registry. Channels are auto-registered the first time the
 * bot receives an event from them — there is no picker. The store
 * exposes idempotent register / mark-removed operations and a list
 * for the settings UI.
 */
export interface SlackConnectedChannelStore {
  register(input: {
    installId: SlackInstallId;
    channelId: string;
    channelName?: string | null;
  }): Promise<SlackConnectedChannel>;

  markRemoved(installId: SlackInstallId, channelId: string): Promise<void>;

  listByInstall(
    installId: SlackInstallId,
  ): Promise<readonly SlackConnectedChannel[]>;
}
