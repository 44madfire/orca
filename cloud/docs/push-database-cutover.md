# Dedicated push database cutover

The gateway has a dedicated PostgreSQL 17 instance configured in
`infra/terraform/push-dedicated-database.tf`: regional HA, 2 vCPU, 7.5 GiB RAM, 50 GiB SSD
with automatic growth, seven retained backups and seven-day point-in-time recovery.
Cloud SQL and Terraform both protect it from deletion. Connections use the Cloud SQL
connector and a separate Secret Manager secret pinned to its Terraform-managed version.

Provisioning (`push_dedicated_database_enabled`) and attachment
(`push_dedicated_database_active`) are separate switches. Neither changes the existing
shared database or its credentials. The production feature is still in internal testing;
its owner approved an empty database and discarding the previous test state. No data
transfer or application maintenance mechanism is needed for this initial activation.
Test phones must register again; pending notifications and old sessions do not transfer.
This reset procedure is not suitable after public launch without explicit data-loss approval.

## Provision

Use the production relay backend and environment variables documented in
`infra/terraform/README.md`. Save and review a targeted Terraform plan containing only:

- `google_sql_database_instance.push_dedicated`
- `google_sql_database.push_dedicated`
- `random_password.push_dedicated_database`
- `google_sql_user.push_dedicated`
- `google_secret_manager_secret.push_dedicated_database_url`
- `google_secret_manager_secret_version.push_dedicated_database_url`
- `google_secret_manager_secret_iam_member.push_dedicated_database_url_accessor`

Require exactly seven additions and no updates or deletions for initial provisioning.
Apply that saved plan with backend locking, then require the same targeted plan to be
empty. Keep sensitive Terraform plans access-restricted; never print secret values or
upload raw state/plan JSON. Verify the instance is RUNNABLE with the expected version,
tier, backup policy, and regional availability. No Cloud Run service changes in this step.

## Activate the empty store

1. Record the current immutable serving image, revision, SQL attachment, and database
   secret reference. Confirm traffic is pinned to that revision rather than LATEST.
2. Set `push_dedicated_database_active = true` in production. Save a targeted plan for
   `google_cloud_run_v2_service.push`. Inspect its dependency closure and reject unrelated
   changes. Require only the SQL attachment and database secret reference to change.
3. Hold the existing Cloud SQL rollout lease while applying that saved service-shape plan.
   Terraform ignores traffic and image; verify traffic remains pinned to the old revision.
   Do not apply a plan that would shift traffic or revert runtime configuration.
4. Dispatch `cloud-push-deploy.yml` from main with the exact reviewed source SHA. It creates
   an inert, read-only candidate inheriting the dedicated attachment, probes readiness and provider
   access, then deliberately creates an active successor of the same digest before deleting validation.
   Activation starts schema writes and workers before HTTP promotion. Verify the candidate's SQL
   attachment and pinned secret reference as well as its image and health.
5. Register a test phone against the deployed origin and prove real APNs delivery. Check
   database errors and confirm the old revisions have no traffic or tags and source SQL
   connections have drained. Leave the old database intact; do not delete shared resources.

If activation fails before promotion, the existing HTTP serving revision is unchanged, but
activated workers may already have sent notifications or mutated the queue. Cloud Run will not
delete the latest created revision, even untagged at zero traffic. Recovery creates a known-good
successor first, verifies its template/runtime/secret shape and health, promotes and verifies it,
then deletes rejected and previous consumers. The recovery successor remains serving; it can run
known-good schema/workers before promotion and does not undo earlier queue or schema changes.
A partial activation leaving three resources must retire non-latest inert validation before
recovery creates another; failed retirement stops automation. Every deploy requires a single
serving revision resource at admission, so review and retire historical/leftover revisions under
the lease before dispatch. A Terraform attachment update can itself create such a revision:
verify/promote that known-good image and attachment and retire the former revision before dispatch.
The deploy workflow can roll traffic back on failure; in this internal reset rollout,
that may discard registrations created during the probe window. After successful activation,
application rollback should retain the dedicated attachment and deploy an older compatible
image through the workflow. Returning to the shared store is another explicit state reset,
not a lossless rollback. Future public migrations require a separately rehearsed transfer.

## Capacity and resizing

The initial gateway keeps its existing two-connection pool and two-instance maximum.
Dedicated database rollout pools are capped at 64 total configured pool connections across three simultaneous
revision resources (serving, validation/rejected, and active/recovery successor), leaving room for maintenance and operators; this is an admission
budget, not a throughput claim. Increase the pool only after measuring deployed contention.
Keep the shared database allocation reserved until source connections have drained.

Cloud SQL CPU/RAM resizing is an in-place infrastructure change but can interrupt database
connections. HA does not make a resize interruption-free. Durable accepted events remain in
SQL and workers retry after recovery within their five-minute expiry; requests that never
reach durable acceptance depend on client retries. Schedule resizes and verify reconnection,
queue recovery, readiness, and real delivery afterward.
