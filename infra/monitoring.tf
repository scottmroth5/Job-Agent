# Alarms emailed through one encrypted SNS topic (the owner confirms the subscription email once), and the monthly
# budget. Messages carry metric names and the instance only, never job data. The shared RDS instance's own alarms are
# Health-Review's (its monitoring.tf), which already watch its memory, storage, connections and CPU.
resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = local.key_arn
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarms = {
    server-status-check-failed = {
      namespace = "AWS/EC2", metric = "StatusCheckFailed", stat = "Maximum", op = "GreaterThanOrEqualToThreshold", threshold = 1
      dims      = { InstanceId = aws_instance.app.id }, missing = "breaching"
    }
    server-cpu-credits-low = {
      namespace = "AWS/EC2", metric = "CPUCreditBalance", stat = "Minimum", op = "LessThanThreshold", threshold = 20
      dims      = { InstanceId = aws_instance.app.id }, missing = "notBreaching"
    }
    server-memory-high = {
      namespace = "CWAgent", metric = "mem_used_percent", stat = "Average", op = "GreaterThanThreshold", threshold = 90
      dims      = { InstanceId = aws_instance.app.id }, missing = "notBreaching"
    }
    server-disk-high = {
      namespace = "CWAgent", metric = "disk_used_percent", stat = "Maximum", op = "GreaterThanThreshold", threshold = 80
      dims      = { InstanceId = aws_instance.app.id, path = "/", fstype = "ext4" }, missing = "notBreaching"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = each.value.stat
  comparison_operator = each.value.op
  threshold           = each.value.threshold
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The monthly budget for what is tagged app=job-agent (every resource here, through default_tags): an email when the
# month's actual cost passes 80% and when the forecast passes 100%. AWS counts a tag only once it is activated as a cost
# allocation tag (Billing console, once; infra/README.md). Emailed directly, not through the encrypted topic.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:app$job-agent"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
