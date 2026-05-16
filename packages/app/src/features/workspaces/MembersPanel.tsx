import { InvitationsPanel } from "../invitations/InvitationsPanel";
import { ActiveMembersCard } from "./ActiveMembersCard";
import {
  Card,
  CardContent,
} from "../../components/ui/card";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

/**
 * "People" page. Pairs the invitations card (pending users — admins
 * only) with the active-members roster (everyone who's joined —
 * visible to any member, with role/remove controls for admins).
 */
export function MembersPanel({ workspaceSlug, canManage }: Props) {
  return (
    <div className="space-y-4">
      <InvitationsPanel slug={workspaceSlug} canManage={canManage} />
      {!canManage && (
        <Card>
          <CardContent className="py-4 text-sm text-fg-faint">
            Only workspace admins and owners can manage invitations.
          </CardContent>
        </Card>
      )}
      <ActiveMembersCard slug={workspaceSlug} canManage={canManage} />
    </div>
  );
}
