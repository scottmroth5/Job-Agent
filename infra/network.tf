# Job-Agent's server's own firewall group, in the shared network.
resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Job-Agent server: HTTPS and HTTP for Caddy, SSH for the forced-command deploy key"
  vpc_id      = data.aws_vpc.shared.id
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = { http = 80, https = 443 }
  security_group_id = aws_security_group.web.id
  description       = "Caddy (${each.key})"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = "0.0.0.0/0"
}

# Accepted (Trivy AWS-0107): GitHub's runners have no fixed addresses. Only the deploy user has a key, and it can only
# run deploy.sh; passwords and root login are off and fail2ban watches sshd. Administration is through SSM.
#trivy:ignore:AWS-0107
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = toset(var.ssh_allowed_cidrs)
  security_group_id = aws_security_group.web.id
  description       = "Deploy key (forced command)"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = each.value
}

# Out: the image registry, Google, the Claude API, job sites, package updates, SSM and RDS.
# Accepted (Trivy AWS-0104): those services have no fixed address ranges to list.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "web" {
  security_group_id = aws_security_group.web.id
  description       = "Outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
