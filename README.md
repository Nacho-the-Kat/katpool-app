# KASPA Mining Pool using rusty-kaspa WASM

A comprehensive mining pool implementation for Kaspa using the rusty-kaspa WASM SDK. This pool manages miner connections, validates shares, distributes rewards, and handles block submissions through a robust stratum protocol implementation.

## Quick Start

<details>
<summary>Docker Compose Setup (Recommended)</summary>

1. **Clone and Setup**

   ```bash
   git clone <repository-url>
   cd katpool
   cp .env.sample .env
   ```

2. **Build and Run**

   ```bash
   docker build -t ghcr.io/<your-username>/katpool-app:0.65 .
   docker compose up -d
   ```

3. **Monitor**
   ```bash
   docker logs -f katpool-app
   ```

Access pool at: `http://<pool-server>:8080`

</details>

## Architecture Overview

<details>
<summary>System Workflow</summary>

The pool operates through the following workflow:

1. **RPC Connection**: Establishes connection to the Kaspa network
2. **Template Management**: Fetches and stores block templates to generate job IDs
3. **Job Distribution**: Distributes mining jobs to connected miners via stratum protocol
4. **Treasury Initialization**: Listens for UTXO events and tracks available funds
5. **Share Validation**: Validates submitted shares and checks difficulty requirements
6. **Reward Distribution**: Calculates contributions and distributes rewards periodically

### Block Template Fetching

Block templates are fetched from the GRPC endpoint using a Go-based service. These templates are then passed to a Redis channel for consumption by the main pool application.

</details>

<details>
<summary>Container Services</summary>

![Internal Container Design](images/katpool-system-design.png)

Note: If there are changes to the system design, the image above can be updated using the corresponding [drawio](/images/katpool-system-design.drawio) source file.

| Service                | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| **kaspad**             | Kaspa full node                                       |
| **katpool-app**        | Main application (core component)                     |
| **katpool-db**         | PostgreSQL database instance                          |
| **katpool-db-migrate** | Database schema migration handler                     |
| **katpool-backup**     | Database backup service with Google Drive integration |
| **katpool-monitor**    | VictoriaMetrics-backed metrics and REST API service   |
| **victoria-metrics**   | Metrics visualization and monitoring                  |
| **vmagent**            | Stores metrics in VictoriaMetrics                     |
| **go-app**             | Block template fetcher via gRPC                       |
| **redis**              | Message broker for block templates                    |
| **katpool-payment**    | Payment processing service                            |
| **nginx**              | Reverse proxy and load balancer                       |

</details>

## Prerequisites

<details>
<summary>Download Kaspa WASM SDK</summary>

**Note:** This setup is intended for **local development only**.

1. Download the latest Kaspa WASM SDK from [rusty-kaspa/releases](https://github.com/kaspanet/rusty-kaspa/releases)
2. Locate and download: `kaspa-wasm32-sdk-<LATEST_VERSION>.zip`
3. Extract the archive and locate the `nodejs` directory
4. Rename the `nodejs` folder to `wasm` and place it in your project repository

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; The `wasm` folder should contain:

- `kaspa`
- `kaspa-dev`

5. Ensure import paths in your code reference the local `wasm` folder correctly

</details>

<details>
<summary>Required Files and Directories</summary>

Create the following required files and directories:

- `vmagent.yml` - VMAgent scrape configuration
- `init.sql` - Database initialization script
- `migrate.sql` - Database migration script
- `nginx.conf` - Nginx configuration
- `config/config.json` - This configuration file is **mounted via** a **volume** in the current setup, so **any changes** made to it **do not require building** a **new Docker image**.
- `wasm/` - WASM SDK folder
- `.env` - Environment variables (copy from `.env.sample`)

</details>

## Configuration

<details>
<summary>Environment Setup</summary>

1. Copy `.env.sample` to `.env` and configure all required variables
2. All backend services share the same configuration file
3. **Security Note**: In future versions, private keys should be isolated to payment service only

**Important**: Update `vmagent.yml` targets to match your deployment.

</details>

<details>
<summary>Pool Configuration</summary>

Review and update `config/config.json` for your pool setup. All backend services share this configuration file.

**Key Configuration Notes:**

- **Pool[0]** is configured as a variable difficulty pool (default port: 8888)
- Supports user-defined difficulty via password field: `d=2048`
- Use [Crontab.guru](https://crontab.guru/) to configure cron expressions

#### Important Configuration Parameters

| Parameter                      | Description                     | Default                        |
| ------------------------------ | ------------------------------- | ------------------------------ |
| `payoutCronSchedule`           | Payout schedule cron expression | `* */12 * * *` (twice daily)   |
| `backupCronSchedule`           | Backup schedule cron expression | `0 1,13 * * *` (twice daily)   |
| `payoutAlertCronSchedule`      | Telegram alert schedule         | `0 1,7,13,19 * * *` (4x daily) |
| `thresholdAmount`              | Minimum payout amount (sompi)   | -                              |
| `block_wait_time_milliseconds` | Block request timeout (seconds) | -                              |
| `extraNonceSize`               | Extra nonce size (0-3 bytes)    | -                              |

</details>

<details>
<summary>Mining Port Configuration</summary>

The pool supports multiple difficulty ports defined in `config/config.json`.

**Variable Difficulty (Port 8888):**

- Automatically adjusts based on miner performance
- Supports custom difficulty via password field: `d=2048`

**Static Difficulty Ports:**

- Fixed difficulty levels
- Cannot be overridden via password field

### Example Configuration

```json
{
  "ports": {
    "8888": { "difficulty": 2048 },
    "1111": { "difficulty": 256 },
    "2222": { "difficulty": 1024 }
  }
}
```

</details>

## Installation

<details>
<summary>Docker Compose Installation</summary>

### Container Images

Since this is an open-source project without pre-built images, you must build images locally:

```bash
# Build the main application image
docker build -t ghcr.io/<your-username>/katpool-app:0.65 .

# Push to your registry
docker push ghcr.io/<your-username>/katpool-app:0.65
```

Update `docker-compose.yml` with your image URLs:

```yaml
image: ghcr.io/<your-username>/katpool-app:0.65
```

### Starting the Pool

```bash
# First time setup - create the network and start kaspad
docker network create katpool-app_backend
docker compose -f kaspad-compose.yml up -d

# Your regular workflow (kaspad is completely separate)
docker compose up -d

# Monitor main application logs
docker logs -f katpool-app
```

**Tip:** Use `DEBUG=1` environment variable for detailed logging during initial setup.

</details>

<details>
<summary>Local Development Setup</summary>

**Not Recommended for Production**

For local development without Docker:

```bash
# Install dependencies
bun install

# Run the application
bun run index.ts
```

**Requirements:**

- All environment variables configured
- WASM SDK in `wasm/` folder
- All dependent services running

</details>

## Database Setup

<details>
<summary>PostgreSQL Database</summary>

The pool uses PostgreSQL with the schema defined in `init.sql`.

#### Database Initialization

```bash
# Initialize database with schema
psql -U <your-db-user> -d <your-db-name> -f init.sql
```

**Prerequisites:**

- PostgreSQL database and user must exist
- User must have appropriate privileges

### Service Dependencies

Ensure all services are running before starting the application:

✅ **Core Services:**

- `kaspad` - Kaspa full node
- `katpool-db` - PostgreSQL database
- `redis` - Message broker

✅ **Application Services:**

- `katpool-app` - Main application
- `go-app` - Block template fetcher
- `katpool-payment` - Payment processor

✅ **Supporting Services:**

- `katpool-monitor` - Metrics and APIs
- `Victoria-Metrics` - Monitoring
- `vmagent` - For storing metrics to VictoriaMetrics
- `nginx` - Reverse proxy

</details>

## Monitoring and APIs

<details>
<summary>Available Endpoints</summary>

After 10 minutes of operation, the following endpoints will be available:

| Endpoint                            | Description               |
| ----------------------------------- | ------------------------- |
| `http://<pool-server>:8080`         | VictoriaMetrics interface |
| `http://<pool-server>:8080/config`  | Pool configuration        |
| `http://<pool-server>:8080/balance` | Miner balances            |
| `http://<pool-server>:8080/total`   | Total rewards distributed |

</details>

## Backup Configuration

<details>
<summary>Database Backup Setup</summary>

Optional database backup service can be enabled by:

1. Building the backup image:
   ```bash
   docker build -t katpool-backup:0.4 ./backup
   ```

**Important:** Transfer database dumps to external storage for additional protection.

</details>

<details>
<summary>Google Cloud Backup Setup</summary>

<details>
<summary>Creating project in google cloud console</summary>

1. Login to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project from the top bar
3. Select your newly created project

</details>

<details>
<summary>Enabling drive api service</summary>

1. Navigate to [API & Services Dashboard](https://console.cloud.google.com/apis/dashboard)
2. Click "ENABLE APIS AND SERVICES"
3. Go to Google Workspace section
4. Enable Google Drive API
5. Click "Enable"

</details>

<details>
<summary>Creating the google cloud service account</summary>

1. Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click "CREATE SERVICE ACCOUNT"
3. Provide service account name
4. Skip optional fields

</details>

<details>
<summary>Creating credentials for the service account</summary>

1. Select your service account
2. Go to "KEYS" tab
3. Click "ADD KEY" → "Create new key"
4. Select "JSON" key type
5. Download the credentials file

</details>

<details>
<summary>Locally running cloud backup script</summary>

1. Place the JSON file in `backup/` as `google-credentials.json`
2. Configure `backupEmailAddress` in config
3. Run the backup script:
   ```bash
   cd backup/
   bun run cloudBackup.ts fileName.sql
   ```

</details>

</details>

## System Architecture

<details>
<summary>Mining Cycle Overview</summary>

1. **Server Initialization**
   - Stratum server starts and listens for miner connections
   - RPC client connects to Kaspa network
   - Block templates fetched from Redis channel

2. **Template Management**
   - Go-app fetches templates via gRPC
   - Templates published to Redis channel
   - Katpool-app subscribes and processes templates
   - PoW objects created and stored

3. **Job Distribution**
   - Jobs created from block templates
   - Jobs distributed to all connected miners
   - Miners begin nonce calculations

4. **Share Processing**
   - Miners submit shares with found nonces
   - Server validates shares against difficulty targets
   - Valid shares tracked and recorded
   - Completed blocks submitted to Kaspa network

5. **Reward Distribution**
   - Contributions calculated based on valid shares
   - Rewards distributed proportionally
   - Balances updated in database

</details>

<details>
<summary>Stratum Server</summary>

The Stratum class manages the stratum protocol implementation:

**Key Features:**

- Handles miner connections and subscriptions
- Manages contribution tracking
- Processes share submissions
- Implements variable difficulty adjustments

**Core Methods:**

- `addShare()` - Validates and processes submitted shares
- `announceTemplate()` - Distributes new jobs to miners
- `onMessage()` - Handles stratum protocol messages

</details>

<details>
<summary>Templates Manager</summary>

The Templates class manages block template lifecycle:

**Responsibilities:**

- Subscribes to Redis channel for new templates
- Manages template cache with configurable size
- Creates PoW objects for mining validation
- Submits completed blocks to Kaspa network

**Key Methods:**

- `getHash()` - Retrieves hash for job ID
- `getPoW()` - Gets PoW object for validation
- `submit()` - Submits completed blocks
- `register()` - Registers template callback handlers

</details>

<details>
<summary>Pool Manager</summary>

The Pool class coordinates all pool components:

**Functions:**

- Manages treasury and stratum interactions
- Handles database operations
- Implements monitoring and logging
- Coordinates reward allocation

**Core Operations:**

- `allocate()` - Distributes rewards based on contributions
- Event handling for subscriptions and coinbase transactions
- Database integration for balance management

</details>

## Developer Notes

<details>
<summary>Development Tips</summary>

### Git Configuration

To ignore formatting commits in git blame:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

### Project Information

- **Runtime:** Bun v1.0.31
- **Base Project:** Created with `bun init`

</details>

<br>

**Foundation:** Special thanks to [KaffinPX](https://github.com/KaffinPX)

---

For additional support and documentation, please refer to the project's GitHub repository and associated service repositories.
