# Health-Review's network and RDS instance, which Job-Agent shares (the owner's decision, November 16, 2026). They are
# only looked up here; Health-Review's own Terraform keeps managing them. The one change is a firewall rule on its
# database group letting Job-Agent's server in: a separate rule resource, which Health-Review's applies leave alone
# because its own rules are separate resources too.
data "aws_vpc" "shared" {
  tags = { Name = var.shared_name, app = var.shared_name }
}

data "aws_subnet" "public" {
  vpc_id = data.aws_vpc.shared.id
  tags   = { Name = "${var.shared_name}-public" }
}

data "aws_security_group" "db" {
  vpc_id = data.aws_vpc.shared.id
  name   = "${var.shared_name}-db"
}

data "aws_db_instance" "shared" {
  db_instance_identifier = var.shared_name
}

resource "aws_vpc_security_group_ingress_rule" "db_from_job_agent" {
  security_group_id            = data.aws_security_group.db.id
  description                  = "PostgreSQL from the Job-Agent server"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.web.id
}
