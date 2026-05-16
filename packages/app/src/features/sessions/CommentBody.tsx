import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./markdown-components";

/**
 * Renders a comment's body as markdown using the same overrides the
 * session timeline uses for agent.text / shares. Agents routinely post
 * comments with code spans, lists and links; rendering them as raw
 * text (the old whitespace-pre-wrap path) turned operators' eyes off
 * a real reply into a wall of asterisks and pipes.
 *
 * No standalone wrapper element — the caller controls the surrounding
 * <div>'s layout (clamp / scroll / inline) so this component can drop
 * into both the full sidebar row and the truncated snippet preview.
 */
export function CommentBody({ body }: { body: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {body}
    </Markdown>
  );
}
