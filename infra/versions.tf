# Job-Agent's production stack (v3 Phase 5; docs/architecture/decisions/0007-shared-rds.md): its own EC2 server inside
# Health-Review's network, its own logins and database on Health-Review's RDS instance, its role, alarms and budget.
# Health-Review's resources are only looked up (shared.tf), never changed, except one added firewall rule. The owner runs
# plan and apply (infra/README.md); nothing here holds a secret value, an account id or an address. State lives in the
# bootstrap stack's encrypted bucket; backend.hcl (gitignored) names it.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: terraform init -backend-config=backend.hcl (see backend.hcl.example).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      app        = "job-agent"
      managed-by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

# The bootstrap stack's customer-managed key (Job-Agent's own, not Health-Review's).
data "aws_kms_alias" "main" {
  name = "alias/job-agent"
}

locals {
  name      = "job-agent"
  key_arn   = data.aws_kms_alias.main.target_key_arn
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id
}
