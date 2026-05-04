-- Persist the token-endpoint auth method DCR negotiated for each
-- catalog entry. Without this we have to assume client_secret_basic
-- at exchange/refresh time, which fails against servers that only
-- support client_secret_post — RFC 6749 §2.3.1 lets servers pick.
--
-- Default is 'client_secret_basic' so existing rows keep behaving as
-- they do today (the previous code path always sent Basic).

ALTER TABLE mcp_oauth_clients
  ADD COLUMN token_endpoint_auth_method TEXT NOT NULL
    DEFAULT 'client_secret_basic';
