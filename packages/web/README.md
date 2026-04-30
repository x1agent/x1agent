# @x1agent/web

The marketing site at https://x1agent.com. Astro in server mode, deployed to Cloud Run.

## Develop

```bash
cd packages/web
cp .env.example .env.local   # add RESEND_API_KEY
npm install
npm run dev                  # http://localhost:4323
```

## Deploy

Pre-flight, in the GCP project where the site lives (not the K8s cluster project):

```bash
# 1. Create the Resend secret in Secret Manager.
gcloud secrets create resend-api-key --replication-policy=automatic
echo -n "re_xxx" | gcloud secrets versions add resend-api-key --data-file=-

# 2. Allow Cloud Run's default SA to read the secret.
PROJECT_NUMBER=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding resend-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Then:

```bash
npm run deploy
```

That runs `gcloud run deploy x1agent-web --source .` with the secret wired in. Cloud Run builds the container with Buildpacks (or the Dockerfile if present), uploads it, and scales it from zero on the first request.

Custom domain: in Cloud Run, map `x1agent.com` to the service. Cloud Run handles the cert.

## Resend domain verification

The first deploy uses `onboarding@resend.dev` so the form works without any DNS work. To send from `christian@x1agent.com`:

1. In the Resend dashboard, add the `x1agent.com` domain.
2. Copy the SPF + DKIM records into your DNS.
3. Once verified, set `WEB_FROM_EMAIL=x1agent <christian@x1agent.com>` in Cloud Run env.

## Why it's not in the cluster

The K8s cluster runs untrusted agent code. The marketing site is the public front door — anything running there is exposed to the internet by definition. Keeping the two on separate runtimes means a marketing-site compromise can't pivot to the platform. Cloud Run is its own isolation boundary.
