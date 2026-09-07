# Provision independently of the gateway's SQL attachment switch.
variable "push_dedicated_database_enabled" {
  type        = bool
  description = "Provision the dedicated push database without switching live gateway traffic."
  default     = false
}

variable "push_dedicated_database_active" {
  type        = bool
  description = "Attach the gateway to the provisioned dedicated database; does not copy existing state."
  default     = false
}

locals {
  push_dedicated_database_count = var.push_gateway_enabled && var.push_dedicated_database_enabled ? 1 : 0
  push_database_connection_name = var.push_dedicated_database_active ? google_sql_database_instance.push_dedicated[0].connection_name : local.relay_database_connection_name
  push_database_secret_id       = var.push_dedicated_database_active ? google_secret_manager_secret.push_dedicated_database_url[0].secret_id : google_secret_manager_secret.push_database_url[0].secret_id
  push_database_secret_version  = var.push_dedicated_database_active ? google_secret_manager_secret_version.push_dedicated_database_url[0].version : "latest"
}

resource "google_sql_database_instance" "push_dedicated" {
  count = local.push_dedicated_database_count

  project             = var.project_id
  name                = "${var.name_prefix}-push-db"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true

  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"
    edition           = "ENTERPRISE"
    disk_type         = "PD_SSD"
    disk_size         = 50
    disk_autoresize   = true
    user_labels       = local.relay_shared_labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      start_time                     = "05:00"
      backup_retention_settings {
        retained_backups = 7
      }
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day          = 7
      hour         = 6
      update_track = "stable"
    }

    deletion_protection_enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "push_dedicated" {
  count = local.push_dedicated_database_count

  project  = var.project_id
  name     = "orca_push"
  instance = google_sql_database_instance.push_dedicated[0].name

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "push_dedicated_database" {
  count   = local.push_dedicated_database_count
  length  = 32
  special = false
}

resource "google_sql_user" "push_dedicated" {
  count = local.push_dedicated_database_count

  project  = var.project_id
  name     = "orca_push"
  instance = google_sql_database_instance.push_dedicated[0].name
  password = random_password.push_dedicated_database[0].result
}

resource "google_secret_manager_secret" "push_dedicated_database_url" {
  count = local.push_dedicated_database_count

  project   = var.project_id
  secret_id = "${var.name_prefix}-push-dedicated-database-url"
  labels    = local.relay_shared_labels

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_version" "push_dedicated_database_url" {
  count = local.push_dedicated_database_count

  secret = google_secret_manager_secret.push_dedicated_database_url[0].id
  secret_data = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.push_dedicated[0].name,
    random_password.push_dedicated_database[0].result,
    google_sql_database.push_dedicated[0].name,
    google_sql_database_instance.push_dedicated[0].connection_name
  )
}

resource "google_secret_manager_secret_iam_member" "push_dedicated_database_url_accessor" {
  count = local.push_dedicated_database_count

  project   = var.project_id
  secret_id = google_secret_manager_secret.push_dedicated_database_url[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.push_runtime[0].member
}
