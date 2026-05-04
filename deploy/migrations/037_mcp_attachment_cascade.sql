-- The original FK on agent_mcp_attachments.catalog_entry_id was
-- ON DELETE RESTRICT, intended to stop operators from accidentally
-- yanking an MCP out from under running agents. In practice it
-- produces an opaque 500 ("violates foreign key constraint") with no
-- recovery path: the operator has to hunt down every attachment in
-- every agent's MCP tab before they can delete the catalog entry.
--
-- Cascading is the right shape — an attachment row is meaningless
-- without its catalog entry, and the agent's claude.json is
-- regenerated at session-launch from current attachments anyway, so
-- removing the row simply means the agent stops trying to use that
-- MCP next session. The UI confirms the destructive action before
-- calling DELETE; the database doesn't need a second safety net.

ALTER TABLE agent_mcp_attachments
  DROP CONSTRAINT agent_mcp_attachments_catalog_entry_id_fkey;

ALTER TABLE agent_mcp_attachments
  ADD CONSTRAINT agent_mcp_attachments_catalog_entry_id_fkey
  FOREIGN KEY (catalog_entry_id)
  REFERENCES mcp_catalog_entries(id)
  ON DELETE CASCADE;
