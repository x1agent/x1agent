import { InvitationsPanel } from "../invitations/InvitationsPanel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

/**
 * "People" page. Today this is just the existing InvitationsPanel —
 * a future PR adds the current member roster + role management
 * above the invitations card. Keeping the rename + new route now
 * (rather than waiting for the full member-roster work) lets the
 * IA reshuffle ship without holding it on a sub-feature.
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
      <Card>
        <CardHeader>
          <CardTitle>Active members</CardTitle>
          <CardDescription>Coming soon.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-fg-faint">
          The current member roster + per-member role editor lands in a
          follow-up. For now use Invitations above to add or revoke
          access; existing members manage their own role via the
          workspace switcher.
        </CardContent>
      </Card>
    </div>
  );
}
