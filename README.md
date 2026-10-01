# cloudflare-github-self-hosted-runner

Ephemeral GitHub Actions self-hosted runners on Cloudflare Containers.

Each job gets its own container that runs the official [`actions/runner`](https://github.com/actions/runner). Jobs are received through the `workflow_job` webhook and a just-in-time runner registration, so nothing polls GitHub. Containers are billed per 10 ms while they run.

## How it works

1. GitHub sends `workflow_job` (`queued`) to the Worker.
2. The Worker verifies the signature, parses the `runs-on` labels and hands the job to a `RunnerJob` Durable Object.
3. The Durable Object creates a just-in-time runner config with the GitHub App, then starts a container (optionally restored from a snapshot) that runs `./run.sh --jitconfig`.
4. The runner takes exactly one job and exits. `workflow_job` (`completed`) tears the container down.

## Deploy

Requirements: Docker, [`cf`](https://developers.cloudflare.com/) and a Cloudflare account with Containers enabled.

```sh
bun install
ALLOWED_OWNERS=example-org,example-user bunx cf deploy
```

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_OWNERS` | (required) | Comma separated GitHub owners that may use this deployment. |
| `CFRUNNER_WORKER_NAME` | `cfrunner` | Worker name. |
| `LABEL_PREFIX` | `cfrunner` | Prefix of the job label (`<prefix>-<run_id>-<run_attempt>`). |
| `INTERNAL_HOST` | `cfrunner.internal` | Host name containers use to reach the control API. |
| `SNAPSHOT_RESTORE_ANY_REF` | `false` | Let non-default branches restore snapshots (they still cannot create them). |
| `SETUP_RESET_TOKEN` | (unset) | Enables `POST /setup/reset` (see below). |

Set the Cloudflare account with `CLOUDFLARE_ACCOUNT_ID` or an auth profile.

## Set up the GitHub App

Open the Worker URL. The page walks you through creating a private GitHub App with the GitHub App Manifest flow: permissions, the `workflow_job` event, the webhook URL and the redirect URL are filled in for you. The generated private key and webhook secret are stored only in the Worker. After setup the page is read-only.

- Organization apps use the *Self-hosted runners* organization permission.
- Personal-account apps need the repository *Administration* permission. Install the app only on the repositories you need.
- The app owner must be in `ALLOWED_OWNERS`, otherwise the app is rejected.

Re-deploying keeps the credentials. To recreate the app, delete it on GitHub, deploy with `SETUP_RESET_TOKEN` set, call `POST /setup/reset` with `Authorization: Bearer <token>`, set the app up again and remove the token. A token works once.

## Use it in a workflow

```yaml
jobs:
  build:
    runs-on:
      - cfrunner-${{ github.run_id }}-${{ github.run_attempt }}
      - instance:standard-2
      - snapshot:node24-v1
```

| Label | Meaning |
|---|---|
| `<prefix>-<run_id>-<run_attempt>` | Required. Selects this runner. |
| `instance:<preset>` | `lite`, `standard-1` (default), `standard-2`, `standard-3`, `standard-4`. |
| `instance:cpu=2,memory=6,disk=16` | Custom size: 1–4 vCPU, memory in GiB (at least 3 GiB per vCPU, at most 12), disk in GB (at most 20). |
| `image:<name>` | Image defined in `cloudflare.config.ts` (default `default`). |
| `snapshot:<name>` | Restore this snapshot when it exists, otherwise start from the image. |

If a run has several jobs with identical labels, add a unique label per job (for example `job1`). GitHub assigns a job to any idle runner whose labels match.

Jobs may run for at most 6 hours. Pull requests from forks are not supported.

### Snapshots

A snapshot saves the container filesystem so later jobs can skip setup.

```yaml
steps:
  - id: snap
    run: echo "hit=$CFRUNNER_SNAPSHOT_HIT" >> "$GITHUB_OUTPUT"
  - uses: actions/setup-node@v4
    if: steps.snap.outputs.hit != 'true'
  - run: curl -fsS -X POST "$CFRUNNER_ENDPOINT/snapshot" || true
  - uses: actions/checkout@v4
```

- `CFRUNNER_SNAPSHOT_HIT` and `CFRUNNER_ENDPOINT` are environment variables of the runner process. They are not in the `env` context, so pass them through a step output as above.
- Snapshots are immutable. A name that already exists is kept (`created: false`). Change the name (`-v2`) to refresh.
- A new snapshot becomes available **after the job completes successfully**. It is never visible to jobs that are still running, and a failed or cancelled job discards it. This keeps the job's `GITHUB_TOKEN` out of reach.
- Snapshots can only be created by runs of the default branch started by `push`, `workflow_dispatch` or `schedule`. Other refs can neither create nor restore them unless `SNAPSHOT_RESTORE_ANY_REF=true` (restore only).
- Snapshots belong to one repository and one image. Updating the image invalidates them. They expire 30 days after the last use.
- Take the snapshot before checking out code and do not write secrets to files before it. Anything on disk at that point reaches later jobs. Snapshots cannot be deleted from the platform, so rotate any secret that leaked into one.

## Notes

- Containers run as the `runner` user of the official `actions-runner` image (Ubuntu). It does not include the tool set of GitHub-hosted runners; use `setup-*` actions, optionally with a snapshot.
- Update the runner by changing the version in `images/default/Dockerfile`. GitHub stops serving jobs to runners that are more than 30 days behind.
- Docker-in-Docker and service containers have not been tested.

## Development

```sh
bun install
bun run lint
bun run typecheck
bun test
```
