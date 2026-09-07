# Dedicated push database cutover

The gateway currently uses its own database and user on the shared auth/Relay SQL instance.
`push-dedicated-database.tf` can provision a separate PostgreSQL 16 instance without changing the
running gateway. Provisioning and cutover are separate operations: an empty database must never
replace the store holding paired phones.

The candidate is regional HA with 2 vCPU, 7.5 GiB RAM, 50 GB SSD with automatic growth, seven retained
backups and seven-day point-in-time recovery. Both Cloud SQL and Terraform protect it from deletion.
It has its own user, password, and Secret Manager secret; no public authorized network is declared.
Connections use the Cloud SQL connector. `push_dedicated_database_enabled` defaults to false in every
environment. No current service attachment, secret, pool size, or traffic target changes when this
file is introduced.

Before enabling provisioning, obtain a current regional pricing quote and review a saved Terraform
plan. Apply only the intended new resources through the audited infrastructure workflow. This root
contains unrelated standing drift; an unrestricted apply is not the migration procedure.

## Cutover requirements

1. Record the serving image, revision, database attachment, exact database secret version, and
   aggregate source row counts. Keep token material, session credentials, and notification content
   out of logs and artifacts.
2. Rehearse a whole-database transfer with the production PostgreSQL major version in an isolated
   environment. Include hosts, devices, sessions, challenges, logical events, recipients, batches,
   dismissal tombstones, and legacy rollback tables. Preserve primary keys and relationships.
3. Add and test an explicit maintenance gate that refuses new writes with retryable 503 responses
   and pauses worker claims. The current application does not yet provide this gate. A no-traffic
   candidate alone cannot fence writes from the still-serving revision or its background worker.
4. Acquire the shared SQL rollout lease. Fence all source writers, finish or expire provider leases,
   and transfer a consistent snapshot through protected streams. Verify schema, aggregate row counts,
   ownership, and pending work before allowing destination writes. Do not persist plaintext dumps.
5. Deploy a candidate using the dedicated SQL attachment and a pinned destination secret version.
   Keep the old database secret unchanged: an old revision referencing its original secret must not
   silently start using the new store. Verify readiness, immutable image, device registration,
   duplicate acceptance, pending-work recovery, APNs, and FCM access.
6. Promote only after those checks. Verify the destination serves real requests and the source has
   no writers. Preserve the source database for recovery.

Before destination writes, rollback can return to the fenced source after removing maintenance.
After destination writes, rolling traffic to the old revision alone loses new registrations and
queue state. Fence writers again and reconcile the authoritative destination back to the source,
or roll back application code while keeping the destination database attachment. Rehearse this
path before production cutover.

## Capacity after migration

Do not raise `push_database_pool_max` on the shared instance. Its current four-connection serving
allocation remains enforced until migration completes. A dedicated pool needs a measured budget
covering all serving replicas, the tagged deployment candidate, startup migrations, maintenance,
and operator connections. The local eight-connection probe is evidence of pool contention, not a
production sizing guarantee. Update the deployment scaling assertions and shared SQL budget contract
when the attachment changes; preserve rollout serialization until no shared-store writers remain.
