# Backend API Contract for the NHI Dashboard

**Status:** Draft implementation contract based on the supplied dashboard screens and the current pipeline schema.

**Audience:** Backend engineers, including engineers new to this codebase.

**Goal:** Give the frontend a small, predictable API surface for:

- Dashboard summary and charts.
- Anomaly list and anomaly evidence.
- Identity detail pages.
- Activity, baseline, genome, and timeline views.
- Anomaly dispositions and credential actions.
- Optional live updates.

This document intentionally describes **only data that the current pipeline stores or can calculate from current tables**. A screenshot label is not treated as a pipeline field. If a screenshot feature is not stored, it is marked `NEEDS TO BE ADDED` or `NEEDS CONFIRMATION` instead of being presented as implemented.

There is no HTTP API in the current project. The endpoints below are the proposed read contract for a future API. An endpoint marked pending must not be implemented as if the current pipeline already supports it.

---

## 1. Important rules

### 1.1 Read-only identity source

The canonical identity source is the configured `POSTGRES_SCHEMA.POSTGRES_IDENTITY_TABLE` relation; defaults are `bimasugam.identities`.

The discovery service owns the configured identity relation, normally `bimasugam.identities`. Dashboard APIs and this monitoring pipeline must not insert, update, or delete rows there. If a service/resource has no discovery row, the API must return the identity as unavailable; it must not synthesize an identity row from an event.

The API may enrich an identity response with monitoring data from `baselines`, `identity_risk_scores`, `alerts`, and ClickHouse. It must not change discovery-owned fields.

### 1.2 Event source

The event log is the configured ClickHouse database and event table:

```text
CLICKHOUSE_DATABASE.CLICKHOUSE_EVENTS_TABLE
# defaults: ecs_nhi.log_events
```

The configured ClickHouse table name is available through the existing `CLICKHOUSE_EVENTS_TABLE` setting (mapped to the application `clickhouse_table` setting). The examples below use the configured placeholders; the defaults are `ecs_nhi.log_events`.

The current code registers 39 NHI subtypes and has explicit service rules for them. EC2/ECS have AWS discovery/enrichment; Lambda/Glue/Step Functions have dedicated resource-first resolvers; most other registered AWS service types use strict CloudTrail evidence plus read-only PostgreSQL discovery lookup. Step Functions is CloudTrail-only; EventBridge execution-status persistence is not part of this schema, and EventBridge is relevant only when it carries a CloudTrail-shaped event envelope. The active runtime uses explicit service-specific CloudTrail attribution rules that share only the normalized discovery lookup layer. GitHub Actions, GitLab CI, and Terraform require external feeds and are not claimed by the AWS CloudTrail consumer. EKS pod and node attribution remains deferred until Kubernetes audit-log, IRSA, Pod Identity, and cluster/workload correlation support exists.

The active registry contains 39 NHI subtypes. The normalized subtype is retained as `nhi_identity_type` in normalized identity metadata; the persisted `source_type` remains a compact uppercase service-family value because the existing monitoring columns are `VARCHAR(16)`. Human IAM users, federated users, Cognito end-user identities, and human Transfer Family users are never baseline or alert identities.

### 1.3 Stable identity versus execution metadata

Do not create an API identity for every execution or event.

| Service | Stable identity | Runtime metadata |
|---|---|---|
| EC2 | Instance / `instance_id` and instance ARN | IAM profile, role, IP, AMI, instance type |
| ECS | Canonical discovery ARN for the task or service row; use `workload_key` to aggregate task incarnations | Task ARN, task ID, task status, task-definition revision, and role-derived `workload_key` |
| Lambda | Canonical function ARN | Qualifier/version, invocation, caller, execution role |
| Glue | Canonical job ARN/name | JobRun ID, run state, run timestamps |
| Step Functions | Canonical state-machine ARN/name | Execution ARN/name, status, timestamps, input/output references |
| Approved AWS service NHIs | Discovery resource ARN/name or stable account/region/type/resource key; service-family `source_type` plus `nhi_identity_type` metadata | Service-specific execution/job/run/request metadata; execution IDs are not baseline keys |
| IoT thing / Greengrass core | Role-alias/service-role attribution only | MQTT-only activity and local component behavior are not fully visible through CloudTrail |
| EKS pod / node | **DEFERRED** | Requires Kubernetes audit-log, IRSA, Pod Identity, and cluster/workload correlation support |

For Step Functions, the execution ARN is never the identity key or baseline key. The same no-ephemeral-key rule applies to job-run IDs, automation execution IDs, Terraform run IDs, and other execution identifiers in the approved registry.

### 1.4 Active NHI registry and exclusions

The runtime registry is defined in `app/nhi_types.py`. Its 39 active subtype names are:

```text
ec2_instance, lambda_function, ecs_task, app_runner_service,
elastic_beanstalk_environment, ssm_managed_node, glue_job, glue_crawler,
emr_cluster, batch_job, dms_replication_instance, kinesis_firehose,
kinesis_analytics_app, datasync_task, sagemaker_notebook,
sagemaker_training_job, sagemaker_processing_job, sagemaker_endpoint,
bedrock_agent, bedrock_knowledge_base, codebuild_project, codepipeline,
codedeploy_service_role, cloudformation_stack_role, mwaa_environment,
github_actions_workflow, gitlab_ci_job, terraform_run, step_function,
eventbridge_scheduler, ssm_automation, synthetics_canary, iot_role_alias,
iot_thing, greengrass_core, transfer_server, iam_roles_anywhere_session,
saas_vendor_role, aws_service_linked_role
```

`eks_pod` and `eks_node` are deferred. `iam_user_access_key`, `cognito_identity_pool`, `federated_user`, and deleted resource-only types are excluded. Human actor names may remain only as redacted event provenance; they must not populate `source_type`, `identity_name`, or a baseline key.

### 1.5 Response envelope

All HTTP endpoints should use the same envelope:

```json
{
  "data": {},
  "meta": {
    "request_id": "req_01J...",
    "generated_at": "2026-10-13T10:30:00Z",
    "next_cursor": null
  }
}
```

Errors:

```json
{
  "error": {
    "code": "IDENTITY_NOT_FOUND",
    "message": "The requested identity was not found",
    "request_id": "req_01J..."
  }
}
```

Use cursor pagination for event and anomaly lists. Do not use large offset pagination.

---

## 2. Common query parameters

These parameters can be used where relevant:

| Parameter | Meaning |
|---|---|
| `source_type` | Compact uppercase service family from the active registry, such as `EC2`, `ECS`, `LAMBDA`, `GLUE`, `STEP_FUNCTIONS`, `CODEBUILD`, `SAGEMAKER`, `SSM`, or `IAM`; values fit the existing `VARCHAR(16)` columns |
| `account_id` | AWS account filter |
| `region` | AWS region filter |
| `from` | Inclusive ISO-8601 timestamp |
| `to` | Exclusive ISO-8601 timestamp |
| `limit` | Maximum rows; default 25, maximum 100 |
| `cursor` | Opaque keyset cursor |
| `search` | Identity/API/resource text search |

Use UTC timestamps everywhere.

---

## 2.1 PostgreSQL versus ClickHouse responsibility

Use the database that owns the fact. Do not copy the entire event stream into PostgreSQL just to make an API query easier.

| Responsibility | PostgreSQL | ClickHouse |
|---|---|---|
| Canonical identity record | Yes: read-only `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>` | No; only event snapshots/enrichment |
| Identity metadata/header | Yes, joined with latest monitoring facts | Event fallback fields only |
| Baseline state | Yes: `baselines` | No |
| Baseline versions/provenance | Yes: `baseline_versions`, `daily_stats` | Training source only |
| Alert/anomaly workflow | Yes: `alerts`, `alert_feedback`, future disposition table | Event-level risk and evidence |
| Identity risk snapshot | Yes: `identity_risk_scores` | Calculate event/identity aggregates when a persisted snapshot is unavailable |
| Recent calls | No | Yes: `log_events` |
| Call-volume charts | No for raw event charts | Yes: group `log_events` by time bucket |
| Activity schedule, typical actions/resources | No | Yes: group `log_events` and parse `dimensions_json` |
| Raw evidence | Alert comparison in PostgreSQL; event detail in ClickHouse | Yes: `request_parameters`, resources, risk components, API fields |
| Containment action history | Future additive action table | No, except optional provider response metadata |

Recommended request flow:

1. Read the identity, baseline, alert, and risk snapshot from PostgreSQL.
2. Use the returned identity/event IDs to fetch event detail or aggregates from ClickHouse in one query.
3. Merge the small result sets in the API service.
4. Cache the merged response for a short period when appropriate.

## 2.2 Authentication and authorization assumption

The current project has no HTTP API layer, so authentication is a product decision. For this contract assume:

- Every endpoint requires `Authorization: Bearer <access-token>` from the identity provider.
- The API gateway validates the token and passes `subject`, `tenant_id`, and allowed AWS accounts/regions to the service.
- `GET` endpoints require a dashboard-read permission.
- Disposition endpoints require an anomaly-review permission.
- Containment/freeze endpoints require a separate containment-admin permission and a second confirmation in the UI.
- The backend must apply tenant/account/region authorization filters in SQL. Never rely only on frontend filters.
- The reviewer identity is taken from the validated token, not trusted from the request body. A request-body `reviewer` is optional display metadata only.
- If authentication has not been selected, return `501 AUTH_NOT_CONFIGURED` in a development environment rather than silently serving cross-account data.

All endpoint sections below use this assumption. The exact identity-provider claims and permission names are **NEEDS CONFIRMATION**.

## 3. Endpoint summary

### Dashboard

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/dashboard/summary` | Top cards, stored alert-dimension counts, charts, most anomalous identities, and derived peer comparisons |
| `GET` | `/api/v1/dashboard/activity` | Fleet call-volume series and anomaly series |
| `GET` | `/api/v1/dashboard/drift` | Fleet baseline-health, drift counts and model-confidence series |

### Identities

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/identities` | Identity list and fleet table |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}` | Identity header and summary |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/activity` | Call volume and recent calls |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/genome` | Behavioural fingerprint and typical actions |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/baseline` | Baseline profile and provenance |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/timeline` | Baseline and anomaly lifecycle |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/peers` | Peer-group comparison |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/drift` | Identity baseline-health and dimension-drift evidence |

### Anomalies

| Method | Endpoint | Current pipeline support | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/anomalies` | Supported from `alerts` plus ClickHouse event data | Filterable anomaly list |
| `GET` | `/api/v1/anomalies/{alert_id}` | Supported from `alerts` plus ClickHouse event data | Anomaly summary/detail |
| `GET` | `/api/v1/anomalies/{alert_id}/evidence` | Supported from `alerts` plus ClickHouse event data | Evidence drawer |
| `POST` | `/api/v1/anomalies/{alert_id}/feedback` | Supported by `alert_feedback` | Save `legitimate`, `malicious`, or `unknown` reviewer feedback |
| `POST` | `/api/v1/anomalies/{alert_id}/disposition` | **NEEDS TO BE ADDED** | Full acknowledge/expected/resolve/suppress workflow; no current table supports it |

### Activity, timeline, and peer group

These are the identity sub-resources listed above:

- Activity: `/api/v1/identities/{source_type}/{identity_name}/activity`
- Timeline: `/api/v1/identities/{source_type}/{identity_name}/timeline`
- Peer group: `/api/v1/identities/{source_type}/{identity_name}/peers`

### Containment

| Method | Endpoint | Current pipeline support | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/containment` | **NEEDS TO BE ADDED** | List containment requests and their state |
| `GET` | `/api/v1/identities/{source_type}/{identity_name}/containment` | **NEEDS TO BE ADDED** | Show containment state for one identity |
| `POST` | `/api/v1/identities/{source_type}/{identity_name}/containment/freeze` | **NEEDS TO BE ADDED** | Request credential freeze |

### Evidence

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/anomalies/{alert_id}/evidence` | Evidence drawer with event, baseline, and risk details |

### Optional live updates

| Transport | Endpoint | Current pipeline support | Purpose |
|---|---|---|---|
| WebSocket | `/api/v1/ws` | **NEEDS TO BE ADDED**; polling is the current option | Push new anomaly, baseline update, and identity activity notifications |

The current pipeline has no HTTP API or WebSocket fan-out. Use HTTP refresh/polling first. A WebSocket is a future notification layer and must not replace the initial HTTP queries.

---

### Screenshot feature coverage

Every visible feature is covered below. `Pending` means the endpoint exists in the contract but the current schema cannot provide the value without an explicit addition or confirmation.

| Screenshot feature | Endpoint | Status |
|---|---|---|
| Fleet overview cards | `GET /api/v1/dashboard/summary` | Ready from `identities`, `baselines`, `alerts`, and `identity_risk_scores`; drift card is available from drift_fleet_snapshots and identity_drift_scores |
| Departures by dimension | `GET /api/v1/dashboard/summary` | Current pipeline supports exact `alerts.dimension` values only; screenshot labels such as privilege escalation are not current fields |
| Anomalies per day / call volume | `GET /api/v1/dashboard/activity` | Ready from ClickHouse and `alerts` |
| Most anomalous identities | `GET /api/v1/dashboard/summary` | Ready from latest `identity_risk_scores` |
| Peer-group outliers | `GET /api/v1/dashboard/summary` and identity `/peers` | Derived peer key now; managed peer groups pending |
| Recently baselined | `GET /api/v1/dashboard/summary` | Ready from `baselines` and `baseline_versions` |
| Anomaly list and filters | `GET /api/v1/anomalies` | Ready for `alerts.status` and `alert_feedback.decision`; acknowledge/suppress/resolve workflow states pending |
| Evidence drawer | `GET /api/v1/anomalies/{alert_id}/evidence` | Ready from `alerts` plus ClickHouse; app/redaction.py applies runtime redaction |
| Identity header / record navigation | `GET /api/v1/identities` and `/{identity}` | Ready from canonical identity tables |
| Activity call-volume chart | identity `/activity` | Ready from bounded ClickHouse aggregation |
| Recent calls | identity `/activity` | Ready from ClickHouse `log_events` |
| Activity schedule | identity `/genome` | Ready from ClickHouse event time |
| Typical resources | identity `/genome` | Ready where `resource_arns` and dimension JSON are populated |
| Baseline versus observed activity | identity `/baseline` and `/genome` | Baseline profile exists; exact confidence display needs confirmation |
| Baseline provenance | identity `/baseline` | Ready from `baselines`, `baseline_versions`, `daily_stats` |
| Behavioural fingerprint | identity `/genome` | Derived from `dimensions_json`; typed JSON projection may be needed for scale |
| Typical actions | identity `/genome` | Ready from `event_source` and `event_name` |
| Identity timeline | identity `/timeline` | Derived now; immutable history is pending if audit-grade history is required |
| Containment view | `GET /api/v1/containment` and identity `/containment` | Pending: no containment/action table or worker |
| Freeze credential action | identity `/containment/freeze` | Pending: asynchronous action/outbox and authorization required |


### 3.1 Current NHI type and AWS API-call coverage

The API must expose both the compact `source_type` and the normalized `nhi_identity_type` when available. The following matrix reflects the current `app/nhi_types.py`, `app/service_resolution.py`, `app/source_discovery.py`, and dedicated resolver modules.

**Important distinction:** an AWS API event being monitored is not the same as an AWS SDK call made by NHI Genome. NHI Genome directly calls SQS, STS, EC2/IAM, and ECS APIs. Most other NHI types are attributed from CloudTrail resource/name/role evidence and read-only PostgreSQL discovery lookup; the pipeline does not call every target AWS service's `Describe` API.

| `nhi_identity_type` | `source_type` | Event/service evidence | Direct AWS SDK calls by NHI Genome | Current resolution path |
|---|---|---|---|---|
| `ec2_instance` | `EC2` | EC2 role-delivery/session context, instance IDs/ARNs | EC2 `DescribeInstances`, profile-association calls; IAM profile/role reads | `ec2_resolution.py`, Redis/PostgreSQL cache and discovery |
| `lambda_function` | `LAMBDA` | `lambda.amazonaws.com`, function ARN/name, qualifier/invocation evidence | No Lambda SDK call in current resolver | `serverless_resolution.py` + PostgreSQL discovery |
| `ecs_task` | `ECS` | ECS task-role CloudTrail context and ECS task-state events | ECS `List*`/`Describe*`, task definition and STS account calls | `ecs_resolution.py`, `ecs_task_registry.py` |
| `app_runner_service` | `APP_RUNNER` | `apprunner.amazonaws.com` | No App Runner SDK call | Explicit service rule + PostgreSQL resource/role lookup |
| `elastic_beanstalk_environment` | `ELASTIC_BEAN` | `elasticbeanstalk.amazonaws.com` | No Elastic Beanstalk SDK call | Explicit service rule + PostgreSQL lookup |
| `ssm_managed_node` | `SSM` | SSM managed-instance/command events | No SSM SDK call | Explicit service rule + PostgreSQL lookup |
| `glue_job` | `GLUE` | Glue job/job-run events | No Glue SDK call | Dedicated Glue resolver + PostgreSQL lookup |
| `glue_crawler` | `GLUE` | Glue crawler events | No Glue SDK call | Dedicated/generic Glue resolver + PostgreSQL lookup |
| `emr_cluster` | `EMR` | EMR or EMR Serverless events | No EMR SDK call | Explicit service rule + PostgreSQL lookup |
| `batch_job` | `BATCH` | Batch job/queue/definition events | No Batch SDK call | Explicit service rule + PostgreSQL lookup |
| `dms_replication_instance` | `DMS` | DMS replication-instance/task events | No DMS SDK call | Explicit service rule + PostgreSQL lookup |
| `kinesis_firehose` | `KINESIS` | Firehose delivery-stream events | No Firehose SDK call | Explicit service rule + PostgreSQL lookup |
| `kinesis_analytics_app` | `KINESIS` | Kinesis Analytics application events | No Kinesis Analytics SDK call | Explicit service rule + PostgreSQL lookup |
| `datasync_task` | `DATASYNC` | DataSync task/execution events | No DataSync SDK call | Explicit service rule + PostgreSQL lookup |
| `sagemaker_notebook` | `SAGEMAKER` | SageMaker notebook events | No SageMaker SDK call | Explicit service rule + PostgreSQL lookup |
| `sagemaker_training_job` | `SAGEMAKER` | SageMaker training-job events | No SageMaker SDK call | Explicit service rule + PostgreSQL lookup |
| `sagemaker_processing_job` | `SAGEMAKER` | SageMaker processing-job events | No SageMaker SDK call | Explicit service rule + PostgreSQL lookup |
| `sagemaker_endpoint` | `SAGEMAKER` | SageMaker endpoint events | No SageMaker SDK call | Explicit service rule + PostgreSQL lookup |
| `bedrock_agent` | `BEDROCK` | Bedrock/agent-runtime agent events | No Bedrock SDK call | Explicit service rule + PostgreSQL lookup |
| `bedrock_knowledge_base` | `BEDROCK` | Knowledge-base/retrieve events | No Bedrock SDK call | Explicit service rule + PostgreSQL lookup |
| `codebuild_project` | `CODEBUILD` | CodeBuild project/build events | No CodeBuild SDK call | Explicit service rule + PostgreSQL lookup |
| `codepipeline` | `CODEPIPELINE` | CodePipeline pipeline/execution events | No CodePipeline SDK call | Explicit service rule + PostgreSQL lookup |
| `codedeploy_service_role` | `CODEDEPLOY` | CodeDeploy application/deployment events | No CodeDeploy SDK call | Explicit service rule + PostgreSQL lookup |
| `cloudformation_stack_role` | `CLOUDFORMATION` | CloudFormation stack/role events | No CloudFormation SDK call | Explicit service rule + PostgreSQL lookup |
| `mwaa_environment` | `MWAA` | Airflow/MWAA environment events | No MWAA SDK call | Explicit service rule + PostgreSQL lookup |
| `github_actions_workflow` | `GITHUB_ACTIONS` | External GitHub audit source | No; feed not connected | Explicit rule returns `github_audit_feed_not_connected` |
| `gitlab_ci_job` | `GITLAB_CI` | External GitLab audit source | No; feed not connected | Explicit rule returns `gitlab_audit_feed_not_connected` |
| `terraform_run` | `TERRAFORM` | External Terraform audit source | No; feed not connected | Explicit rule returns `terraform_audit_feed_not_connected` |
| `step_function` | `STEP_FUNCTIONS` | Step Functions state-machine/execution events | No Step Functions SDK call | `stepfunctions_resolution.py` + PostgreSQL discovery |
| `eventbridge_scheduler` | `EVENTBRIDGE` | Scheduler/EventBridge schedule events | No Scheduler/EventBridge SDK call | Explicit service rule + PostgreSQL lookup |
| `ssm_automation` | `SSM` | SSM Automation events | No SSM SDK call | Explicit service rule + PostgreSQL lookup |
| `synthetics_canary` | `SYNTHETICS` | CloudWatch Synthetics canary events | No Synthetics SDK call | Explicit service rule + PostgreSQL lookup |
| `iot_role_alias` | `IOT` | IoT role-alias events | No IoT SDK call | Explicit service rule + PostgreSQL lookup |
| `iot_thing` | `IOT` | IoT thing events with role-alias evidence | No IoT SDK call | Conditional role-alias-only attribution |
| `greengrass_core` | `GREENGRASS` | Greengrass core/service-role evidence | No Greengrass SDK call | Conditional service-role attribution + PostgreSQL lookup |
| `transfer_server` | `TRANSFER` | Transfer Family server events | No Transfer Family SDK call | Explicit service rule + PostgreSQL lookup |
| `iam_roles_anywhere_session` | `IAM` | Roles Anywhere profile/trust-anchor/role evidence | No IAM Roles Anywhere SDK call | Explicit service rule + PostgreSQL lookup |
| `saas_vendor_role` | `IAM` | STS AssumeRole/role-session evidence | No SaaS-provider SDK call | Explicit STS rule + PostgreSQL lookup |
| `aws_service_linked_role` | `AWS_SLR` | IAM service-linked-role events | No service-linked-role SDK call | Explicit IAM rule + PostgreSQL lookup |

The API should expose a capability/status field when useful: `resolved`, `pending`, `unknown`, `external_feed_not_connected`, or `conditional`. Do not report a type as live merely because it exists in the registry.

### 3.2 Supplied dashboard images mapped to the current data model

The supplied dashboard images map to the following API resources:

| Supplied screen | Visible product area | API resource | Current data sources |
|---|---|---|---|
| `image (3).png` | Anomaly evidence drawer / activity detail | `/api/v1/anomalies/{alert_id}/evidence` | `alerts`, `alert_feedback`, latest ClickHouse event/risk row, redacted request fields |
| `image (4).png` | Identity baseline and lifecycle timeline | Identity `/baseline`, `/timeline`, `/drift` | `baselines`, `baseline_versions`, `daily_stats`, `identity_drift_scores` |
| `image (5).png` | Anomaly list and status/filter view | `/api/v1/anomalies` | `alerts`, `alert_feedback`, ClickHouse severity/risk |
| `image (6).png` | Anomaly list / identity risk comparison | `/api/v1/anomalies` and dashboard summary | `alerts`, `identity_risk_scores`, discovery identity metadata |
| `image (7).png` | Dashboard activity and peer/outlier panels | `/api/v1/dashboard/summary`, `/activity` | ClickHouse aggregates, `identity_risk_scores`, derived peer key |
| `image (9).png` | Fleet overview cards, baseline coverage, departures, most anomalous identities | `/api/v1/dashboard/summary` | Discovery identities, `baselines`, `alerts`, `identity_risk_scores`, `drift_fleet_snapshots` |
| `image (10).png` | Identity genome / baseline departure / behavioral fingerprint | Identity `/genome`, `/baseline`, `/timeline` | ClickHouse `log_events`, `dimensions_json`, `resource_arns`, `baselines`, `baseline_versions`, drift tables |
| `image (11).png` | Activity heatmap, typical actions/resources | Identity `/activity` and `/genome` | ClickHouse `event_time`, `event_source`, `event_name`, `dimensions_json`, `resource_arns` |
| `image (12).png` | Identity activity trend and recent calls | Identity `/activity` | ClickHouse latest rows grouped by `event_id` |
| `image (13).png` | Baseline departure/anomaly detail | `/api/v1/anomalies/{alert_id}` and `/evidence` | PostgreSQL `alerts`, `alert_feedback`; ClickHouse event/risk evidence |
| `Screenshot 2026-10-13 202412.png` | Recent calls list | Identity `/activity` recent calls | ClickHouse `<CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE>` |

The API must not create screenshot-only fields such as `privilege escalation`, `dormant wake`, or `new resource` unless they are explicitly derived from current `alerts.dimension`, `alerts.reason`, and risk components.

## 4. Dashboard endpoints

## 4.1 `GET /api/v1/dashboard/summary`

This endpoint powers the dashboard cards and the right/left summary panels in the screenshots.

### Query parameters

```text
from=2026-09-26T00:00:00Z
 to=2026-10-10T00:00:00Z
source_type=ECS              optional
account_id=123456789012      optional
region=ap-south-1            optional
```

If `from` and `to` are omitted, default to the last 14 days for charts and the last 24 hours for open-anomaly cards.

### Response shape

```json
{
  "data": {
    "cards": {
      "baselines_established": null,
      "identities_watched": null,
      "still_learning": null,
      "open_anomalies": null,
      "critical_anomalies": null,
      "baseline_coverage_percent": null,
      "mean_provenance_confidence": null,
      "mean_confidence_percent": null,
      "drifting_baselines": null,
      "drift_monitoring": null,
      "drift_healthy": null,
      "drift_insufficient_data": null,
      "mean_model_confidence_percent": null,
      "fleet_risk": null,
      "window_hours": 24
    },
    "departures_by_dimension": [],
    "anomalies_by_day": [],
    "most_anomalous_identities": [],
    "peer_group_outliers": [],
    "recently_baselined": []
  }
}
```

### Data sources and calculations

#### Baseline cards

PostgreSQL `baselines` joined with the active identity source.

The discovery table and the monitoring baseline table do not use the same raw identity columns:

- `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>` uses discovery fields such as `identity_type` and `arn`.
- `<POSTGRES_SCHEMA>.baselines` uses the normalized monitoring key `(source_type, identity_name)`.
- The normalized discovery row contains both `identity_name` and `workload_key`. For Lambda and Step Functions, qualifiers/suffixes are removed from the canonical ARN; for shared workload baselines, the baseline builder may store the normalized `workload_key` in the baseline table's `identity_name` key. The API must therefore resolve an identity profile by normalized identity key first and by its normalized workload key when the runtime has intentionally shared the profile.

Therefore, **do not directly compare the raw discovery identity columns with the baseline identity key** in SQL. The discovery table does not provide the normalized monitoring key in that form.

Use the same two-step process as the pipeline:

```sql
-- Step 1: select the latest discovery snapshot for each stable resource.
WITH ranked AS (
    SELECT
        id,
        arn,
        name,
        identity_type,
        account_id,
        region,
        status,
        deleted_at,
        type_attributes,
        ROW_NUMBER() OVER (
            PARTITION BY identity_type, arn, account_id
            ORDER BY last_seen_at DESC NULLS LAST,
                     updated_at DESC NULLS LAST,
                     created_at DESC NULLS LAST,
                     id DESC
        ) AS row_rank
    FROM "<POSTGRES_SCHEMA>"."<POSTGRES_IDENTITY_TABLE>"
    WHERE deleted_at IS NULL
)
SELECT
    id,
    arn,
    name,
    identity_type,
    account_id,
    region,
    status,
    deleted_at,
    type_attributes
FROM ranked
WHERE row_rank = 1
  AND deleted_at IS NULL;
```

Normalize each returned row with the same rules as `app/identity_discovery.py`:

```text
source_type, identity_name, workload_key = normalize(discovery_row)
```

Then fetch monitoring baselines:

```sql
SELECT source_type, identity_name, status
FROM "<POSTGRES_SCHEMA>".baselines;
```

Finally, join in the API service using the normalized values:

```text
(source_type, normalized_identity_name)
```

If no baseline exists under that key, apply the same runtime fallback to:

```text
(source_type, normalized_workload_key)
```

The fallback is an application-level normalized-key lookup, not a raw discovery-to-baseline SQL join. This avoids joining a discovery scan-row ID or a raw ARN to the wrong baseline key. It also ensures that the dashboard counts the latest non-deleted discovery snapshot only; the meaning of its raw `status` value remains discovery-schema dependent.

`baseline_coverage_percent`:

```text
baselines_established / identities_watched * 100
```

Drift is now persisted by the current runtime. Read `drift_fleet_snapshots.stale_count` for the selected source/window and expose `identity_drift_scores.status` and `drift` for identity detail. If no drift run exists, return `null` with `drifting_baselines_available=false`; do not treat missing drift as zero.

#### Open and critical anomalies

- `open_anomalies`: count rows from PostgreSQL `alerts` where `status = 'open'`, scoped to the requested detection window.
- `critical_anomalies`: join those alert rows to the latest ClickHouse `log_events` version on `event_id` (bounded `FINAL` or an equivalent `argMax(..., ingested_at)` strategy) and count rows whose current event result has `event_risk_severity = 'Critical'` and `risk_status = 'scored'`.

`alerts.score` is a dimension anomaly score in the 0–1 range. It is **not** a stored alert severity and must not be silently treated as the event severity. If the ClickHouse event row is missing or has no scored severity, return the severity as unavailable.

There is no alert-level `severity` column on PostgreSQL `alerts`. **[NEEDS TO BE ADDED only if historical alert severity must be stored independently of the ClickHouse event row.]**

#### Anomaly departures currently available

The pipeline does **not** store a normalized dashboard `departure_type`. It stores the exact baseline dimension in `alerts.dimension`.

Return the stored dimension without inventing a product label:

```sql
SELECT dimension, count(*) AS count
FROM "<POSTGRES_SCHEMA>".alerts
WHERE status = 'open'
  AND created_at >= $1
  AND created_at < $2
GROUP BY dimension
ORDER BY count DESC;
```

The dimension names produced by the current `app/dimensions.py` and alerting code include:

```text
api_service
api_operation
region
read_write
result
error_code
source_network_class
user_agent_family
recipient_account
hour_of_week_utc
issuer_type
event_category
resource_pattern
resource_type
frequency                 -- created by frequency alerting
```

Additional dimensions can occur for specific sources:

```text
ECS:
timing
source_ip
user_agent
errors
resources
cluster_name
launch_type
task_definition_family

Non-ECS:
cross_account
ec2_role_delivery       -- only when present in the event
ec2_issued_in_vpc        -- only when present in the event

Step Functions:
state_machine_name
execution_status
execution_started
execution_stopped
execution_input_reference
execution_output_reference
```

`privilege_escalation`, `dormant_wake`, `new_api`, `new_region`, `new_resource`, `off_hours`, and `volume_spike` are **not current stored departure types**. `privileged_api_operation` is a risk reason produced by risk scoring for qualifying IAM/STS/KMS operations; it is not an `alerts.dimension` or departure type. A future API may map a dimension/reason to a display label only after that product mapping is confirmed. Do not return those values as if they came from the current pipeline.

**[NEEDS TO BE ADDED: normalized `departure_type` if the dashboard must filter or group using labels rather than the stored dimension.]**

#### Most anomalous identities

Use PostgreSQL `identity_risk_scores`:

```sql
SELECT DISTINCT ON (source_type, identity_name)
    source_type,
    identity_name,
    risk_score,
    severity,
    score_status,
    event_count,
    anomalous_event_count,
    window_start,
    window_end,
    computed_at
FROM "<POSTGRES_SCHEMA>".identity_risk_scores
WHERE window_end <= now()
ORDER BY source_type, identity_name, window_end DESC, computed_at DESC;
```

Join the result to `identities` for `display_name`, `account_id`, `region`, and workload metadata. Return the top 10 by `risk_score`.

#### Recently baselined

Use `baselines.active_since` and `baseline_versions.published_at`. Return the most recent 10 identities where the baseline became active or a new version was published.

#### Peer-group outliers

For the MVP, derive a peer key from stable identity fields:

```text
peer_key = source_type + account_id + region + service_name + cluster_name + role_type
```

Compare each identity's recent anomaly count and risk score to the peer group.

**[SCHEMA GAP: there is no explicit peer_group column or peer_groups table. Add one if product-managed peer groups are required.]**

---

## 4.2 `GET /api/v1/dashboard/activity`

Powers the fleet charts:

- Call volume over time.
- Anomalies per day.
- Optional source/account/region filters.

### Response

```json
{
  "data": {
    "call_volume": [
      {"bucket": "2026-10-09T00:00:00Z", "calls": 1520}
    ],
    "anomalies": [
      {"bucket": "2026-10-09", "count": 31}
    ]
  }
}
```

### Source and query

Use ClickHouse `log_events` with a bounded time range. Count distinct `event_id`, not physical rows, because `ReplacingMergeTree` can contain replacement versions.

```sql
SELECT
    toStartOfDay(event_time) AS bucket,
    uniqExact(event_id) AS calls
FROM <CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE>
WHERE event_time >= {from:DateTime64(3)}
  AND event_time < {to:DateTime64(3)}
  AND is_resolved = 1
  AND ({source_type:String} = '' OR source_type = {source_type:String})
  AND ({account_id:String} = '' OR account_id = {account_id:String})
  AND ({region:String} = '' OR region = {region:String})
GROUP BY bucket
ORDER BY bucket;
```

For a small dashboard window, `uniqExact` is acceptable. For a large fleet window, use a pre-aggregated materialized view later. **[PERFORMANCE GAP: no dashboard rollup table currently exists.]**

---

## 5. Identity endpoints

The screenshots use the identity page for ECS, Lambda, and Step Functions examples. The same response shape should work for EC2 and Glue.

## 5.1 `GET /api/v1/identities`

### Query parameters

```text
source_type=ECS
search=svc-telemetry
account_id=123456789012
region=ap-south-1
status=...                 raw discovery lifecycle status; exact values NEED CONFIRMATION
sort=risk_desc|last_seen_desc|name_asc
limit=25
cursor=...
```

### Response item

```json
{
  "id": "ECS:arn:aws:ecs:ap-south-1:123456789012:task/prod-platform/7d9f4b6e2c1a4e3b8d7f6a5b4c3d2e1f",
  "source_type": "ECS",
  "identity_name": "arn:aws:ecs:ap-south-1:123456789012:task/prod-platform/7d9f4b6e2c1a4e3b8d7f6a5b4c3d2e1f",
  "display_name": "svc-telemetry-writer",
  "workload_key": "ecs:123456789012:ap-south-1:prod-platform:svc-telemetry-writer:...",
  "status": null,
  "account_id": "123456789012",
  "region": "ap-south-1",
  "service_name": "svc-telemetry-writer",
  "role_type": "task",
  "role_arn": "arn:aws:iam::123456789012:role/orders-task-role",
  "baseline": {
    "status": "active",
    "built_days": 30,
    "required_days": 30
  },
  "risk": {
    "score": 63,
    "severity": "Medium",
    "status": "scored"
  },
  "last_seen": "2026-10-13T10:25:00Z",
  "open_anomaly_count": 1,
  "provenance_confidence": 4
}
```

### Query plan

1. Select the latest discovery snapshot per `(identity_type, arn, account_id)`, exclude rows with non-null `deleted_at` as the current runtime does, normalize each row with `app/identity_discovery.py`, apply any raw `status` filter only after confirming the discovery lifecycle values, and then page the result.
2. Join the latest `baselines` row by `(source_type, identity_name)` in application code or from a normalized working set; do not join the raw discovery table directly on `identity_name`.
3. Join the latest `identity_risk_scores` row.
4. Query ClickHouse only for `last_seen` and event counts when needed.
5. Query open anomaly counts in one grouped PostgreSQL query, not once per identity.

Do not load the full event history for this endpoint.

---

## 5.2 `GET /api/v1/identities/{source_type}/{identity_name}`

Use URL encoding for `identity_name`, especially for ARNs.

### Response sections

```json
{
  "data": {
    "identity": {},
    "risk": {},
    "baseline_summary": {},
    "baseline_health": {
      "status": "healthy",
      "drift": 0.08,
      "model_confidence_percent": 84.0,
      "verdict_trust": 91.0,
      "window_end": "2026-10-16T00:00:00Z"
    },
    "headline_metrics": {
      "calls_in_window": 11700,
      "open_anomalies": 1,
      "last_seen": "2026-10-13T10:25:00Z"
    },
    "links": {
      "activity": "/api/v1/identities/ECS/.../activity",
      "genome": "/api/v1/identities/ECS/.../genome",
      "baseline": "/api/v1/identities/ECS/.../baseline",
      "timeline": "/api/v1/identities/ECS/.../timeline"
    }
  }
}
```

### Tables

- Identity fields: `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>`.
- Baseline state: `baselines`.
- Latest risk: `identity_risk_scores`.
- Headline call count and last seen: ClickHouse `log_events`.
- Open anomaly count: `alerts`.

---

## 5.3 `GET /api/v1/identities/{source_type}/{identity_name}/activity`

Powers the Activity tab shown in the screenshots.

### Query parameters

```text
from=2026-09-26T00:00:00Z
 to=2026-10-10T00:00:00Z
bucket=day|hour
recent_limit=25
recent_cursor=...
```

### Response

```json
{
  "data": {
    "volume": [
      {"bucket": "2026-10-01", "calls": 1425}
    ],
    "recent_calls": [
      {
        "event_id": "evt-123",
        "event_time": "2026-10-13T10:25:00Z",
        "api_call": "dynamodb:Query",
        "resource": "kms/svc-telemetry-writer-events",
        "source_ip": "10.0.83.21",
        "region": "ap-south-1",
        "risk_status": "scored",
        "risk_score": 0
      }
    ],
    "total_calls": 11700
  }
}
```

### Call-volume query

```sql
SELECT
    toStartOfDay(event_time) AS bucket,
    uniqExact(event_id) AS calls
FROM <CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE>
WHERE identity_name = {identity_name:String}
  AND source_type = {source_type:String}
  AND event_time >= {from:DateTime64(3)}
  AND event_time < {to:DateTime64(3)}
GROUP BY bucket
ORDER BY bucket;
```

### Recent-calls query

For recent detail, use `FINAL` only on the bounded time range:

```sql
SELECT
    event_id,
    event_time,
    event_name,
    event_source,
    request_id,
    source_ip,
    region,
    resource_arns,
    risk_status,
    event_risk_score,
    event_risk_severity,
    provenance_confidence
FROM <CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE> FINAL
WHERE identity_name = {identity_name:String}
  AND source_type = {source_type:String}
  AND event_time >= {from:DateTime64(3)}
  AND event_time < {to:DateTime64(3)}
ORDER BY event_time DESC, event_id DESC
LIMIT {limit:UInt32};
```

Return only the columns needed by the table. Do not return full `request_parameters` in the list endpoint.

---

## 5.4 `GET /api/v1/identities/{source_type}/{identity_name}/genome`

Powers the behavioural fingerprint, typical actions, and resource sections.

### Response

```json
{
  "data": {
    "fingerprint": [
      {"dimension": "api_operation", "value": "dynamodb:Query", "share_percent": 24}
    ],
    "typical_actions": [
      {"api_operation": "cloudwatch:PutMetricData", "calls": 12604, "share_percent": 24}
    ],
    "typical_resources": [
      {"resource": "kms/svc-telemetry-writer-events", "resource_type": "KMS key", "calls": 13959}
    ],
    "activity_schedule": [
      {"day_of_week": 1, "hour": 14, "calls": 80}
    ]
  }
}
```

### Source and aggregation

Use ClickHouse `dimensions_json` for categorical dimensions. The API may parse these JSON keys:

- `api_operation`
- `api_service`
- `region`
- `read_write`
- `result`
- `resource_type`
- `resource_pattern`
- `source_network_class`
- `user_agent_family`
- `hour_of_week_utc`
- `timing`
- ECS: `cluster_name`, `launch_type`, `task_definition_family`
- Step Functions: `state_machine_name`, `execution_status`

The current ClickHouse schema stores `dimensions_json` as a string. Parse it in the API or add a materialized JSON projection later. **[PERFORMANCE GAP: JSON dimension aggregation is more expensive than typed columns.]**

For typical actions, aggregate `event_name + event_source` from ClickHouse. For typical resources, aggregate `resource_arns`; split the comma-separated value before counting.

For the activity schedule:

```sql
SELECT
    toDayOfWeek(event_time) AS day_of_week,
    toHour(event_time) AS hour,
    uniqExact(event_id) AS calls
FROM <CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE>
WHERE identity_name = {identity_name:String}
  AND source_type = {source_type:String}
  AND event_time >= {from:DateTime64(3)}
  AND event_time < {to:DateTime64(3)}
GROUP BY day_of_week, hour
ORDER BY day_of_week, hour;
```

---

## 5.5 `GET /api/v1/identities/{source_type}/{identity_name}/baseline`

Powers the baseline provenance panel.

### Response

```json
{
  "data": {
    "status": "active",
    "required_days": 30,
    "built_days": 30,
    "days_remaining": 0,
    "first_seen_date": "2026-07-13",
    "active_since": "2026-07-13T13:38:00Z",
    "updated_at": "2026-10-12T13:38:00Z",
    "data_points": null,
    "model_confidence_percent": null,
    "model_confidence_available": false,
    "dimensions": [],
    "versions": []
  }
}
```

### Tables

- Current state and profile: `baselines.profile_json`.
- Version history: `baseline_versions.profile_json`.
- Daily data points: `daily_stats.event_count` summed over the baseline window.
- Event provenance confidence: `log_events.provenance_confidence` when an event-level value is requested; the baseline table/profile has no model-confidence field. Do not derive a percentage from baseline coverage or provenance confidence.

Never return the complete raw profile if it contains internal counters. Return only safe dimension summaries and counts.

---

## 5.6 `GET /api/v1/identities/{source_type}/{identity_name}/timeline`

Powers the timeline shown in the screenshots.

### Response

```json
{
  "data": {
    "items": [
      {
        "type": "anomaly",
        "title": "1 active anomaly",
        "description": "Dimension: api_operation; reason from alerts.reason",
        "occurred_at": "2026-10-13T02:00:00Z",
        "status": "open"
      },
      {
        "type": "baseline_version_published",
        "title": "Baseline version published",
        "description": "Baseline version metadata from baseline_versions",
        "occurred_at": "2026-10-12T13:38:00Z"
      },
      {
        "type": "learning_started",
        "title": "Learning started",
        "occurred_at": "2026-07-13T13:38:00Z"
      },
      {
        "type": "baseline_established",
        "title": "Baseline established",
        "occurred_at": "2026-08-12T13:38:00Z"
      }
    ]
  }
}
```

### Derivation

- `anomaly`: `alerts.created_at` joined by identity.
- `baseline_version_published`: `baseline_versions.published_at`.
- `learning_started`: `baselines.first_seen_date`.
- `baseline_established`: `baselines.active_since`.

**[SCHEMA GAP: there is no immutable timeline/event-history table. This endpoint derives timeline entries from current tables. If an audit-grade timeline is required, add an append-only `identity_timeline_events` table.]**

---

## 5.7 `GET /api/v1/identities/{source_type}/{identity_name}/peers`

### MVP peer logic

Derive the peer key from:

```text
source_type + account_id + region + service_name + cluster_name + role_type
```

Query active identities with the same derived key. For each peer return:

```json
{
  "identity_name": "arn:aws:ecs:ap-south-1:123456789012:task/prod-platform/7d9f4b6e2c1a4e3b8d7f6a5b4c3d2e1f",
  "display_name": "svc-telemetry-writer",
  "risk_score": 63,
  "open_anomaly_count": 1,
  "recent_call_count": 11700,
  "outlier_dimension": "api_operation"
}
```

Use one grouped query for all peer anomaly counts. Do not issue one query per peer.

---


## 5.8 Drift endpoints

### `GET /api/v1/dashboard/drift`

Powers fleet model-health cards and drift trends. Read `drift_fleet_snapshots` by `source_type` and `window_end`; return `stale_count`, `monitor_count`, `healthy_count`, `insufficient_count`, `data_quality_count`, `mean_confidence`, `mean_drift`, `mean_identity_risk`, `fleet_risk`, `tests_run`, and `expected_false_positives`. Missing snapshots return `data_available=false`, not zero values.

### `GET /api/v1/identities/{source_type}/{identity_name}/drift`

Powers the identity baseline-health panel. Read the latest `identity_drift_scores` row and related `identity_dimension_drift` rows. Return:

```json
{
  "data": {
    "status": "monitor",
    "drift": 0.14,
    "raw_drift": 0.16,
    "model_confidence_percent": 84.0,
    "verdict_trust": 78.0,
    "retraining_status": "not_required",
    "psi_max": 0.31,
    "psi_max_dimension": "api_operation",
    "reasons": ["api_operation:0.310"],
    "dimensions": []
  }
}
```

`drift` is model-health evidence. It must not be presented as an event risk score. `insufficient_data` has `drift: null`; null is not zero.


## 6. Anomaly endpoints

## 6.1 `GET /api/v1/anomalies`

Powers the anomaly list screen and its filters.

### Query parameters

```text
severity=Critical|High|Medium|Low   filter joined ClickHouse event_risk_severity; not stored on alerts
dimension=api_operation       one exact `alerts.dimension` value from the supported list above
state=open                            current stored state; other workflow states are pending
source_type=ECS
search=svc-identity
from=2026-10-01T00:00:00Z
to=2026-10-13T00:00:00Z
limit=25
cursor=...
```

### Response item

```json
{
  "id": 12345,
  "identity": {
    "source_type": "LAMBDA",
    "identity_name": "arn:aws:lambda:ap-south-1:123456789012:function:svc-identity-api",
    "display_name": "svc-identity-api"
  },
  "what_changed": "iam:PassRole was observed outside the stored baseline",
  "dimension": "api_operation",
  "provenance_confidence": 3,
  "severity": "Medium",
  "state": "open",
  "detected_at": "2026-10-13T07:30:00Z",
  "region": "ap-south-1"
}
```

### Query plan

1. Read a page of rows from PostgreSQL `alerts`, ordered by `created_at DESC, id DESC`.
2. Join `alert_feedback` in PostgreSQL where available.
3. Fetch matching event details from ClickHouse using `event_id IN (...)`.
4. Join identity display fields from the identity table.

Do not query ClickHouse once per alert.

Current `alerts` columns used:

```text
id, source_type, identity_name, event_id, request_id, dimension,
score, reason, baseline_value, observed_value, identity_metadata,
window_start, window_end, status, created_at
```

### Disposition state limitation

The current schema supports:

- `alerts.status`, currently written as `open` by the pipeline.
- `alert_feedback.decision`, which is a reviewer classification: `legitimate`, `malicious`, or `unknown`.

Do not convert reviewer classifications into workflow states automatically. For example, `malicious` does not mean that the alert is resolved, and `legitimate` does not mean that it is acknowledged or suppressed.

`acknowledged`, `expected`, `suppressed`, and `resolved` are not current stored workflow states.

**[NEEDS TO BE ADDED: an additive `alert_dispositions` or append-only `alert_actions` table for full workflow support. Do not overload `alert_feedback` for all workflow states.]**

---

## 6.2 `GET /api/v1/anomalies/{alert_id}`

Powers the evidence drawer shown in the screenshots.

### Response

```json
{
  "data": {
    "id": 12345,
    "identity": {},
    "what_changed": {
      "dimension": "region",
      "baseline": {},
      "observed": {}
    },
    "why_this_is_graded": null,
    "provenance_confidence": 4,
    "severity": "High",
    "state": "open",
    "detail": {
      "account_id": "123456789012",
      "region": "ap-south-1",
      "api": "lambda:InvokeFunction",
      "resource": "s3://svc-sessions-sync-prod",
      "source_ip": "10.0.204.18",
      "detected_at": "2026-10-09T03:28:00Z"
    },
    "evidence": {
      "event_id": "evt-123",
      "request_id": "req-123",
      "baseline_value": {},
      "observed_value": {},
      "risk_components": []
    }
  }
}
```

### Tables

- Alert core: PostgreSQL `alerts`.
- Feedback/state: PostgreSQL `alert_feedback` and future disposition table.
- Event detail: ClickHouse `log_events` by `event_id`.
- Baseline comparison: `alerts.baseline_value` and `alerts.observed_value`.
- Risk components: ClickHouse `risk_components_json` or `risk_reasons_json`.

Do not expose full `request_parameters` by default. Return redacted request data only when the detail view needs it.

---

## 6.3 `GET /api/v1/anomalies/{alert_id}/evidence`

This is the explicit evidence endpoint for the evidence drawer. The anomaly detail endpoint may return a compact summary; this endpoint returns the complete, redacted evidence needed when the user opens the drawer.

### Query parameters

```text
include_request_parameters=true|false   default false
include_raw_risk=true|false             default false
```

### Response

```json
{
  "data": {
    "alert_id": 12345,
    "event": {
      "event_id": "evt-123",
      "event_time": "2026-10-13T07:30:00Z",
      "event_source": "iam.amazonaws.com",
      "event_name": "PassRole",
      "request_id": "req-123",
      "account_id": "123456789012",
      "region": "ap-south-1",
      "source_ip": "10.0.204.18",
      "user_agent": "aws-sdk-python",
      "resource_arns": "arn:aws:iam::123456789012:role/example"
    },
    "comparison": {
      "dimension": "api_operation",
      "reason": "new categorical value",
      "baseline_value": {"cloudwatch:PutMetricData": 100},
      "observed_value": {"iam:PassRole": "iam:PassRole"},
      "score_0_1": 0.72
    },
    "risk": {
      "status": "scored",
      "score": 72,
      "severity": "High",
      "reasons": ["privileged_api_operation"],
      "components": []
    },
    "feedback": {
      "decision": "unknown",
      "reviewer": null,
      "reason": null,
      "approved_for_baseline": false
    }
  }
}
```

### Exact sources

- `event.*`: ClickHouse `log_events` columns named in section 10.4, looked up by `event_id`.
- `comparison.*`: PostgreSQL `alerts.dimension`, `alerts.reason`, `alerts.baseline_value`, `alerts.observed_value`, and `alerts.score`.
- `risk.*`: ClickHouse `event_risk_score`, `event_risk_severity`, `risk_status`, `risk_reasons_json`, and `risk_components_json`.
- `feedback.*`: PostgreSQL `alert_feedback` by `(source_type, event_id)`.

The endpoint must redact secrets and sensitive request fields. `request_parameters` is a ClickHouse string and is not returned unless the product confirms a redaction policy. The runtime redaction policy is implemented in app/redaction.py; the API must not bypass it.

## 6.4 `POST /api/v1/anomalies/{alert_id}/feedback`

This is the only anomaly write operation currently supported by the pipeline schema.

### Request

```json
{
  "decision": "legitimate",
  "approved_for_baseline": false,
  "reason": "Approved deployment"
}
```

Allowed values:

```text
decision: legitimate | malicious | unknown
approved_for_baseline: true | false
```

The backend obtains the reviewer identity from authentication. It writes one current row to PostgreSQL `alert_feedback` using `(source_type, event_id)`.

### Storage

- `alert_feedback.decision`
- `alert_feedback.approved_for_baseline`
- `alert_feedback.reviewer`
- `alert_feedback.reason`
- `alert_feedback.baseline_version`
- `alert_feedback.created_at`
- `alert_feedback.updated_at`

This does not change `alerts.status` and does not immediately modify the active baseline.

## 6.5 `POST /api/v1/anomalies/{alert_id}/disposition`

This endpoint is a screenshot/product requirement, not a current pipeline capability.

```json
{
  "available": false,
  "reason": "NEEDS TO BE ADDED: no disposition history table"
}
```

The current schema cannot safely persist independent `acknowledge`, `expected`, `resolve`, and `suppress` actions. Add an append-only disposition/action table only after those states are confirmed.

---

## 7. Containment endpoints

The screenshots imply a containment area and a **Freeze credential** action. The current pipeline does not yet persist or execute containment actions, so the read endpoints must report that the feature is unavailable until the additive storage and worker are approved.

## 7.1 `GET /api/v1/containment`

Lists recent containment requests.

### Query parameters

```text
state=requested|running|succeeded|failed|cancelled
source_type=ECS
identity_name=...
from=2026-10-01T00:00:00Z
to=2026-10-13T00:00:00Z
limit=25
cursor=...
```

### Response while the feature is not implemented

```json
{
  "data": {
    "items": [],
    "available": false,
    "message": "Containment actions are not persisted by the current pipeline"
  }
}
```

**[NEEDS TO BE ADDED: `credential_actions` or `containment_actions` table.]**

## 7.2 `GET /api/v1/identities/{source_type}/{identity_name}/containment`

Returns the latest containment status for the identity.

```json
{
  "data": {
    "available": false,
    "active": false,
    "latest_action": null
  }
}
```

Do not infer that an identity is contained merely because it has an open anomaly. Those are separate concepts.

## 7.3 `POST /api/v1/identities/{source_type}/{identity_name}/containment/freeze`

This powers the **Freeze credential** button.

### Request

```json
{
  "reason": "Confirmed malicious activity",
  "requested_by": "alice@example.com",
  "dry_run": true
}
```

### Response

```json
{
  "data": {
    "action_id": "act_01J...",
    "status": "requested",
    "dry_run": true,
    "message": "Freeze request accepted for asynchronous processing"
  }
}
```

This API must not call IAM synchronously from the HTTP request. It should create an asynchronous command for a worker and return `202 Accepted`.

**[NEEDS TO BE ADDED: no credential-action/outbox table or IAM action worker exists in the current pipeline. Add an additive `credential_actions` table with `action_id`, identity key, requested action, requester, status, timestamps, provider request ID, and error message.]**

---

## 8. WebSocket design

A WebSocket is useful for **notifications**, not for initial dashboard data.

### Endpoint

```text
GET /api/v1/ws
```

### Client subscribe message

```json
{
  "type": "subscribe",
  "channels": [
    "dashboard",
    "identity:ECS:arn:aws:ecs:ap-south-1:123456789012:task/prod-platform/7d9f4b6e2c1a4e3b8d7f6a5b4c3d2e1f"
  ],
  "filters": {
    "source_type": "ECS",
    "account_id": "123456789012",
    "region": "ap-south-1"
  }
}
```

### Server events

```json
{
  "type": "anomaly.created",
  "sequence": 1842,
  "occurred_at": "2026-10-13T10:25:00Z",
  "data": {
    "alert_id": 12345,
    "source_type": "ECS",
    "identity_name": "arn:aws:ecs:ap-south-1:123456789012:task/prod-platform/7d9f4b6e2c1a4e3b8d7f6a5b4c3d2e1f",
    "severity": "Medium"
  }
}
```

Recommended event types:

```text
anomaly.created
anomaly.updated
baseline.updated
identity.activity
credential_action.updated
```

### Efficient implementation

- Initial page load always uses HTTP.
- WebSocket messages contain IDs and small summaries, not full event histories.
- The frontend refetches the affected resource after receiving a notification.
- Use one connection per browser tab.
- Apply backpressure and coalesce repeated `identity.activity` events.
- Send a heartbeat every 30 seconds.
- Use a short polling fallback if the connection drops.

**[SCHEMA/INFRA GAP: the current pipeline has no API WebSocket gateway or event fan-out/outbox. Add Redis Pub/Sub or an `api_outbox` table only when live push is required. Polling is simpler for the first release.]**

---

## 9. Table and column reference

### PostgreSQL monitoring tables

| Table | API use |
|---|---|
| `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>` | Canonical discovery identities and metadata; read-only to monitoring |
| `baselines` | Current baseline status and profile |
| `baseline_versions` | Baseline history and model retraining timeline |
| `daily_stats` | Daily baseline training counts and dimensions |
| `alerts` | Dimension-level anomaly records |
| `alert_feedback` | Reviewer decision and baseline approval |
| `identity_risk_scores` | Latest identity/window risk score |
| `event_processing_log` | Processing/idempotency state; not a dashboard event table |
| `ecs_task_registry` | ECS task-incarnation lookup; not a general identity source |
| `identity_drift_scores` | Per-identity/window baseline health, drift, retraining lifecycle, verdict trust and explanation |
| `identity_dimension_drift` | Per-dimension PSI/JSD/G-test evidence and contribution |
| `drift_feedback_stats` | False-positive damping evidence from reviewer feedback |
| `drift_config` | Global/source/identity drift configuration overrides |
| `drift_fleet_snapshots` | Fleet drift counts, model confidence, fleet risk and data-quality rollup |

### ClickHouse table

`<CLICKHOUSE_DATABASE>.<CLICKHOUSE_EVENTS_TABLE>` columns used by APIs:

```text
event_id
source_type
identity_name
is_resolved
event_risk_score
event_risk_severity
risk_status
risk_reasons_json
risk_components_json
provenance_confidence
event_time
account_id
region
source_ip
user_agent
event_name
event_source
error_code
error_message
request_id
request_parameters
resource_arns
dimensions_json
task_id
role_type
cluster_name
service_name
task_definition
instance_id
instance_arn
instance_profile_arn
role_arn
role_principal_id
role_kind
ingested_at
display_name
workload_key
```

### Do not use these tables for dashboard reads

- `event_processing_log` for activity history.
- `daily_stats` for recent calls.
- `baseline_versions` for live anomaly counts.
- `ecs_task_registry` for generic identities.
- `drift_fleet_snapshots` as an event/anomaly table; it is model-health rollup only.
- Raw discovery rows without selecting the latest snapshot.

---

## 10. Exact response-field mapping

The following tables are the implementation source of truth for response fields. `API formula` means the field is calculated from the named database columns. `NEEDS CONFIRMATION` means the column exists but the product meaning or display rule still needs agreement. `NEEDS TO BE ADDED` means the current schema cannot provide the field exactly.

### 10.1 Dashboard response fields

| Response field | Current source or formula |
|---|---|
| `cards.identities_watched` | Count latest normalized discovery rows where `deleted_at IS NULL`; do not assume a particular discovery `status` string until the external lifecycle enum is confirmed |
| `cards.baselines_established` | Active `baselines` rows matched to the latest normalized discovery set by `(source_type, identity_name)`, with the documented normalized `workload_key` fallback for shared profiles |
| `cards.still_learning` | Count latest non-deleted normalized discovery identities for which neither the normalized identity key nor the normalized workload-key fallback has an active baseline; do not subtract raw baseline-row counts when a profile is shared |
| `cards.open_anomalies` | `COUNT(*)` from `alerts` where `status = 'open'` and `created_at` is in the requested window |
| `cards.critical_anomalies` | Join `alerts.event_id` to `log_events.event_id`; count open alerts whose `log_events.event_risk_severity = 'Critical'` and `risk_status = 'scored'` |
| `cards.baseline_coverage_percent` | `baselines_established / identities_watched * 100` |
| `cards.mean_provenance_confidence` | `AVG(log_events.provenance_confidence)` over the selected event window; raw pipeline scale is retained |
| `cards.mean_confidence_percent` | `drift_fleet_snapshots.mean_confidence` is the model-confidence percentage for the selected drift window; do not derive it from event provenance confidence |
| `cards.drifting_baselines` | `drift_fleet_snapshots.stale_count` for the selected source/window; use `insufficient_count` separately |
| `cards.drift_monitoring` | `drift_fleet_snapshots.monitor_count` |
| `cards.drift_healthy` | `drift_fleet_snapshots.healthy_count` |
| `cards.drift_insufficient_data` | `drift_fleet_snapshots.insufficient_count`; absence of a snapshot is not zero |
| `cards.mean_model_confidence_percent` | `drift_fleet_snapshots.mean_confidence` |
| `cards.fleet_risk` | `drift_fleet_snapshots.fleet_risk` |
| `cards.window_hours` | API query/default, not a database field |
| `departures_by_dimension[].dimension` | Exact value from `alerts.dimension` |
| `departures_by_dimension[].count` | `COUNT(*)` from `alerts` grouped by `alerts.dimension` |
| `anomalies_by_day.day` | PostgreSQL `DATE_TRUNC('day', alerts.created_at)` for alert counts (or ClickHouse `toDate(event_time)` only for an event-backed series) |
| `anomalies_by_day.count` | `COUNT(*)` from `alerts` grouped by detection day |
| `most_anomalous_identities.identity_name` | `identity_risk_scores.identity_name` |
| `most_anomalous_identities.risk_score` | latest `identity_risk_scores.risk_score` per identity |
| `most_anomalous_identities.severity` | latest `identity_risk_scores.severity` |
| `peer_group_outliers.*` | Derived from `identities` fields plus `identity_risk_scores`, `alerts`, and ClickHouse event counts; explicit peer group is **NEEDS TO BE ADDED** |
| `recently_baselined.*` | `baselines.active_since` and `baseline_versions.published_at`, joined to `identities` |

### 10.2 Identity response fields

| Response field | Current source or formula |
|---|---|
| `id` | API formula: `source_type + ':' + identity_name`; not stored as one column |
| `source_type` | Compact API source family mapped from `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.identity_type`; it remains within the existing 16-character storage limit |
| `nhi_identity_type` | Normalized active registry subtype retained in identity metadata (for example `codebuild_project` or `sagemaker_training_job`); deferred, excluded, and human types are empty/rejected |
| `identity_name` | Canonicalized discovery ARN when stable, otherwise a typed account/region/resource key; the discovery row `id` and human actor name must not be used as the stable identity key |
| `display_name` | Normalizer output from `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.name`, falling back to canonical ARN or the normalized fallback key; final event-side fallback is ClickHouse `log_events.display_name` |
| `workload_key` | Derived from `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.account_id`, `region`, `identity_type`, `arn`, and selected `type_attributes`; ClickHouse fallback is `log_events.workload_key` |
| `status` | Raw `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.status`; lifecycle values and any API filter mapping are **NEEDS CONFIRMATION**. Current runtime excludes `deleted_at IS NOT NULL`. |
| `account_id` | `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.account_id` |
| `region` | `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.region` |
| `service_name` | Derived from `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.type_attributes` (`service_name`, `service`, or serverless resource name) |
| `role_type` | Normalizer output: `EC2_INSTANCE_PROFILE` for EC2; otherwise `type_attributes.role_type` when present |
| `role_arn` | First matching role ARN in `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>.type_attributes` (`bound_role_arn`, `role_arn`, `task_role_arn`, `execution_role_arn`, service-specific role keys) |
| `baseline.status` | `baselines.status` |
| `baseline.built_days` | `baselines.built_days` |
| `baseline.required_days` | `baselines.required_days` |
| `risk.score` | latest `identity_risk_scores.risk_score` |
| `risk.severity` | latest `identity_risk_scores.severity` |
| `risk.status` | latest `identity_risk_scores.score_status` |
| `baseline_health.status` | latest `identity_drift_scores.status` for the identity/window; values include `healthy`, `monitor`, `stale`, `insufficient_data`, `data_quality_issue` |
| `baseline_health.drift` | latest `identity_drift_scores.drift`; NULL means insufficient data, never zero |
| `baseline_health.model_confidence_percent` | latest `identity_drift_scores.model_confidence` when available |
| `baseline_health.verdict_trust` | latest `identity_drift_scores.verdict_trust` when available |
| `last_seen` | `MAX(event_time)` from the latest ClickHouse row per `event_id` for the identity, resolved events only |
| `open_anomaly_count` | `COUNT(*)` from `alerts` where identity matches and `status = 'open'` |
| `provenance_confidence` | latest or average `log_events.provenance_confidence`; selection rule is **NEEDS CONFIRMATION** |
| `headline_metrics.calls_in_window` | `uniqExact(log_events.event_id)` in the requested ClickHouse window |

### 10.3 Activity, genome, and baseline fields

| Response field | Current source or formula |
|---|---|
| `activity.volume[].bucket` | ClickHouse `toStartOfDay(event_time)` or `toStartOfHour(event_time)` |
| `activity.volume[].calls` | ClickHouse `uniqExact(event_id)` |
| `activity.recent_calls[].event_id` | `log_events.event_id` |
| `activity.recent_calls[].event_time` | `log_events.event_time` |
| `activity.recent_calls[].api_call` | API formula: `event_source + ':' + event_name` |
| `activity.recent_calls[].resource` | `log_events.resource_arns`; API redacts/splits it for display |
| `activity.recent_calls[].source_ip` | `log_events.source_ip` |
| `activity.recent_calls[].region` | `log_events.region` |
| `activity.recent_calls[].risk_status` | `log_events.risk_status` |
| `activity.recent_calls[].risk_score` | `log_events.event_risk_score` |
| `activity.recent_calls[].request_id` | `log_events.request_id` when included in detail |
| `activity.total_calls` | `uniqExact(log_events.event_id)` over the same window |
| `genome.fingerprint[].dimension` | JSON key in `log_events.dimensions_json` |
| `genome.fingerprint[].value` | JSON value in `log_events.dimensions_json` |
| `genome.fingerprint[].share_percent` | `COUNT(DISTINCT event_id)` for value divided by all calls |
| `genome.typical_actions[].api_operation` | API formula from `log_events.event_source, event_name` |
| `genome.typical_actions[].calls` | grouped `uniqExact(log_events.event_id)` |
| `genome.typical_resources[].resource` | `log_events.resource_arns` |
| `genome.typical_resources[].resource_type` | `dimensions_json.resource_type`; **NEEDS CONFIRMATION** when the JSON key is missing |
| `genome.activity_schedule[].day_of_week` | ClickHouse `toDayOfWeek(log_events.event_time)` |
| `genome.activity_schedule[].hour` | ClickHouse `toHour(log_events.event_time)` |
| `genome.activity_schedule[].calls` | grouped `uniqExact(log_events.event_id)` |
| `baseline.status` | `baselines.status` |
| `baseline.required_days` | `baselines.required_days` |
| `baseline.built_days` | `baselines.built_days` |
| `baseline.days_remaining` | `baselines.days_remaining` |
| `baseline.first_seen_date` | `baselines.first_seen_date` |
| `baseline.active_since` | `baselines.active_since` |
| `baseline.updated_at` | `baselines.updated_at` |
| `baseline.data_points` | `SUM(daily_stats.event_count)` over the selected baseline window and the resolved normalized baseline key (identity key or shared workload-key fallback) |
| `baseline.model_confidence_percent` | Use `identity_drift_scores.model_confidence` for the latest drift window when available; the baseline profile `_meta` alone is not a confidence value. |
| `baseline.model_confidence_available` | `true` only when a current `identity_drift_scores` row has `model_confidence`; otherwise `false` |
| `baseline.dimensions` | `baselines.profile_json` safe dimension summaries, not the full JSON |
| `baseline.versions[].version` | `baseline_versions.version` |
| `baseline.versions[].published_at` | `baseline_versions.published_at` |
| `baseline.versions[].profile` | safe selected fields from `baseline_versions.profile_json` |

### 10.4 Anomaly and evidence fields

| Response field | Current source or formula |
|---|---|
| `id` | `alerts.id` |
| `identity.source_type` | `alerts.source_type` joined to canonical identity |
| `identity.identity_name` | `alerts.identity_name` |
| `identity.display_name` | canonical `identities.display_name`, falling back to `alerts.identity_metadata.display_name` |
| `what_changed` | `alerts.dimension`, `alerts.observed_value`, `alerts.baseline_value`, and `alerts.reason` |
| `dimension` | Exact `alerts.dimension` value |
| `provenance_confidence` | Latest `log_events.provenance_confidence` for `alerts.event_id`; use the latest `ingested_at` version and retain the raw pipeline scale |
| `confidence_percent` | **NEEDS TO BE ADDED/CONFIRMED:** the pipeline does not store a percentage confidence field |
| `severity` | `log_events.event_risk_severity` by `alerts.event_id` when `risk_status = 'scored'`; null/unavailable otherwise. Identity severity comes from `identity_risk_scores.severity`. `alerts.score` is not itself severity. |
| `state` | Current stored state is `alerts.status`; `alert_feedback.decision` is returned separately as reviewer feedback. Acknowledged/suppressed/resolved history is **NEEDS TO BE ADDED** |
| `detected_at` | `alerts.created_at` |
| `region` | `log_events.region` by `alerts.event_id`, falling back to `alerts.identity_metadata.region` |
| `account_id` | `log_events.account_id` by event ID, falling back to `alerts.identity_metadata.account_id` |
| `api` | API formula from `log_events.event_source` and `log_events.event_name` |
| `resource` | `log_events.resource_arns` |
| `source_ip` | `log_events.source_ip` |
| `baseline_value` | `alerts.baseline_value` |
| `observed_value` | `alerts.observed_value` |
| `request_id` | `alerts.request_id`, falling back to `log_events.request_id` |
| `risk_components` | `log_events.risk_components_json` parsed as JSON |
| `baseline_health` | `alerts.identity_metadata.baseline_health` or latest `identity_drift_scores.status` |
| `baseline_verdict_mode` | `alerts.identity_metadata.baseline_verdict_mode`; baseline-derived stale verdicts can be inconclusive |
| `verdict_trust` | `alerts.identity_metadata.verdict_trust` or latest `identity_drift_scores.verdict_trust` |
| `risk_reasons` | `log_events.risk_reasons_json` parsed as JSON, falling back to `alerts.reason` |
| `evidence.event_id` | `alerts.event_id` |
| `evidence.window_start` | `alerts.window_start` |
| `evidence.window_end` | `alerts.window_end` |

### 10.5 Timeline, peer, containment, and metadata fields

| Response field | Current source or formula |
|---|---|
| `timeline[].type` | API constant based on source table: `alerts`, `baseline_versions`, or `baselines` |
| `timeline[].title` | API display text from the timeline type |
| `timeline[].description` | source `alerts.reason` or selected baseline metadata; exact copy is **NEEDS CONFIRMATION** |
| `timeline[].occurred_at` | `alerts.created_at`, `baseline_versions.published_at`, `baselines.active_since`, or `baselines.first_seen_date` |
| `peers[].identity_name` | canonical `identities.identity_name` |
| `peers[].display_name` | canonical `identities.display_name` |
| `peers[].risk_score` | latest `identity_risk_scores.risk_score` |
| `peers[].open_anomaly_count` | grouped `COUNT(*)` from `alerts` where `status = 'open'` |
| `peers[].recent_call_count` | grouped `uniqExact(log_events.event_id)` |
| `peers[].outlier_dimension` | `alerts.dimension` for the dimension contributing to the peer comparison; exact outlier ranking is **NEEDS CONFIRMATION** |
| `containment.action_id` | **NEEDS TO BE ADDED:** future `credential_actions.action_id` or `alert_actions.action_id` |
| `containment.status` | **NEEDS TO BE ADDED:** future containment/action status |
| `containment.requested_by` | **NEEDS TO BE ADDED:** future action requester column |
| `containment.requested_at` | **NEEDS TO BE ADDED:** future action timestamp |
| `containment.provider_request_id` | **NEEDS TO BE ADDED:** future IAM/provider request ID |
| `meta.request_id` | API-generated request identifier |
| `meta.generated_at` | API-generated response timestamp |
| `meta.next_cursor` | API-generated opaque keyset cursor |

## 11. Performance checklist

1. Use one dashboard summary request with bounded parallel database queries instead of many frontend requests.
2. Cache dashboard summary for 15–30 seconds.
3. Cache identity header/baseline summaries for 30–60 seconds.
4. Use keyset pagination for anomalies and recent calls.
5. Page PostgreSQL alerts first, then fetch matching ClickHouse events using one `IN` query.
6. Never query ClickHouse once per row.
7. Always filter ClickHouse by `source_type`, `identity_name`, and time range when possible.
8. Count distinct `event_id`, not physical ClickHouse rows.
9. Use `FINAL` only for small recent-detail queries; use `argMax(..., ingested_at)` for aggregates.
10. Return summaries in list endpoints and fetch full evidence only from detail endpoints.
11. Do not return full request payloads, baseline profiles, or risk component arrays in list responses.
12. Keep all timestamps UTC.
13. Use `limit <= 100` for all lists.
14. Run independent PostgreSQL queries concurrently inside the backend request handler, but keep a bounded connection pool.
15. Prefer Redis for short-lived dashboard caching, never as the only source of truth.

### Recommended indexes if query volume grows

The current schema has useful identity, alert, baseline, and risk indexes. Add these only after measuring query plans:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_status_created_idx
    ON "<POSTGRES_SCHEMA>".alerts(status, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_source_identity_created_idx
    ON "<POSTGRES_SCHEMA>".alerts(source_type, identity_name, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS feedback_event_idx
    ON "<POSTGRES_SCHEMA>".alert_feedback(source_type, event_id);
```

**[SCHEMA CHANGE: these indexes are optional performance additions and are not required for the first API version.]**

For ClickHouse, the current table is ordered by `event_id`. Identity/time dashboard queries may need a projection or rollup later:

```text
identity_name, source_type, event_time, event_id,
api_operation, region, risk_status
```

**[PERFORMANCE GAP: add a ClickHouse projection/materialized view only after measuring the dashboard query latency.]**

---

## 12. First implementation order

A fresher backend engineer should implement in this order:

1. Shared response envelope and error handling.
2. `GET /api/v1/identities`.
3. `GET /api/v1/identities/{source_type}/{identity_name}`.
4. `GET /api/v1/anomalies`.
5. `GET /api/v1/anomalies/{alert_id}`.
6. Identity activity and genome endpoints.
7. Dashboard summary and dashboard activity aggregation.
8. Baseline and timeline endpoints.
9. Disposition endpoint after confirming the additive disposition-table design.
10. WebSocket notifications only if polling is not sufficient.
11. Credential freeze only after the IAM action worker and outbox contract are approved.

The first release should prioritize fast reads, clear evidence, and correct table ownership over implementing every action button immediately.

---


## 12.1 Current-runtime corrections applied in this contract

This contract is aligned to the current pipeline source as follows:

- Discovery defaults are `POSTGRES_SCHEMA=bimasugam` and `POSTGRES_IDENTITY_TABLE=identities`; the identity relation remains read-only and dynamically configurable.
- ClickHouse defaults are `CLICKHOUSE_DATABASE=ecs_nhi` and `CLICKHOUSE_EVENTS_TABLE=log_events`; the API must use configured identifiers and latest-row semantics.
- All 39 registry subtypes are listed in Section 3.1. Direct AWS SDK enrichment is not assumed for every subtype.
- Drift is available through `identity_drift_scores`, `identity_dimension_drift`, `drift_feedback_stats`, `drift_config`, and `drift_fleet_snapshots`. Missing drift data is `null`/insufficient, never zero.
- Risk, alert, and event fields are mapped to the current `risk_scoring.py`, `alerting.py`, and `clickhouse_store.py` behavior.
- The dashboard API is still not implemented in this repository; this file remains an implementation contract, not a live endpoint specification.

## 13. Final implementation checklist

### API foundation

- [ ] Confirm the API base path and authentication middleware.
- [ ] Use the common `{data, meta}` response envelope.
- [ ] Add request IDs to every response and log line.
- [ ] Validate and cap `limit`; reject unbounded date ranges.
- [ ] Treat all timestamps as UTC.
- [ ] URL-decode `identity_name` safely.
- [ ] Return `404` for an unknown identity or alert and `400` for invalid filters.

### Dashboard and identity reads

- [ ] Implement identity list with keyset pagination.
- [ ] Implement identity header with latest baseline and risk joins.
- [ ] Implement dashboard summary with bounded parallel queries.
- [ ] Implement dashboard volume and anomaly series.
- [ ] Implement activity recent calls and call-volume series.
- [ ] Implement genome actions, resources, dimensions, and schedule.
- [ ] Implement baseline provenance and version history.
- [ ] Implement the derived timeline.
- [ ] Implement peer comparison and document the derived peer key.

### Anomaly and evidence reads

- [ ] Implement PostgreSQL-first anomaly pagination.
- [ ] Batch-fetch ClickHouse event evidence for the page.
- [ ] Convert the current alert score consistently to display severity.
- [ ] Return baseline versus observed values.
- [ ] Parse risk reasons/components safely.
- [ ] Redact request parameters and sensitive values.
- [ ] Add tests for missing ClickHouse event rows and missing feedback rows.

### Actions and live data

- [ ] Confirm whether anomaly dispositions need `acknowledged`, `expected`, `suppressed`, and `resolved` as independent states.
- [ ] Do not implement credential freeze until its worker/outbox and authorization policy are approved.
- [ ] Start with polling for dashboard refresh.
- [ ] Add WebSocket/SSE fan-out only if live push is a confirmed requirement.

### Performance and correctness

- [ ] Use bounded ClickHouse date windows.
- [ ] Use `argMax(..., ingested_at)` or a measured `FINAL` query for ReplacingMergeTree reads.
- [ ] Count distinct `event_id`.
- [ ] Avoid N+1 queries.
- [ ] Add query-plan tests for dashboard summary and anomaly list.
- [ ] Add short Redis response caching without making Redis authoritative.
- [ ] Measure before adding projections, rollups, or indexes.
- [ ] Do not change existing pipeline tables or add migrations as part of this documentation task.

---

## 14. Unresolved items

These are intentionally visible rather than silently invented:

1. **Discovery identity columns:** confirm the external `<POSTGRES_SCHEMA>.<POSTGRES_IDENTITY_TABLE>` column types and whether any additional fields are required by monitoring.
2. **Dashboard confidence display:** confirm whether confidence is event provenance confidence, model confidence, or a separate percentage.
3. **Drifting baselines:** add a drift table/column and define the drift algorithm before showing a numeric card.
4. **Normalized departure types:** confirm the product taxonomy and decide whether to persist `departure_type` on an additive anomaly record.
5. **Alert severity:** confirm whether severity derived from `alerts.score` is sufficient or a persisted alert-level severity is required.
6. **Anomaly workflow states:** confirm the exact meaning of acknowledged, expected, suppressed, and resolved. Add an append-only disposition/action table rather than overloading `alert_feedback`.
7. **Peer groups:** confirm whether peer groups are derived from service/account/region fields or managed by users. A managed peer group needs a table or column.
8. **Baseline confidence and data points:** confirm the UI formula for `model_confidence_percent` and whether the data-point total is based on `daily_stats` or ClickHouse events.
9. **Timeline retention:** confirm whether a derived timeline is sufficient or whether an immutable timeline table is required.
10. **Evidence redaction:** confirm which request parameters, resource ARNs, IP addresses, and user-agent values may be shown to the viewer.
11. **Containment:** approve the action table, IAM permissions, asynchronous worker, dry-run behavior, and audit requirements before enabling freeze.
12. **Live updates:** confirm whether the product needs push notifications. Polling is the default until this is confirmed.
13. **ClickHouse performance:** benchmark identity/time queries against the current `ORDER BY (event_id)` before adding a projection or rollup.
14. **Authentication and authorization:** confirm the caller identity, tenant/account isolation rules, reviewer permissions, and whether the API can expose cross-account data.

Until an item is confirmed, the API should return an explicit `null`, `available: false`, or `needs_confirmation` field rather than manufacturing a value.
