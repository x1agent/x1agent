---
title: Google Workspace provider
description: Optional provider that gives agents read access to the user's Google Drive, Sheets, Docs, Calendar, and Gmail. Standalone Kubernetes Deployment per the documented provider model.
sidebar:
  order: 4
---

The `google-workspace` provider implements the `files`, `documents`, `calendar`, and `email` domains against Google's APIs. Operators who want their agents to read or write into Google Workspace install it; operators who don't, skip it. A future `microsoft-365` provider fills the same domains against Microsoft Graph; mixed shops can pick different providers per domain.

This page is the per-install setup walkthrough. You run it once when you decide to enable Google Workspace for your install. Everything below happens in your own Google Cloud project — x1agent has nothing centralized you depend on.

## Quick path (if you know your way around GCP)

Replace `MY-PROJECT` with your GCP project id, run the gcloud command, paste the scope superset into your install file, finish in the Console.

```bash
# 1. Enable the five Workspace APIs in one shot.
gcloud services enable \
  drive.googleapis.com sheets.googleapis.com docs.googleapis.com \
  calendar-json.googleapis.com gmail.googleapis.com \
  --project=MY-PROJECT

# 2. (Console) OAuth consent screen → add the same five scopes:
#    https://console.cloud.google.com/auth/scopes?project=MY-PROJECT
#    Edit App → Scopes → Add or Remove Scopes

# 3. (Console) Create OAuth Client ID with this redirect URI:
#    https://api.<your-base-domain>/auth/google/callback
#    https://console.cloud.google.com/apis/credentials?project=MY-PROJECT
#    + Create Credentials → OAuth client ID → Web application

# 4. Paste into installs/<base-domain>.local:
GOOGLE_OAUTH_CLIENT_ID="<client id from step 3>"
GOOGLE_OAUTH_CLIENT_SECRET="<client secret from step 3>"
GOOGLE_OAUTH_SCOPES="openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify"
```

Then `mise run deploy:prod`. Operators sign in via Google → consent screen lists everything → grant captured in `user_oauth_tokens`.

If you're new to GCP / want the longer walkthrough, keep reading.

## What you'll do

1. Create or pick a GCP project that owns the OAuth client.
2. Configure the OAuth consent screen (this is what your users see when they sign in).
3. Create an OAuth 2.0 Client ID and add your install's callback URL.
4. Enable the Google APIs you want agents to be able to call.
5. Add the scopes you want to request to your `installs/<base-domain>.local` and re-run `mise run configure:prod`.

Scope of work: 30–60 minutes for the non-sensitive APIs (Sheets, Docs, drive.file). Restricted scopes (Drive full, Gmail) require Google's CASA audit before they work for users outside your Workspace org — plan weeks, not minutes.

## 1. Pick the GCP project

You need a project that you control. The OAuth client lives here. The same project does **not** need to host the cluster — separating "the GCP project our cluster runs in" from "the GCP project our OAuth client lives in" is fine and common.

```bash
gcloud projects create my-x1agent --name="my x1agent install"
gcloud config set project my-x1agent
```

Or use an existing project. Either way, link a billing account to it (free for OAuth + non-sensitive Workspace APIs; Drive/Gmail/Calendar all have generous free tiers).

## 2. Configure the OAuth consent screen

In the GCP Console, go to **APIs & Services → OAuth consent screen** and configure:

- **User type:** "Internal" if every user has a Google Workspace account in your domain (no review needed). "External" if anyone with a Gmail address can sign in (Google review required for sensitive/restricted scopes — see "Verification" below).
- **App name:** what users see on the consent screen. Operators usually pick the install's display name (e.g. "Acme Agents").
- **User support email** and **developer contact email**: required by Google.
- **Authorized domains:** add the base domain of your install (e.g. `acme.example.com`).

Then on the **Scopes** step, add the scopes you intend to request. The minimum for sign-in identity is:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

For each integration you want, add the relevant scope from the table in the next section.

### Verification (the gotcha)

Google classifies scopes into three tiers:

| Tier | Examples | What you have to do |
|---|---|---|
| **None** | `openid`, `email`, `profile`, `documents`, `spreadsheets`, `drive.file` | Nothing. App ships immediately. |
| **Sensitive** | `drive.readonly`, `calendar`, `gmail.readonly`'s replacement read-only options | Submit your OAuth consent screen for verification. Google review takes days. |
| **Restricted** | `drive` (full), `gmail.modify`, `gmail.send` | Submit for verification AND complete a third-party CASA security audit. Costs thousands of dollars and takes weeks. |

If your User type is **Internal** (everyone is in your Workspace org), verification is skipped — you can use any scope immediately. This is the easy path for org-internal deployments.

If User type is **External** and you've added sensitive or restricted scopes, you'll see an "Unverified app" warning until verification completes. Internal-domain users (matching the `Authorized domains` you set) bypass that warning during the wait, so you can smoke-test on yourself before the public flow works.

## 3. Create the OAuth 2.0 Client ID

**APIs & Services → Credentials → + Create Credentials → OAuth client ID:**

- **Application type:** Web application
- **Name:** `x1agent` (or whatever)
- **Authorized redirect URIs:** add **one** entry: `https://api.<your-base-domain>/auth/google/callback`. For example, if your install is at `acme.example.com`, the redirect URI is `https://api.acme.example.com/auth/google/callback`. (For local dev: `https://api.local.x1agent.dev/auth/google/callback`.)

Click **Create**. Copy the **Client ID** and **Client secret** — you'll paste them into your install config.

## 4. Enable the Google APIs

For each integration you want agents to use, enable the matching API in your project.

Replace `MY-PROJECT` with your GCP project id everywhere below. **Tip:** find-and-replace `MY-PROJECT` once in this section and bookmark the result — every link below is a one-click "Enable" page pre-scoped to your project. The links are deterministic GCP URLs, no extra setup needed.

| API | Direct link | Used for |
|---|---|---|
| Drive | https://console.cloud.google.com/apis/library/drive.googleapis.com?project=MY-PROJECT | `files` domain — list/get/download/upload/update/trash, folder mgmt |
| Sheets | https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=MY-PROJECT | `documents` domain — read cell ranges, patch values |
| Docs | https://console.cloud.google.com/apis/library/docs.googleapis.com?project=MY-PROJECT | `documents` domain — read/patch document content |
| Calendar | https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=MY-PROJECT | `calendar` domain — events read/write |
| Gmail | https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=MY-PROJECT | `email` domain — read threads, send messages |

Or do it in one shot with gcloud:

```bash
gcloud services enable \
  drive.googleapis.com \
  sheets.googleapis.com \
  docs.googleapis.com \
  calendar-json.googleapis.com \
  gmail.googleapis.com \
  --project=MY-PROJECT
```

**Recommendation: enable all five up front,** even if you only plan to use a subset today. There's no charge until you actually call them, and you avoid coming back to the Console every time a new phase ships. Future phases (Sheets/Docs/Calendar/Gmail handlers) land as pure code work — no Console click cycle.

### Don't forget the OAuth consent screen

API enablement is necessary but not sufficient. Each scope you intend to request **must also be declared on the OAuth consent screen** at https://console.cloud.google.com/auth/scopes?project=MY-PROJECT → **Add or remove scopes**. If a scope is in your authorize URL but not on the consent screen, Google silently drops it (Internal user-type) or rejects the request (External user-type).

In Google's dialog, scroll to the **Manually add scopes** textbox at the bottom and paste this list as-is (one scope per line — Google accepts that format directly):

```
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/gmail.modify
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

Click **Add to table**, then **Update** at the bottom of the dialog, then **Save** on the Data Access page. The Data Access listing should now show all 8 across the non-sensitive / sensitive / restricted buckets.

## 5. Wire it into your install

Edit `installs/<base-domain>.local`:

```bash
GOOGLE_OAUTH_CLIENT_ID="<your client id>"
GOOGLE_OAUTH_CLIENT_SECRET="<your client secret>"
GOOGLE_OAUTH_SCOPES="openid email profile https://www.googleapis.com/auth/drive.readonly"
```

The `GOOGLE_OAUTH_SCOPES` value is a space-separated list. Add scopes here for every Workspace surface you want available. **Recommendation: set the maximum-capability superset once.** Avoids a re-consent cycle every time we ship a new phase, and Google's consent screen is identical-effort whether you pick one scope or five.

The full superset (covers Drive + Sheets + Docs + Calendar + Gmail with read+write):

```bash
GOOGLE_OAUTH_SCOPES="openid email profile \
  https://www.googleapis.com/auth/drive \
  https://www.googleapis.com/auth/spreadsheets \
  https://www.googleapis.com/auth/documents \
  https://www.googleapis.com/auth/calendar \
  https://www.googleapis.com/auth/gmail.modify"
```

Notes:
- `gmail.modify` is a superset of `gmail.readonly` + `gmail.send` + label management. Pick `gmail.modify` instead of carrying both sub-scopes.
- `drive` (full) is a Google **restricted** scope — fine for Internal user-type installs (org-only), but External installs need a CASA audit before non-org users can complete consent. Read the "Verification" section above.
- The platform NEVER stores credentials beyond the encrypted `user_oauth_tokens` row. Adding a scope to this list is a request for a capability; the user's actual grant is whatever they click "Allow" on at consent time and is reflected in `scopes_granted`.

**Quote the whole value** — it contains spaces, and unquoted whitespace will break the dotenv parser.

After editing, re-run `mise run configure:prod` to validate the install file, then `mise run deploy:prod` to roll the new scopes out to the api. Users sign in once with the new scopes; their grants persist in the platform's `user_oauth_tokens` table and providers can act on their behalf going forward.

## 6. Install the provider

Set in your Helm values:

```yaml
providers:
  workspace:
    type: google
```

The chart deploys the `google-workspace` Deployment, which subscribes to `x1.provider.{files,documents,calendar,email}.*` over NATS. If you skip this, sidecar requests to those subjects time out and agents see `not_configured` — no error in sign-in, just no Workspace tools surfaced.

## What users see

A user signs in with Google. The consent screen lists exactly the scopes you added in step 2. They click **Allow**. The platform persists the OAuth grant. Their orchestrator agent now has tools like `mcp__files__list_files` available; calling them returns real Drive content.

If a user revokes access in their Google Account settings later, the next agent call returns `permission_required` and the UI prompts them to reconnect. No silent failure paths.

## What's in v1 (live)

All five surfaces ship in PR #55 — the credential-proxy substrate, the provider deployment, the sidecar bridge, and the agent MCPs are all proven end-to-end:

- **Drive** (`files`) — list, get, download, upload, update content / metadata, create folder, trash
- **Sheets** (`sheets`) — read range, update range, append row, create spreadsheet
- **Docs** (`docs`) — read, create, replace text, append paragraph
- **Calendar** (`calendar`) — list events, create / update / delete event
- **Gmail** (`email`) — list threads, get message, send, trash

## What's NOT in v1

- Drive folder mount-and-sync (POSIX access at `/workspace/drive/<mount>`). Per-call API was the chosen v1 path — see decision discussion in PR #55 commits.
- A search index over the user's Drive content. Per-call list with the Drive `q=` query string is the v1 path; an indexed search backed by the workspace's vector provider is a v2 PRD.
- Drive change-watch / push notifications for live freshness. Per-call API model is always-fresh.
- Multi-user Calendar / shared mailbox handling. v1 is one user per session, the active TRIGGERING_USER_ID.
- Resumable Drive upload for files >20 MB. v1 caps content uploads at 20 MB.

## Microsoft 365 alternative

If your org is on Microsoft 365 instead of Google Workspace, the equivalent provider is `microsoft-365` (future). Same domain contracts, different backend (Microsoft Graph), different consent and verification process (Microsoft Entra publisher attestation, not CASA audit). Operators on mixed shops can split: e.g. `providers.workspace.type: google` for files + Slack for messaging + Outlook for email. The provider model handles each domain independently.

## Troubleshooting

**`redirect_uri_mismatch` on the Google consent screen.** Your redirect URI in step 3 must match exactly what x1agent posts back. The format is `https://api.<base-domain>/auth/google/callback`. Notice it's the **api** subdomain, not the bare base domain. If your DNS hasn't been set up for the api subdomain yet, that's a separate problem to fix first.

**Drive API call returns `Google Drive API has not been used in project X before or it is disabled`.** You missed step 4 for the Drive API specifically. Click the link, click **Enable**, wait ~30s, retry.

**Consent screen shows "Unverified app".** Either (a) your User type is "External" and you have sensitive/restricted scopes that haven't been verified yet — submit the consent screen for review, or switch to Internal if your install is org-only; or (b) you're testing as a non-org user, in which case you'll see this until verification completes.

**Token endpoint returns `permission_required` for a scope the user did consent to.** The user's stored grant doesn't include that scope. Check `user_oauth_tokens.scopes_granted` in the platform DB. If it's missing, the user's consent didn't cover it — they may have unchecked it on the consent screen, or the scope was added to `GOOGLE_OAUTH_SCOPES` after they signed in. Have them sign out and back in to refresh the grant.
