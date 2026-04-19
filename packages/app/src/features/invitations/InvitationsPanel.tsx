import { useEffect, useState } from "react";
import type { Role } from "@x1agent/shared";
import { useInvitationsStore } from "../../stores/invitationsStore";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
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

interface Props {
  slug: string;
  /** Only admins/owners can manage invitations. */
  canManage: boolean;
}

type InvitationState = "pending" | "accepted" | "revoked" | "expired";

const STATE_VARIANT: Record<InvitationState, BadgeVariant> = {
  pending: "info",
  accepted: "success",
  revoked: "secondary",
  expired: "warning",
};

export function InvitationsPanel({ slug, canManage }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load, create, revoke } =
    useInvitationsStore();
  const rows = bySlug[slug] ?? [];
  const error = errorBySlug[slug];

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (canManage) load(slug);
  }, [slug, canManage, load]);

  if (!canManage) return null;

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await create(slug, email.trim(), role);
      setEmail("");
      setRole("member");
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>
          Invite a Google account to this workspace. They'll sign in and
          accept before gaining access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onInvite} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="invitation-email">Email</Label>
            <Input
              id="invitation-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <Label htmlFor="invitation-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="invitation-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={submitting || !email}>
            {submitting ? "Sending…" : "Send invite"}
          </Button>
        </form>
        {submitError && (
          <div className="text-sm text-red-400">{submitError}</div>
        )}

        {loadingSlug === slug && rows.length === 0 && (
          <div className="text-sm text-zinc-400">Loading invitations…</div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}

        {rows.length === 0 && loadingSlug !== slug && (
          <div className="rounded-md border border-zinc-900 p-6 text-center text-sm text-zinc-500">
            No invitations yet.
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-hidden rounded-md border border-zinc-900">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((inv) => {
                  const state: InvitationState = inv.accepted_at
                    ? "accepted"
                    : inv.revoked_at
                      ? "revoked"
                      : new Date(inv.expires_at).getTime() < Date.now()
                        ? "expired"
                        : "pending";
                  return (
                    <TableRow key={inv.id} className="hover:bg-transparent">
                      <TableCell className="text-zinc-200">
                        {inv.email}
                      </TableCell>
                      <TableCell className="text-zinc-400">
                        {inv.role}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATE_VARIANT[state]}>{state}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {state === "pending" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => revoke(slug, inv.id)}
                            className="text-xs text-zinc-400 hover:text-red-400"
                          >
                            Revoke
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
