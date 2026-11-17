variable "region" {
  description = "AWS region (US only; Health-Review's network and RDS are here)."
  type        = string
  default     = "us-east-2"
}

variable "alert_email" {
  description = "Where CloudWatch alarms and the budget's alerts are emailed (the owner confirms the subscription email)."
  type        = string
  sensitive   = true
}

variable "deploy_ssh_public_key" {
  description = "The GitHub deploy key's public half (ssh-ed25519 ...). It can only run /opt/job-agent/deploy.sh."
  type        = string

  # It is written into a quoted line of the first-boot script: one plain public key, nothing else.
  validation {
    condition     = can(regex("^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$", var.deploy_ssh_public_key))
    error_message = "deploy_ssh_public_key must be one OpenSSH public key line (type, key and an optional plain comment)."
  }
}

variable "ssh_allowed_cidrs" {
  description = "Who may reach port 22 (the forced-command deploy key only). GitHub's runners have no fixed addresses."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "instance_type" {
  description = "The server: x86, because the image is built for linux/amd64."
  type        = string
  default     = "t3a.small"
}

variable "budget_limit_usd" {
  description = "The monthly AWS budget for Job-Agent's resources (the owner's decision, November 16, 2026)."
  type        = number
  default     = 50
}

variable "shared_name" {
  description = "The name Health-Review's stack gives its network, subnet, database firewall group and RDS instance."
  type        = string
  default     = "health-review"
}
