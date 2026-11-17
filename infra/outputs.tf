# Printed in the owner's terminal only (they name the account's resources); never paste them into the repo.
output "server_public_ip" {
  description = "The Elastic IP, for DNS at the cut-over."
  value       = aws_eip.app.public_ip
}

output "server_instance_id" {
  description = "For aws ssm start-session --target <id>, and db-setup.ps1's port forward."
  value       = aws_instance.app.id
}

output "db_address" {
  description = "The shared RDS host name (db-setup.ps1: the certificate name to check and the port forward's target)."
  value       = data.aws_db_instance.shared.address
}

output "db_master_secret_arn" {
  description = "The shared RDS instance's master password secret (Secrets Manager), which db-setup.ps1 reads once."
  value       = data.aws_db_instance.shared.master_user_secret[0].secret_arn
}

output "region" {
  description = "The stack's region (the owner's scripts)."
  value       = local.region
}

output "alert_topic_arn" {
  description = "The SNS topic the alarms email through."
  value       = aws_sns_topic.alerts.arn
}
