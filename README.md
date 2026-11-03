# Ttube

An Arabic, right-to-left video discovery app where the viewer controls the sources. Channel choices are stored in that browser's local storage; the server does not create accounts or persist a viewer profile. The .NET backend uses YouTube Data API v3 to resolve channels and load their uploads. Feed results are limited to the channel IDs sent by the browser.

## Run locally

1. Install the .NET 10 SDK.
2. Create a YouTube Data API v3 key in Google Cloud and enable the YouTube Data API v3 for its project.
3. In PowerShell, set the key for this terminal session and start the app:

   ```powershell
   $env:YouTube__ApiKey = "YOUR_API_KEY"
   dotnet run
   ```

4. Open the local address printed by ASP.NET Core.

For a persistent local secret, use .NET user secrets instead of putting a key in source control:

```powershell
dotnet user-secrets init
dotnet user-secrets set "YouTube:ApiKey" "YOUR_API_KEY"
dotnet run
```

The key is read only by the server and is never sent to the browser. Without it, a pasted channel link is still saved in the current browser and will be resolved after the key is configured and the page is refreshed.

## Import your YouTube subscriptions

An API key can only read public data. Importing the signed-in user's subscriptions needs a separate OAuth client and the user's consent. Ttube asks only for the `youtube.readonly` scope, reads the complete subscription list, then discards the short-lived access token. Imported channel choices are saved in the browser's local storage.

1. In Google Cloud, configure the OAuth consent screen / Google Auth Platform. For personal testing, use the External audience, add your Google account as a test user, and add the scope `https://www.googleapis.com/auth/youtube.readonly` under Data Access.
2. Create an OAuth client with application type **Web application**.
3. Add this exact **Authorized redirect URI**:

   ```text
   http://localhost:5248/api/auth/google/callback
   ```

4. Copy the client ID and client secret into local .NET user secrets:

   ```powershell
   dotnet user-secrets set "YouTube:OAuthClientId" "YOUR_CLIENT_ID"
   dotnet user-secrets set "YouTube:OAuthClientSecret" "YOUR_CLIENT_SECRET"
   ```

5. Restart Ttube, select **استورد اشتراكاتك**, and approve the read-only YouTube permission on Google's page.

The OAuth consent screen may show an unverified-app warning while the app remains in testing. Continue only for your own test account that you added as a test user. Do not publish these OAuth credentials in source control. See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and the YouTube [`subscriptions.list` reference](https://developers.google.com/youtube/data/reference/rest/v3/subscriptions/list).

## Current behavior

- Add a channel by its `youtube.com/@handle` or `youtube.com/channel/UC…` link, switch between your saved sources, or remove one.
- Browse uploads from those sources, sort by view count or date, search locally, and watch in Ttube's embedded YouTube player. The watch view includes the video description, public comments (with pagination), and related suggestions assembled only from the channels currently saved in the browser.
- YouTube's embedded player may show end-of-video recommendations from the same source channel; the app's own suggestions stay within the saved channel list.
- The short-video view uses a duration of three minutes or less as a practical filter. YouTube's API does not label every upload as a Short, so the duration is an approximation.
- The Islamic and .NET topic filters look for matching words in video titles and descriptions. They do not use an AI classifier.
- Each selected channel's latest 20 uploads are checked per feed request; up to 300 popular uploads are returned across the selected channels. Feed requests accept up to 500 channels, using batches of 50 for channel lookups and bounded parallel requests. The page initially renders 24 cards and loads more on demand. YouTube API quota applies.

Ttube has no account or profile-sync feature. Google OAuth is used only during a subscription import; adding channels on another browser starts a separate list. Before public launch, configure HTTPS, restrict Google credentials, complete any required OAuth consent review, and publish a privacy notice. See [DEPLOYMENT.md](DEPLOYMENT.md) for the VPS deployment steps and current operational limits.

## Performance and load-balanced deployment

The app now compresses responses with Brotli/Gzip, caches feeds in a shared distributed cache for four minutes and comment pages for two minutes, proxies allowlisted YouTube channel avatars with a 12-hour cache, limits the initial DOM to 24 video cards, and fetches channel/playlist/video metadata with bounded parallelism. OAuth state and the short-lived import result also use the distributed cache, so a Google callback can land on either app instance without sticky sessions. Local `dotnet run` uses an in-memory cache when Redis is not configured.

For the two-instance Docker Compose setup and production VPS instructions, see [DEPLOYMENT.md](DEPLOYMENT.md). Compose runs both app instances behind Nginx and uses Redis for shared short-lived cache/state. It is a single-host starting point, not multi-machine high availability. The local Compose endpoint uses HTTP for development; public traffic must be served through HTTPS. `/healthz` is available for a basic liveness check.
