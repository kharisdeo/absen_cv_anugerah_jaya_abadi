# DigitalOcean staging (pre-provisioning runbook)

This runbook and [`.do/app.yaml`](../../.do/app.yaml) are local preparation only. No
DigitalOcean account, application, database, Spaces bucket, key, domain, or deployment has been
created. Applying the App Spec will create App Platform components and may incur charges; get the
owner's explicit approval for the account, selected plan, and expected monthly cost first.

## Chosen target

- App Platform in `sgp`: one Fastify API service and one static Vite site, routed through one
  same-origin app host (`/api/*` to the API, `/` to the web). The client API base is `/api/v1`.
- Managed PostgreSQL in `SGP1` and private Spaces bucket in `SGP1` are separate resources. They
  are intentionally absent from the App Spec: adding a database resource or bucket configuration
  before the account, networking, costs, and private access policy are approved could create
  billable resources or expose evidence.
- Deploy-on-push is disabled. The App Spec points at `main`; review the exact commit and App
  Platform's source commit in the deployment record before any staging release. Never treat a
  branch name alone as immutable deployment evidence.
- The API service explicitly uses `apps-s-1vcpu-1gb-fixed`: 1 shared vCPU, 1 GiB RAM, fixed
  capacity, $10/month per instance, and 100 GiB/month outbound allowance. Instance count
  defaults to one. This overrides the App Spec's legacy `basic-xxs` default; the fixed plan
  does not support manual or autoscaling. App Platform transfer allowance is pooled across
  the team; additional outbound transfer currently costs $0.02/GiB.
- The static site is assumed to add $0/month when colocated in this app with its paid API
  component. Confirm the applicable pricing in the owner account before approval.
- PostgreSQL is estimated at about $15/month for a Standard single-node 1 GiB cluster; it is
  non-HA and the account/region price must be confirmed. Spaces Standard is estimated at
  $5/month for the base subscription, including 250 GiB storage and 1,024 GiB outbound
  transfer. Baseline staging total is therefore **about $30/month**, excluding tax and usage
  overages. Spaces additional storage currently costs $0.02/GiB/month and outbound transfer
  over 1,024 GiB costs $0.01/GiB. This is an estimate only, not a budget approval or a quote.

The API plan is a staging baseline, not a production capacity decision: its 1 GiB/shared CPU
fixed-size limit has no autoscaling. Test representative load before a pilot and increase the
plan only after reviewing resulting account pricing. The PostgreSQL single-node plan has no HA;
do not treat it as production-ready. Spaces over-quota storage/transfer and App Platform
bandwidth overages can increase the bill.

## Before an owner-approved provisioning/deploy

1. Confirm the DigitalOcean account/project, region availability, the selected plans and the
   approximately $30/month baseline estimate (including tax and overage assumptions), and whether
   the `main` branch is the intended staging source. Connect the GitHub repository using the
   provider's account integration; do not put a GitHub token or SSH private key in this repo.
2. Create/identify the Managed PostgreSQL Standard single-node 1 GiB cluster in `SGP1`, confirm
   its actual price, and review backup/maintenance settings; this estimate assumes non-HA. Decide
   private VPC connectivity and TLS. Provide `DATABASE_URL` only as an encrypted App Platform
   runtime secret. Do not commit it or paste it into chat.
3. Create a private Spaces bucket in `SGP1`, disable public access/CDN for attendance evidence,
   and create a least-privilege key for that bucket. Configure all five storage variables together:
   `STORAGE_ENDPOINT=https://sgp1.digitaloceanspaces.com`, `STORAGE_REGION=sgp1`,
   `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, and `STORAGE_SECRET_KEY`; key and secret must be
   encrypted runtime variables. Verify private read/write and deletion policy before using real
   employee evidence.
4. Assign the final HTTPS default/custom app origin and set `APP_ORIGIN` to that exact origin
   (scheme + host only, no path). Generate `SESSION_SECRET` with at least 32 characters and at
   least 16 distinct characters. Both are required for `NODE_ENV=staging`; store the session
   secret encrypted as a runtime variable.
5. Configure company-approved consent content as `CONSENT_POLICY_VERSION` and
   `CONSENT_POLICY_TEXT` together. Without both, the consent provider is unavailable and consent
   routes cannot complete. Confirm the legal copy/version with the owner before enabling accounts.
6. Keep notification credentials unset until a provider/sandbox is selected. Configure
   `NOTIFICATION_PROVIDER` and `NOTIFICATION_CREDENTIALS` together only after that choice.
7. Review `.do/app.yaml`, then use the DigitalOcean control panel or CLI only after the account,
   secrets, private data resources, and cost have been approved. Confirm the App Platform
   deployment commit, health, private database access, storage policy, cookie/origin behavior,
   and HTTPS before calling the environment staging-ready.

The API currently has no `TRUST_PROXY`/trusted-proxy environment setting. Do not invent or enable
Fastify proxy trust in this runbook; forwarded client-IP behavior, rate limits, and audit IPs need a
separate verified provider/network decision before changing that security boundary.

## App Spec behavior and validation boundary

The Node.js buildpack detects the root `pnpm-lock.yaml` and the exact `pnpm` version in the root
`packageManager` field. With root source directories, the platform's default package build runs the
workspace root `build` script; it builds API and web, and the static component publishes
`apps/web/dist`. The API process uses the root `start` script target and listens on the App Spec's
`PORT=3000` (`HOST=0.0.0.0`). The static site's `catchall_document: index.html` supports React
Router direct URLs. App ingress forwards `/api` to the API, and the API component in the App Spec
sets `preserve_path_prefix: true` so the `/api` prefix is retained. After provisioning, a real
HTTPS smoke test must still confirm the route end to end before authorizing employees to use the
app.

The API liveness path `/api/v1/health` does not prove the database is available. Check
`/api/v1/ready` separately after a database is attached; it must return 200 before running
migrations, seeding, or authenticated smoke tests. Use the repository's migration runbook for
`prisma migrate deploy`; do not use `migrate dev`, `db push`, database reset, or manual SQL schema
replacement in staging. The API runtime's `APP_VERSION` binds to `${_self.COMMIT_HASH}`, which
resolves to the App Platform source commit hash. The deployment health smoke must verify that
`X-App-Version` exactly matches that source commit over HTTPS. No DigitalOcean account or app
exists yet, so this deployed smoke remains pending.

No DigitalOcean schema validator, account API, deployment command, GitHub write, or paid resource
was used during preparation. YAML is syntax-checked locally only; acceptance of this spec and all
provider/network/cost behaviors remain unverified until an owner-approved validation/provisioning
step.

The daily attendance-status and selfie-retention commands are not scheduled by this App Spec.
Choose and validate their cadence/worker hosting separately before calling staging operationally
complete; do not add an unreviewed cron schedule here.

## Official provider references

- [App Platform App Spec](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- [App Platform pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/)
- [Node.js Buildpack](https://docs.digitalocean.com/products/app-platform/reference/buildpacks/nodejs/)
- [Manage App Platform databases](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/)
- [Managed PostgreSQL pricing](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/)
- [Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/)
- [Spaces API reference](https://docs.digitalocean.com/reference/api/spaces/)
