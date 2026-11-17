# The bootstrap stack (v3 Phase 5; Job-Agent's own, as Health-Review's): the customer-managed KMS key and the encrypted
# bucket that holds Terraform state. Applied once by the owner, with local state at first; infra/README.md then moves
# its state into the bucket it made (a local backend_override.tf, never committed).
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
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
