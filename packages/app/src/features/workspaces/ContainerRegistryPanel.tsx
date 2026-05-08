import { useEffect, useMemo, useState } from "react";
import {
  hasTransientBuilds,
  useImagesStore,
  type AgentImage,
  type BuildStatus,
} from "../../stores/imagesStore";
import { useUrlSearchParam } from "../../lib/useUrlSearchParam";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useConfirm } from "../../components/use-confirm";

interface Props {
  slug: string;
}

type EditorMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; image: AgentImage };

const POLL_INTERVAL_MS = 2_000;

const STARTER_DOCKERFILE = `# Workspace image. FROM a platform preset (or any public image) and
# layer your toolchain on top. COPY from a local context is not
# supported — use COPY --from=<image> if you need files from another
# image. RUN curl/wget for downloads.

FROM x1agent/preset-python:v1
RUN pip install --no-cache-dir django==5
`;

export function ContainerRegistryPanel({ slug }: Props) {
  // Per-slot selectors. `?? []` is OUTSIDE the selector so the inner
  // value stays referentially stable when the slug isn't cached yet —
  // returning a fresh `[]` from the selector each render trips React
  // error #185 (Maximum update depth exceeded).
  const imagesRaw = useImagesStore((s) => s.bySlug[slug]);
  const images = useMemo(() => imagesRaw ?? [], [imagesRaw]);
  const loadingSlug = useImagesStore((s) => s.loadingSlug);
  const error = useImagesStore((s) => s.errorBySlug[slug] ?? null);
  const load = useImagesStore((s) => s.load);
  const loading = loadingSlug === slug && images.length === 0;

  const [selectedId, setSelectedId] = useUrlSearchParam("image", "");
  const [editor, setEditor] = useState<EditorMode>({ kind: "closed" });

  useEffect(() => {
    load(slug);
  }, [slug, load]);

  // Poll while any row is pending or building. Stops automatically once
  // every workspace row reaches a terminal state.
  useEffect(() => {
    if (!hasTransientBuilds(images)) return;
    const t = setInterval(() => {
      void load(slug);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [slug, images, load]);

  const selected = useMemo(
    () => (selectedId ? images.find((i) => i.id === selectedId) ?? null : null),
    [selectedId, images],
  );

  if (selected) {
    return (
      <ImageDetail
        image={selected}
        slug={slug}
        onBack={() => setSelectedId("")}
        onEdit={() => setEditor({ kind: "edit", image: selected })}
      />
    );
  }

  if (editor.kind !== "closed") {
    return (
      <ImageEditor
        slug={slug}
        mode={editor}
        onClose={() => setEditor({ kind: "closed" })}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Container registry</CardTitle>
            <CardDescription>
              Images an agent in this workspace can run in. Platform
              presets are available to every workspace; workspace-
              authored images live alongside them and only this
              workspace can pick them.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => setEditor({ kind: "create" })}
          >
            Add image
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <div className="text-sm text-fg-muted">Loading…</div>}
        {error && <div className="text-sm text-red-400">{error}</div>}

        {images.length > 0 && (
          <ImageTable
            images={images}
            onRowClick={(id) => setSelectedId(id)}
          />
        )}

        {!loading && !error && images.length === 0 && (
          <div className="rounded-md border border-border-soft p-6 text-center text-sm text-fg-faint">
            No images available. The seed should populate platform
            presets on api boot; if you're seeing this, check the api
            logs for a <code>[seed] platform presets ready</code> line.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImageTable({
  images,
  onRowClick,
}: {
  images: AgentImage[];
  onRowClick: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border-soft">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Kind</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {images.map((img) => (
            <TableRow
              key={img.id}
              onClick={() => onRowClick(img.id)}
              className="cursor-pointer transition-colors hover:bg-bg"
            >
              <TableCell className="text-fg font-medium">
                {img.display_name}
                <div className="font-mono text-xs text-fg-faint">
                  {img.name}
                </div>
              </TableCell>
              <TableCell className="text-fg-muted text-xs max-w-md">
                {img.description ?? "—"}
              </TableCell>
              <TableCell>
                <BuildStatusBadge status={img.build_status} />
              </TableCell>
              <TableCell>
                <Badge variant={img.is_preset ? "info" : "secondary"}>
                  {img.is_preset ? "preset" : "custom"}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BuildStatusBadge({ status }: { status: BuildStatus }) {
  switch (status) {
    case "ready":
    case "succeeded":
      return <Badge variant="success">ready</Badge>;
    case "pending":
      return <Badge variant="info">pending</Badge>;
    case "building":
      return <Badge variant="info">building</Badge>;
    case "failed":
      return <Badge variant="warning">failed</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function ImageDetail({
  image,
  slug,
  onBack,
  onEdit,
}: {
  image: AgentImage;
  slug: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const rebuild = useImagesStore((s) => s.rebuild);
  const remove = useImagesStore((s) => s.remove);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function onRebuild() {
    setActionError(null);
    setBusy(true);
    try {
      await rebuild(slug, image.id);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    const ok = await confirm({
      title: `Delete ${image.display_name}?`,
      description:
        "Workspace images are removed from this catalog and the registry. Agents that reference this image will need a new image picked first; deletion is refused while any agent still uses it.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setActionError(null);
    setBusy(true);
    try {
      await remove(slug, image.id);
      onBack();
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card>
      {dialog}
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle>{image.display_name}</CardTitle>
              <Badge variant={image.is_preset ? "info" : "secondary"}>
                {image.is_preset ? "preset" : "workspace"}
              </Badge>
              <BuildStatusBadge status={image.build_status} />
            </div>
            <div className="mt-1 font-mono text-xs text-fg-faint">
              {image.name}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!image.is_preset && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onEdit}
                  disabled={busy}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRebuild}
                  disabled={
                    busy ||
                    image.build_status === "pending" ||
                    image.build_status === "building"
                  }
                >
                  Rebuild
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  disabled={busy}
                  className="text-red-400 hover:text-red-300"
                >
                  Delete
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="text-xs text-fg-muted"
            >
              ← Back
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {actionError && (
          <div className="rounded-md border border-red-700/50 bg-red-950/30 p-3 text-xs text-red-300">
            {actionError}
          </div>
        )}

        {image.description && (
          <section>
            <SectionLabel>Description</SectionLabel>
            <p className="text-fg-muted">{image.description}</p>
          </section>
        )}

        <section>
          <SectionLabel>Dockerfile</SectionLabel>
          {image.dockerfile_source ? (
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-fg whitespace-pre-wrap break-all border border-border-soft">
              {image.dockerfile_source}
            </pre>
          ) : (
            <div className="rounded-md border border-border-soft p-3 text-xs text-fg-faint">
              Dockerfile source isn't stored on this row. For seeded
              presets this should populate automatically on the next
              api restart; check the <code>[seed] platform presets ready</code> log line.
            </div>
          )}
          {image.is_preset && (
            <p className="mt-1 text-xs text-fg-faint">
              Presets are code-maintained in{" "}
              <code>deploy/images/{image.name.replace(/^preset-/, "")}/Dockerfile</code>
              . Workspace admins clone presets into a workspace image to
              customize.
            </p>
          )}
        </section>

        <section>
          <SectionLabel>Registry reference</SectionLabel>
          <div className="rounded-md bg-bg px-3 py-2 font-mono text-xs text-fg break-all">
            {image.built_ref || "— pending first build —"}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4">
          <Field
            label="Scope"
            value={
              image.is_preset
                ? "Platform preset (every workspace)"
                : "Workspace-scoped"
            }
          />
          <Field
            label="Build status"
            value={<BuildStatusBadge status={image.build_status} />}
          />
          <Field
            label="Created"
            value={new Date(image.created_at).toLocaleString()}
          />
          <Field
            label="Last built"
            value={
              image.last_built_at
                ? new Date(image.last_built_at).toLocaleString()
                : "—"
            }
          />
        </section>

        {image.build_status === "failed" && image.build_log && (
          <section>
            <SectionLabel>Build log</SectionLabel>
            <pre className="max-h-[20rem] overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-red-300 whitespace-pre-wrap border border-border-soft">
              {image.build_log}
            </pre>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function ImageEditor({
  slug,
  mode,
  onClose,
}: {
  slug: string;
  mode: { kind: "create" } | { kind: "edit"; image: AgentImage };
  onClose: () => void;
}) {
  const create = useImagesStore((s) => s.create);
  const update = useImagesStore((s) => s.update);
  const isEdit = mode.kind === "edit";
  const initial = isEdit ? mode.image : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [dockerfile, setDockerfile] = useState(
    initial?.dockerfile_source || STARTER_DOCKERFILE,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isEdit) {
        await update(slug, mode.image.id, {
          display_name: displayName,
          description: description.trim().length > 0 ? description : null,
          dockerfile_source: dockerfile,
        });
      } else {
        await create(slug, {
          name,
          display_name: displayName,
          description: description.trim().length > 0 ? description : null,
          dockerfile_source: dockerfile,
        });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>{isEdit ? "Edit image" : "Add image"}</CardTitle>
            <CardDescription>
              The Dockerfile is built by the platform's Kaniko pipeline
              and pushed to the in-cluster registry. Local{" "}
              <code>COPY</code> is not supported — use{" "}
              <code>COPY --from=&lt;image&gt;</code> or fetch with{" "}
              <code>RUN curl/wget</code>.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-xs text-fg-muted"
          >
            ← Back
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="image-name">Name</Label>
              <Input
                id="image-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="django"
                disabled={isEdit}
                required
                pattern="[a-z]([a-z0-9]|-(?!-)){0,61}[a-z0-9]|[a-z]"
              />
              <p className="mt-1 text-xs text-fg-faint">
                Lowercase letters, digits, hyphens. Must start with a
                letter. Used in the registry path:{" "}
                <code>ws/&lt;workspace&gt;/{name || "<name>"}</code>.
                {isEdit && " Cannot be changed after creation."}
              </p>
            </div>
            <div>
              <Label htmlFor="image-display-name">Display name</Label>
              <Input
                id="image-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Django"
                required
              />
            </div>
          </div>

          <div>
            <Label htmlFor="image-description">Description</Label>
            <Input
              id="image-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Python 3.13 + Django 5 + uv"
            />
          </div>

          <div>
            <Label htmlFor="image-dockerfile">Dockerfile</Label>
            <Textarea
              id="image-dockerfile"
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
              rows={16}
              spellCheck={false}
              className="font-mono text-xs"
              required
            />
            <p className="mt-1 text-xs text-fg-faint">
              Allowed: <code>FROM</code>, <code>RUN</code>,{" "}
              <code>ENV</code>, <code>ARG</code>, <code>WORKDIR</code>,{" "}
              <code>COPY --from=&lt;image&gt;</code>,{" "}
              <code>ENTRYPOINT</code>, <code>CMD</code>,{" "}
              <code>USER</code>, <code>LABEL</code>, <code>EXPOSE</code>
              , <code>VOLUME</code>, <code>SHELL</code>. Local{" "}
              <code>COPY</code> and <code>ADD</code> are blocked.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-700/50 bg-red-950/30 p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting
                ? isEdit
                  ? "Saving…"
                  : "Creating…"
                : isEdit
                  ? "Save"
                  : "Create"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-fg-faint mb-1">
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="text-fg-muted">{value}</div>
    </div>
  );
}
