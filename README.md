# K12Info serverless backend

This repository is the production source tree for the K12Info backend. It runs
as grouped Node.js AWS Lambda functions behind API Gateway, with MongoDB Atlas
as the application database, Amazon Cognito for identity, and DynamoDB for
WebSocket connection and subscription state.

The current HTTP contract is documented in [openapi.yaml](./openapi.yaml).
The WebSocket message protocol is described below because it is not modeled as
ordinary HTTP operations in OpenAPI.

## Architecture

API Gateway routes related operations to five cohesive Lambda functions:

| Lambda | Local handler | Responsibilities |
| --- | --- | --- |
| `K12InfoSchools` | `lambda/schools/handler.handler` | Base school records and public-school CRDC detail data |
| `K12InfoSearch` | `lambda/search/handler.handler` | Atlas Search, location results, and map-bound school queries |
| `K12InfoUsers` | `lambda/users/handler.handler` | MongoDB user-profile creation, lookup, username availability, and updates |
| `K12InfoComments` | `lambda/comments/handler.handler` | School comments, current-user comment history, mutations, and realtime notifications |
| `K12InfoWebSocket` | `lambda/websocket/handler.handler` | Authenticated WebSocket tickets plus API Gateway WebSocket lifecycle and subscriptions |

`lambda/shared/` contains API Gateway request normalization, routing,
authentication adapters, response formatting, and notification delivery.
Top-level `shared/` contains application services used across grouped Lambdas,
including MongoDB initialization, Cognito JWT verification, validation, search
pipelines, and comment cursors. These directories are both required in Lambda
packages; imports such as `../../shared/mongodb` depend on the top-level
`shared/` path remaining intact.

## Data and authentication

MongoDB Atlas remains authoritative for school, location, user-profile, and
comment data. Lambda runtimes load the production MongoDB URI from encrypted
SSM Parameter Store. Local development uses `MONGODB_URI`. Mongo clients,
connection promises, and collection handles are cached at module scope so warm
invocations reuse them.

Cognito access tokens are verified locally with `aws-jwt-verify`. Protected
HTTP routes require `Authorization: Bearer <access-token>`. Cognito identity and
the K12Info MongoDB profile are separate records connected by `cognito_sub`.
Comment mutations additionally require that the authenticated Cognito `sub`
still has a MongoDB user profile; this prevents a valid but stale JWT from
mutating comments after the application profile has been removed.

## WebSockets and realtime comments

The frontend obtains a connection credential through authenticated
`POST /api/websocket-ticket`. The backend generates a random, short-lived,
single-use ticket and stores it in DynamoDB. The access token itself is never
sent in the WebSocket URL.

On `$connect`, a client may omit the ticket and connect anonymously, or supply
the ticket to associate the connection with its Cognito `sub`. Authenticated
connections automatically receive a private user-topic subscription. Clients
may also send these API Gateway WebSocket actions:

```json
{"action":"subscribe-school","sector":"public","school_id":"<base-school-_id>"}
```

```json
{"action":"unsubscribe-school","sector":"public","school_id":"<base-school-_id>"}
```

The DynamoDB table stores connection metadata, school/user topic rows, a GSI
reverse lookup by connection, and Unix-seconds TTL values. Disconnect cleanup
is best effort because API Gateway does not guarantee `$disconnect` delivery;
TTL provides cleanup insurance.

After successful MongoDB comment creation or deletion, the Comments Lambda
broadcasts `comment-created` or `comment-deleted` to the school topic and the
author's user topic. Delivery is deliberately best effort: notification or
stale-connection cleanup failures cannot turn an already-committed comment
mutation into an HTTP failure.

## Configuration

Runtime configuration is read from environment variables with defaults in
`shared/config.js`. Relevant values include:

- `MONGODB_URI` for local development;
- `MONGODB_DATABASE` and MongoDB collection overrides;
- `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`;
- Atlas Search index overrides;
- `WEBSOCKET_STATE_TABLE`;
- `WEBSOCKET_MANAGEMENT_ENDPOINT`.

Production Lambda roles also need read/decrypt access to the configured MongoDB
URI parameter. The WebSocket and Comments functions need only their respective
DynamoDB and API Gateway Management API permissions.

Never commit `.env`, credentials, access tokens, WebSocket tickets, or resolved
parameter values.

## Testing

Install dependencies and run the Jest suite:

```bash
npm ci
npm test -- --runInBand
```

The tests cover API Gateway normalization and dispatch, grouped handlers,
Cognito authentication behavior, MongoDB URI resolution, comment profile
authorization, DynamoDB WebSocket state, ticket handling, and realtime
notification delivery.

## Packaging and deployment model

Each Lambda artifact should contain only its grouped handler and required
runtime closure while preserving repository-relative paths. At minimum, the
package root must contain:

```text
lambda/<group>/handler.js
lambda/shared/<required modules>.js
shared/<required modules>.js
package.json
package-lock.json
node_modules/<production dependencies>
```

`K12InfoWebSocket` also requires `lambda/websocket/state.js`.
`K12InfoComments` requires the top-level comment cursor, comment enrichment,
MongoDB, configuration, URI resolution, and validation modules. Build ZIPs and
staging directories are generated artifacts and are intentionally ignored by
Git. This repository does not currently include CI/CD or a deployment script;
packaging and AWS updates are separate operational steps.
