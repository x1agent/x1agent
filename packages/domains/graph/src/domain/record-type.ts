import { ValidationError } from "@x1agent/kernel";

/**
 * A record type is a logical entity category — Person, Organization,
 * Project, etc. Tables in a backing store are named after the slug.
 * Adapters get the same seed registry via DEFAULT_RECORD_TYPES so that
 * a freshly-provisioned collection looks the same regardless of
 * backend.
 */
export interface RecordField {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object" | "datetime";
  required: boolean;
}

export interface RecordRelationship {
  /** Human name: "works_on", "part_of". Drives the edge label. */
  name: string;
  /** slug of the target RecordType. */
  targetType: string;
  /** SurrealDB edge label convention — uppercase_snake. */
  edge: string;
}

export interface RecordType {
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  fields: readonly RecordField[];
  relationships: readonly RecordRelationship[];
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

export const RecordTypeSlug = (raw: string): string => {
  if (!SLUG_RE.test(raw))
    throw new ValidationError(
      "record_type_slug",
      "slug must be lowercase snake_case",
    );
  return raw;
};

/**
 * Seed registry every freshly-provisioned collection starts with. The
 * domain owns this so every adapter produces the same defaults;
 * adapters then translate it into their own DDL (SurrealDB DEFINE
 * TABLE, Neo4j CONSTRAINT, etc). Call sites should treat these as
 * suggestions — agents are expected to extend the registry at runtime
 * via write(recordType, ...) with unknown types.
 */
export const DEFAULT_RECORD_TYPES: readonly RecordType[] = [
  {
    name: "Person",
    slug: "person",
    description: "People — team members, clients, stakeholders",
    icon: null,
    fields: [
      { name: "email", type: "string", required: false },
      { name: "role", type: "string", required: false },
      { name: "company", type: "string", required: false },
    ],
    relationships: [
      { name: "works_on", targetType: "project", edge: "WORKS_ON" },
      { name: "part_of", targetType: "organization", edge: "PART_OF" },
    ],
  },
  {
    name: "Organization",
    slug: "organization",
    description: "Companies, agencies, partners",
    icon: null,
    fields: [
      { name: "domain", type: "string", required: false },
      { name: "industry", type: "string", required: false },
    ],
    relationships: [
      {
        name: "competes_with",
        targetType: "organization",
        edge: "COMPETES_WITH",
      },
    ],
  },
  {
    name: "Project",
    slug: "project",
    description: "Active projects, engagements",
    icon: null,
    fields: [
      { name: "status", type: "string", required: true },
      { name: "deadline", type: "string", required: false },
    ],
    relationships: [
      { name: "owned_by", targetType: "organization", edge: "OWNED_BY" },
    ],
  },
  {
    name: "Document",
    slug: "document",
    description: "Files, PDFs, slide decks",
    icon: null,
    fields: [
      { name: "file_type", type: "string", required: false },
      { name: "file_url", type: "string", required: false },
    ],
    relationships: [
      { name: "relates_to", targetType: "project", edge: "RELATES_TO" },
    ],
  },
  {
    name: "Meeting Note",
    slug: "meeting_note",
    description: "Call transcripts, meeting summaries",
    icon: null,
    fields: [
      { name: "summary", type: "string", required: true },
      { name: "attendees", type: "array", required: false },
      { name: "action_items", type: "array", required: false },
    ],
    relationships: [
      { name: "discussed", targetType: "project", edge: "DISCUSSED" },
      { name: "attended_by", targetType: "person", edge: "ATTENDED_BY" },
    ],
  },
  {
    name: "Decision",
    slug: "decision",
    description: "Documented decisions with context",
    icon: null,
    fields: [
      { name: "outcome", type: "string", required: true },
      { name: "rationale", type: "string", required: false },
    ],
    relationships: [
      { name: "part_of", targetType: "project", edge: "PART_OF" },
    ],
  },
  {
    name: "Action Item",
    slug: "action_item",
    description: "Tasks with owners and deadlines",
    icon: null,
    fields: [
      { name: "status", type: "string", required: true },
      { name: "owner", type: "string", required: false },
      { name: "due_date", type: "string", required: false },
    ],
    relationships: [
      { name: "assigned_to", targetType: "person", edge: "ASSIGNED_TO" },
      {
        name: "from_meeting",
        targetType: "meeting_note",
        edge: "FROM_MEETING",
      },
    ],
  },
];
