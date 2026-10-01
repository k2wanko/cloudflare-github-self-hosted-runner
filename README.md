# cloudflare-github-self-hosted-runner

Ephemeral GitHub Actions self-hosted runners on Cloudflare Containers.

Each job gets its own container that runs the official [`actions/runner`](https://github.com/actions/runner). Jobs are received through the `workflow_job` webhook and a just-in-time runner registration, so nothing polls GitHub. Containers are billed per 10 ms while they run, and a filesystem snapshot lets later jobs skip their setup.

## How it works

1. GitHub sends `workflow_job` (`queued`) to the Worker.
2. The Worker verifies the signature, parses the `runs-on` labels and hands the job to a `RunnerJob` Durable Object.
3. The Durable Object creates a just-in-time runner config with the GitHub App, then starts a container (restored from a snapshot when the job asks for one and it exists) that runs `./run.sh --jitconfig`.
4. The runner takes exactly one job and exits. `workflow_job` (`completed`) tears the container down and publishes the snapshot the job took.

## Deploy

Requirements: Docker, [`cf`](https://developers.cloudflare.com/) and a Cloudflare account with Containers enabled.

```sh
bun install
ALLOWED_OWNERS=example-org,example-user bunx cf deploy
```

Set the Cloudflare account with `CLOUDFLARE_ACCOUNT_ID` or an auth profile. Settings are read from the environment at deploy time:

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_OWNERS` | (required) | Comma separated GitHub owners that may use this deployment. |
| `CFRUNNER_WORKER_NAME` | `cfrunner` | Worker name. |
| `LABEL_PREFIX` | `cfrunner` | Prefix of the job label (`<prefix>-<run_id>-<run_attempt>`). |
| `INTERNAL_HOST` | `cfrunner.internal` | Host name containers use to reach the control API. |
| `SNAPSHOT_RESTORE_ANY_REF` | `false` | Let runs that are not on the default branch restore snapshots (they still cannot create them). |
| `SETUP_RESET_TOKEN` | (unset) | Enables `POST /setup/reset` (see below). |

Pass the same variables on every deploy; a deploy without them resets the setting to its default.

## Set up the GitHub App

Open the Worker URL. The page walks you through creating a private GitHub App with the GitHub App Manifest flow: permissions, the `workflow_job` event, the webhook URL and the redirect URL are filled in for you. The generated private key and webhook secret are stored only in the Worker. After setup the page is read-only.

- Organization apps use the *Self-hosted runners* organization permission.
- Personal-account apps need the repository *Administration* permission. Install the app only on the repositories you need.
- The app owner must be in `ALLOWED_OWNERS`, otherwise the app is rejected.
- Install the app on every repository that should use the runner. A job in a repository without the app stays queued.

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
| `instance:<preset>` | `standard-1` (default), `standard-2`, `standard-3`, `standard-4`. |
| `instance:cpu=2,memory=6,disk=16` | Custom size: 1–4 vCPU, memory in GiB (at least 3 GiB per vCPU, at most 12), disk in GB (at most 20). |
| `image:<name>` | Image defined in `cloudflare.config.ts` (default `default`). |
| `snapshot:<name>` | Restore this snapshot when it exists, otherwise start from the image. |
| `docker` | Start a Docker daemon before the runner starts (see [Docker](#docker)). |

Preset sizes:

| Preset | vCPU | Memory | Disk |
|---|---|---|---|
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

`lite` and `basic` are rejected: the runner does not start on `lite`, and the platform does not accept `basic`.

If a run has several jobs with identical labels (for example a matrix), add a unique label per job such as `job1`. GitHub assigns a job to any idle runner whose labels match.

## Snapshots

A snapshot saves the container filesystem so later jobs can skip setup (installing toolchains, warming package caches).

### Taking a snapshot

Add the `snapshot:<name>` label to the job, then call the control API from a step:

```sh
curl -fsS -X POST "$CFRUNNER_ENDPOINT/snapshot"
```

The API is only reachable from inside the container. It answers with JSON:

| Status | Meaning |
|---|---|
| `200` `{"created": true, ...}` | The snapshot was taken. It is published when the job succeeds. |
| `400` | The job has no `snapshot:` label. |
| `403` | The run is not allowed to create snapshots (see rules below). |
| `409` | The job is not running. |
| `500` | The platform failed to take the snapshot. |

Taking a snapshot takes time (about 15 s was measured for a job with installed dependencies), so take it only when something changed, or only on the runs that are allowed to create it.

### Using a snapshot

`CFRUNNER_SNAPSHOT_HIT` is `true` when the job was restored from a snapshot. It is an environment variable of the runner process, so it is not in the `env` context. Pass it through a step output:

```yaml
jobs:
  check:
    runs-on:
      - cfrunner-${{ github.run_id }}-${{ github.run_attempt }}
      - snapshot:ci-v1
    steps:
      - id: snap
        run: echo "hit=$CFRUNNER_SNAPSHOT_HIT" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: take snapshot
        run: curl -fsS -X POST "$CFRUNNER_ENDPOINT/snapshot" || true
```

This repository's own [CI](.github/workflows/ci.yml) does the same: `setup-node` drops from about 10 s to 1 s and `bun install` from about 11 s to 1 s on a restored snapshot. Because the take step ends with `|| true`, jobs on refs that may not create snapshots (pull requests) just restore.

Anything under the runner's `_work` directory (the checkout) is deleted when a snapshot is restored. Tools installed by `setup-*` actions live in `/opt/hostedtoolcache`, and `$HOME` (`/home/runner`) is kept, so toolchains and package manager caches survive. Skipping a `setup-*` step on a hit does not put the tool on `PATH`; run the step anyway, it finds the cached tool.

### Rules

- **Last one wins.** Every call creates a new snapshot. When the job succeeds, it replaces the earlier snapshot with the same name. "Last" is the order in which jobs called the API, not the order they finish: if a later caller finishes first, the earlier caller's snapshot is discarded. Until a new snapshot is published, the previous one keeps being used.
- **Published after the job succeeds.** A snapshot is never visible to jobs that are still running, and a failed or cancelled job discards its snapshot. This keeps the job's `GITHUB_TOKEN`, which expires when the job ends, out of reach.
- **Default branch only.** Only runs of the default branch started by `push`, `workflow_dispatch` or `schedule` may create snapshots. Other refs can neither create nor restore them unless `SNAPSHOT_RESTORE_ANY_REF=true` (restore only). Runs from forks never use them.
- **Scope.** A snapshot belongs to one repository, one name and one image. Updating the image makes the old snapshots unusable. A snapshot expires 30 days after its last use.
- **Fallback.** If a requested snapshot does not exist or cannot be restored, the job starts from the image and `CFRUNNER_SNAPSHOT_HIT` is `false`.
- **Secrets.** Anything on disk when the snapshot is taken reaches later jobs. Do not write secrets to files before taking it, and use `persist-credentials: false` for checkout. A snapshot cannot be deleted from the platform; it is only marked unusable, so rotate any secret that leaked into one.

## Docker

Add the `docker` label and the container starts `dockerd` before the runner, so `docker`, `services:` and `docker build` work in the job.

```yaml
jobs:
  bench:
    runs-on:
      - cfrunner-${{ github.run_id }}-${{ github.run_attempt }}
      - instance:standard-3
      - docker
      - snapshot:pg16-v1
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: pw
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 2s
    steps:
      - run: docker run --rm --network host -e PGPASSWORD=pw postgres:16-alpine pgbench -i -s 10 -h 127.0.0.1 -U postgres postgres
      - run: curl -fsS -X POST "$CFRUNNER_ENDPOINT/snapshot" || true
```

- The container is a microVM where `/proc/sys` is read-only. The start script remounts it read-write and enables IPv4 forwarding, then starts `dockerd` with `iptables` (installed in the image). Bridge networks, published ports, container-to-container name resolution and outbound access from containers were verified.
- The Docker data directory is part of a snapshot, so images pulled before the snapshot is taken are available without pulling again. In a measured run with `postgres:16-alpine`, starting the service took 8 s instead of 17 s and the whole job 44–46 s instead of 58 s. The first restore of a large snapshot (479 MB) was slower than the following ones.
- `docker` adds the daemon's memory use, so use `standard-2` or larger.
- Job containers (`container:`) and Docker Compose have not been tested.

## Limits and notes

- Jobs may run for at most 6 hours.
- Pull requests from forks are not supported; their jobs are ignored and stay queued.
- Containers run as the `runner` user of the official `actions-runner` image (Ubuntu). It does not include the tool set of GitHub-hosted runners; use `setup-*` actions, optionally with a snapshot.
- If the container cannot start, the job stays queued and the failure is written to the Worker logs. There is no automatic retry.
- Update the runner by changing the version in `images/default/Dockerfile`. GitHub stops serving jobs to runners that are more than 30 days behind.

## Troubleshooting

- **A job stays queued.** Check that the job label matches `<prefix>-<run_id>-<run_attempt>`, that the app is installed on the repository and that the owner is in `ALLOWED_OWNERS`. Then watch the Worker logs while re-running the job:

  ```sh
  bunx wrangler tail <worker-name> --format json
  ```

  Each job logs its phases (`fetching run info`, `creating jit config`, `snapshot ... hit|miss`, `starting container`), `runner start failed` with the reason, and `container exited` with the exit reason.
- **A webhook was missed.** GitHub does not redeliver failed deliveries automatically. Redeliver it from the app's *Advanced* settings; GitHub only keeps recent deliveries.
- **A snapshot is not used.** It is only published after the creating job succeeds, and only runs of the default branch restore it unless `SNAPSHOT_RESTORE_ANY_REF=true`.

## Development

```sh
bun install
bun run lint
bun run typecheck   # generates the Worker types, then runs tsc
bun test
```

CI runs on this runner. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
