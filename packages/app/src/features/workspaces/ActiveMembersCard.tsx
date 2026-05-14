import { useEffect, useState } from "react";
import type { Role } from "@x1agent/shared";
import {
  useWorkspaceMembersStore,
  type WorkspaceMemberDTO,
} from "../../stores/workspaceMembersStore";
import { useAuthStore } from "../../stores/authStore";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

const ROLE_VARIANT: Record<string, BadgeVariant> = {
  owner: "success",
  admin: "info",
  member: "secondary",
};

interface Props {
  slug: string;
  canManage: boolean;
}

/**
 * Roster of workspace_members rows for the active workspace, with
 * inline role editor and remove button for admins/owners.
 *
 * X1A-127 — replaces the "Coming soon" placeholder.
 */
export function ActiveMembersCard({ slug, canManage }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load, changeRole, remove } =
    useWorkspaceMembersStore();
  const myUserId = useAuthStore((s) => s.user?.id ?? null);
  const members = bySlug[slug] ?? [];
  const error = errorBySlug[slug];
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    load(slug);
  }, [slug, load]);

  const onChangeRole = async (m: WorkspaceMemberDTO, nextRole: Role) => {
    setActionError(null);
    try {
      await changeRole(slug, m.user_id, nextRole);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const onRemove = async (m: WorkspaceMemberDTO) => {
    setActionError(null);
    if (
      !window.confirm(
        `Remove ${m.email} from this workspace? They'll lose access immediately.`,
      )
    )
      return;
    try {
      await remove(slug, m.user_id);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active members</CardTitle>
        <CardDescription>
          People who have already accepted access. Pending invitations
          appear above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loadingSlug === slug && members.length === 0 && (
          <div className="text-sm text-fg-muted">Loading members…</div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        {actionError && (
          <div className="text-sm text-red-400">{actionError}</div>
        )}

        {members.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-soft">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const isSelf = m.user_id === myUserId;
                  return (
                    <TableRow key={m.user_id} className="hover:bg-transparent">
                      <TableCell className="text-fg">{m.name}</TableCell>
                      <TableCell className="text-fg-muted">{m.email}</TableCell>
                      <TableCell>
                        {canManage && !isSelf ? (
                          <Select
                            value={m.role}
                            onValueChange={(v) =>
                              onChangeRole(m, v as Role)
                            }
                          >
                            <SelectTrigger
                              className="h-7 w-28 text-xs"
                              aria-label={`Change role for ${m.email}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">member</SelectItem>
                              <SelectItem value="admin">admin</SelectItem>
                              <SelectItem value="owner">owner</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant={ROLE_VARIANT[m.role] ?? "secondary"}>
                            {m.role}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && !isSelf && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onRemove(m)}
                            className="text-xs text-fg-muted hover:text-red-400"
                          >
                            Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
