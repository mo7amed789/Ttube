# Ttube deployment guide

This guide deploys Ttube as two .NET containers behind Nginx, with Redis for shared cache and short-lived OAuth import state. It is suitable for a single Linux VPS. For higher availability, move the app containers and Redis to managed services and use a managed load balancer.

If you have GitHub Student Developer Pack and want GitHub to deploy each push, use the Azure App Service path below. GitHub Pages cannot host Ttube's .NET API because Pages serves static sites only.

## Deploy from GitHub to Azure App Service

This workflow builds Ttube on each push to `main`. It only deploys after an Azure Web App name is set in GitHub, so the first push only builds the app.

1. Activate an eligible Azure for Students subscription from your Student Pack / Azure Education Hub. Check the offer and remaining credit in Azure before creating resources.
2. In the Azure portal, create an **App Service Web App** with **Code** as the publish option and **.NET 10** as the runtime. Use a plan available to your subscription. The free plan is suitable for a prototype; check its limits and your credit before choosing a paid plan.
3. In the App Service configuration, add these application settings:

   | Name | Value |
   | --- | --- |
   | `YouTube__ApiKey` | Your YouTube Data API key |
   | `YouTube__OAuthClientId` | Your Google OAuth client ID (optional) |
   | `YouTube__OAuthClientSecret` | Your Google OAuth client secret (optional) |
   | `Ttube__BaseUrl` | `https://YOUR_APP_NAME.azurewebsites.net` |

   App Service settings are encrypted configuration; do not put credentials in the repository. Redis is optional for a single App Service instance; without it the app uses in-memory cache/state. Keep the app at one instance while using in-memory state.

4. In the Azure Web App Overview, download its publish profile. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add:
   - Repository variable `AZURE_WEBAPP_NAME` with the exact Web App name.
   - Repository secret `AZURE_WEBAPP_PUBLISH_PROFILE` with the complete downloaded publish-profile XML.

5. If using subscription import, add `https://YOUR_APP_NAME.azurewebsites.net` as the authorized JavaScript origin and `https://YOUR_APP_NAME.azurewebsites.net/api/auth/google/callback` as the authorized redirect URI in the Google OAuth client. Then restart the App Service.
6. Push a commit to `main`, or open **Actions → Build and deploy Ttube to Azure → Run workflow**. The workflow builds and deploys the app. Visit `https://YOUR_APP_NAME.azurewebsites.net/healthz`; it should return `ok`.
7. If adding a custom domain, configure its DNS and HTTPS in App Service, update `Ttube__BaseUrl`, and update the Google OAuth origin and callback URI to the custom HTTPS domain.

The publish-profile secret can deploy code to the app, so keep it private and rotate it if exposed. GitHub Pages is not used for this deployment.

## Before you start

- A Linux VPS with Docker Engine and the Docker Compose plugin.
- A domain name pointed at the VPS.
- A TLS reverse proxy in front of Ttube. The included Compose stack listens on HTTP port 8080; do not expose that port publicly without TLS. You can terminate TLS with a managed load balancer or configure a host-level proxy such as Caddy to forward HTTPS traffic to `127.0.0.1:8080`.
- A YouTube Data API v3 key. Restrict it to the YouTube Data API v3. If Google Cloud supports a stable egress-IP restriction for your deployment, restrict the key to that server IP as well.
- Google OAuth web credentials only if users need subscription import. Use the public HTTPS origin as the authorized JavaScript origin and add `https://YOUR_DOMAIN/api/auth/google/callback` as an authorized redirect URI. Configure the consent screen and review/publish the app according to Google's requirements before opening it to the public.

## Deploy

1. Install Docker Engine and the Compose plugin on the VPS. Allow inbound SSH and web traffic on ports 80/443; keep Redis private and do not expose port 6379.
2. Clone the private repository onto the VPS:

   ```sh
   git clone https://github.com/mo7amed789/Ttube.git
   cd Ttube
   ```

3. Create a private environment file and add the server-side credentials. Never commit this file:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Set `YOUTUBE_API_KEY`, `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, and `TTUBE_BASE_URL=https://YOUR_DOMAIN`. If subscription import is not enabled, the two OAuth values can remain empty.

   When the app is behind the included Nginx proxy, also set `TTUBE_TRUST_FORWARDED_HEADERS=true`. Leave it `false` when the application is directly exposed without a trusted reverse proxy.

4. Start the app stack:

   ```sh
   docker compose up --build -d
   docker compose ps
   ```

5. Configure the TLS proxy to forward the public HTTPS host to `127.0.0.1:8080`. Preserve the original `Host` and client forwarding headers. Keep port 8080 firewalled from the public internet after the proxy is in place.
6. Confirm the application responds at `https://YOUR_DOMAIN/healthz` with `ok`, then open the site and check channel loading and video playback.
7. For updates, pull the approved commit and rebuild:

   ```sh
   git pull --ff-only
   docker compose up --build -d
   ```

## Google settings

- Restrict the YouTube API key to **YouTube Data API v3**. Since the key is used by the server, do not configure website referrer restrictions for the public site; use an IP restriction only if the deployment has a fixed outbound IP. Keep the key in `.env` or the hosting provider's secret store.
- The OAuth redirect URI must exactly match `https://YOUR_DOMAIN/api/auth/google/callback`. Also set the authorized JavaScript origin to `https://YOUR_DOMAIN` when Google asks for it.
- Keep OAuth client secrets server-side. Public OAuth verification and consent-screen setup are separate from deploying the site; Google may limit unverified apps to approved test users.
- YouTube API quota is shared across users of this deployment. Monitor quota in Google Cloud and configure billing/contact alerts as appropriate.

## Operations and known limits

- `/healthz` is a process-level liveness check. `/readyz` verifies the distributed cache used by feed caching and OAuth state; use it as the load-balancer readiness probe.
- API routes have an application-level per-client rate limit of 60 requests per minute. The Nginx proxy adds an additional edge limit. If public traffic grows, move rate limiting to a shared gateway or distributed limiter so limits are consistent across instances.
- Responses include baseline security headers, and exception details are converted to generic problem responses in production. Keep HTTPS termination in front of the app and do not expose Redis or the application container directly.
- Compose runs two application processes on one VPS, so it is not multi-machine high availability. Redis in this stack is an ephemeral cache/state store; restarting it can expire pending subscription imports, which users can retry.
- Set up VPS/provider backups for configuration, monitoring and alerts for CPU, memory, disk, container restarts, Google API quota, and TLS certificate renewal.
- Ttube stores channel selections in each user's browser. There are no accounts or cross-device profile sync.
- Review Google/YouTube API policies and applicable privacy requirements before public launch. Publish a privacy notice that explains the use of YouTube APIs and local browser storage.
- Rotate credentials immediately if they are ever committed or exposed. Removing a secret from a later commit does not make the exposed credential safe.

## Local Compose smoke check

On a machine with Docker Compose, copy `.env.example` to `.env`, add a YouTube API key, then run `docker compose up --build`. Open `http://localhost:8080` and check `http://localhost:8080/healthz`. This local HTTP setup is for development only; production traffic must use HTTPS.
