using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Caching.Distributed;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<BrotliCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
var redisConnection = builder.Configuration.GetConnectionString("Redis");
if (string.IsNullOrWhiteSpace(redisConnection)) builder.Services.AddDistributedMemoryCache();
else builder.Services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = redisConnection;
    options.InstanceName = "Ttube:";
});

builder.Services.AddHttpClient<YouTubeDataClient>(client =>
{
    client.BaseAddress = new Uri("https://www.googleapis.com/youtube/v3/");
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestVersion = HttpVersion.Version20;
    client.DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrHigher;
});
builder.Services.AddHttpClient<YouTubeOAuthClient>(client =>
{
    client.BaseAddress = new Uri("https://www.googleapis.com/youtube/v3/");
    client.Timeout = TimeSpan.FromSeconds(30);
});
builder.Services.AddHttpClient<ThumbnailProxyClient>(client => client.Timeout = TimeSpan.FromSeconds(10))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddSingleton<ChannelImportStore>();

var app = builder.Build();
app.UseDefaultFiles();
app.UseResponseCompression();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Text("ok", "text/plain"));

app.MapGet("/api/status", (IConfiguration config) => Results.Ok(new
{
    configured = !string.IsNullOrWhiteSpace(config["YouTube:ApiKey"]),
    subscriptionImportConfigured = !string.IsNullOrWhiteSpace(config["YouTube:OAuthClientId"]) &&
                                  !string.IsNullOrWhiteSpace(config["YouTube:OAuthClientSecret"]),
    message = string.IsNullOrWhiteSpace(config["YouTube:ApiKey"])
        ? "Add a YouTube Data API key to enable live channel videos."
        : "YouTube Data API is ready."
}));

app.MapGet("/api/auth/google/start", async Task<IResult> (IConfiguration config, ChannelImportStore imports, CancellationToken ct) =>
{
    var clientId = config["YouTube:OAuthClientId"];
    var clientSecret = config["YouTube:OAuthClientSecret"];
    if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        return Results.Problem("Subscription import needs a Google OAuth web client. Set YouTube:OAuthClientId and YouTube:OAuthClientSecret, then restart Ttube.", statusCode: 503);

    var baseUrl = (config["Ttube:BaseUrl"] ?? "http://localhost:5248").TrimEnd('/');
    var redirectUri = $"{baseUrl}/api/auth/google/callback";
    var state = await imports.StartAuthorizationAsync(redirectUri, ct);
    var parameters = new Dictionary<string, string>
    {
        ["client_id"] = clientId,
        ["redirect_uri"] = redirectUri,
        ["response_type"] = "code",
        ["scope"] = "https://www.googleapis.com/auth/youtube.readonly",
        ["access_type"] = "online",
        ["include_granted_scopes"] = "true",
        ["prompt"] = "consent select_account",
        ["state"] = state
    };
    var authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?" +
        string.Join('&', parameters.Select(p => $"{Uri.EscapeDataString(p.Key)}={Uri.EscapeDataString(p.Value)}"));
    return Results.Ok(new { authorizationUrl });
});

app.MapGet("/api/auth/google/callback", async Task<IResult> (
    string? code, string? state, string? error, IConfiguration config,
    ChannelImportStore imports, YouTubeOAuthClient youtube, CancellationToken ct) =>
{
    if (!string.IsNullOrWhiteSpace(error)) return Results.Redirect("/?subscriptionImport=cancelled");
    if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state) ||
        (await imports.CompleteAuthorizationAsync(state, ct)) is not { } redirectUri)
        return Results.Redirect("/?subscriptionImport=expired");
    try
    {
        var channels = await youtube.ImportSubscriptionsAsync(code, redirectUri, config["YouTube:OAuthClientId"]!,
            config["YouTube:OAuthClientSecret"]!, ct);
        var importId = await imports.StoreResultAsync(channels, ct);
        return Results.Redirect($"/?subscriptionImport={Uri.EscapeDataString(importId)}");
    }
    catch (YouTubeOAuthException ex)
    {
        return Results.Redirect($"/?subscriptionImport={Uri.EscapeDataString(ex.UserMessage)}");
    }
});

app.MapGet("/api/channels/import/{importId}", async Task<IResult> (string importId, ChannelImportStore imports, CancellationToken ct) =>
    (await imports.TakeResultAsync(importId, ct)) is { } channels
        ? Results.Ok(channels)
        : Results.NotFound(new { error = "This import link expired. Start the import again." }));

app.MapPost("/api/channels/resolve", async Task<IResult> (ResolveChannelRequest request, YouTubeDataClient youtube, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.Url) || !Uri.TryCreate(request.Url.Trim(), UriKind.Absolute, out var uri) ||
        uri.Host is not ("youtube.com" or "www.youtube.com" or "m.youtube.com" or "youtu.be"))
        return Results.BadRequest(new { error = "Paste a valid YouTube channel link, such as youtube.com/@name." });

    var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
    var handle = parts.FirstOrDefault()?.StartsWith('@') == true ? parts[0][1..] : null;
    var channelId = parts.Length > 1 && parts[0].Equals("channel", StringComparison.OrdinalIgnoreCase) ? parts[1] : null;
    if (channelId is null && handle is null)
        return Results.BadRequest(new { error = "Use a channel URL such as youtube.com/@name or youtube.com/channel/UC…" });

    try
    {
        var channel = await youtube.ResolveChannelAsync(channelId, handle, ct);
        return channel is null
            ? Results.NotFound(new { error = "That channel could not be found. Check the link and try again." })
            : Results.Ok(channel);
    }
    catch (YouTubeApiException ex)
    {
        return Results.Problem(ex.Message, statusCode: ex.StatusCode);
    }
});

app.MapGet("/api/search/channels", async Task<IResult> (string? q, string? language, bool? safeSearch, YouTubeDataClient youtube, IDistributedCache cache, CancellationToken ct) =>
{
    var query = q?.Trim();
    if (string.IsNullOrWhiteSpace(query) || query.Length < 2)
        return Results.BadRequest(new { detail = "Enter at least two characters to search YouTube." });
    if (query.Length > 100) return Results.BadRequest(new { detail = "Search text must be 100 characters or fewer." });
    var languageCode = language?.Trim().ToLowerInvariant() switch { "ar" => "ar", "en" => "en", _ => null };
    var useSafeSearch = safeSearch == true;
    var cacheInput = $"{query.ToLowerInvariant()}|{languageCode}|{useSafeSearch}";
    var cacheKey = $"ttube:channel-search:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cacheInput)))}";
    try
    {
        var cached = await cache.GetStringAsync(cacheKey, ct);
        if (cached is not null) return Results.Content(cached, "application/json");
        var results = await youtube.SearchChannelsAsync(query, languageCode, useSafeSearch, ct);
        var json = JsonSerializer.Serialize(results, JsonSerializerOptions.Web);
        await cache.SetStringAsync(cacheKey, json, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(30) }, ct);
        return Results.Content(json, "application/json");
    }
    catch (YouTubeApiException ex)
    {
        return Results.Problem(ex.Message, statusCode: ex.StatusCode);
    }
});

app.MapPost("/api/feed", async Task<IResult> (FeedRequest request, YouTubeDataClient youtube, IDistributedCache cache, CancellationToken ct) =>
{
    var ids = (request.ChannelIds ?? []).Where(id => !string.IsNullOrWhiteSpace(id) && id.StartsWith("UC", StringComparison.Ordinal) && id.Length == 24)
        .Distinct(StringComparer.Ordinal).Take(501).ToArray();
    if (ids.Length > 500) return Results.Problem("This feed supports up to 500 selected channels at a time.", statusCode: 413);
    if (ids.Length == 0) return Results.Ok(new FeedPage([], new Dictionary<string, string>(), 20));
    var pageTokens = (request.PageTokens ?? new Dictionary<string, string>())
        .Where(pair => ids.Contains(pair.Key, StringComparer.Ordinal) && !string.IsNullOrWhiteSpace(pair.Value))
        .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    int? pageSize = request.PageSize is null ? null : Math.Clamp(request.PageSize.Value, 1, 20);
    var cacheKey = FeedCacheKey(ids, pageTokens, pageSize);
    try
    {
        var cached = await cache.GetStringAsync(cacheKey, ct);
        if (cached is not null) return Results.Content(cached, "application/json");
        var feed = await youtube.GetVideosAsync(ids, pageTokens, pageSize, ct);
        var json = JsonSerializer.Serialize(feed, JsonSerializerOptions.Web);
        await cache.SetStringAsync(cacheKey, json, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(4) }, ct);
        return Results.Content(json, "application/json");
    }
    catch (YouTubeApiException ex)
    {
        return Results.Problem(ex.Message, statusCode: ex.StatusCode);
    }
});

app.MapPost("/api/uploads/latest", async Task<IResult> (FeedRequest request, YouTubeDataClient youtube, IDistributedCache cache, CancellationToken ct) =>
{
    var ids = (request.ChannelIds ?? []).Where(id => !string.IsNullOrWhiteSpace(id) && id.StartsWith("UC", StringComparison.Ordinal) && id.Length == 24)
        .Distinct(StringComparer.Ordinal).Take(501).Order(StringComparer.Ordinal).ToArray();
    if (ids.Length > 500) return Results.Problem("This upload check supports up to 500 selected channels at a time.", statusCode: 413);
    if (ids.Length == 0) return Results.Ok(Array.Empty<VideoItem>());
    var cacheKey = $"ttube:uploads:v2:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(',', ids))))}";
    try
    {
        var cached = await cache.GetStringAsync(cacheKey, ct);
        if (cached is not null) return Results.Content(cached, "application/json");
        var videos = await youtube.GetLatestUploadsAsync(ids, ct);
        var json = JsonSerializer.Serialize(videos, JsonSerializerOptions.Web);
        await cache.SetStringAsync(cacheKey, json, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10) }, ct);
        return Results.Content(json, "application/json");
    }
    catch (YouTubeApiException ex)
    {
        return Results.Problem(ex.Message, statusCode: ex.StatusCode);
    }
});

app.MapGet("/api/videos/{videoId}/comments", async Task<IResult> (string videoId, string? pageToken, YouTubeDataClient youtube, IDistributedCache cache, CancellationToken ct) =>
{
    if (videoId.Length != 11 || videoId.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('_' or '-')))
        return Results.BadRequest(new { error = "Invalid YouTube video ID." });
    try
    {
        var pageHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(pageToken ?? "first")));
        var cacheKey = $"ttube:comments:{videoId}:{pageHash}";
        var cached = await cache.GetStringAsync(cacheKey, ct);
        if (cached is not null) return Results.Content(cached, "application/json");
        var comments = await youtube.GetCommentsAsync(videoId, pageToken, ct);
        var json = JsonSerializer.Serialize(comments, JsonSerializerOptions.Web);
        await cache.SetStringAsync(cacheKey, json, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2) }, ct);
        return Results.Content(json, "application/json");
    }
    catch (YouTubeApiException ex)
    {
        return Results.Problem(ex.Message, statusCode: ex.StatusCode);
    }
});

app.MapGet("/api/channel-thumbnail", async Task<IResult> (
    string? url, ThumbnailProxyClient thumbnails, IDistributedCache cache, HttpContext context, CancellationToken ct) =>
{
    if (!thumbnails.IsAllowedSource(url)) return Results.BadRequest(new { error = "Unsupported thumbnail host." });
    var cacheKey = "ttube:thumbnail:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url!)));
    var cachedBytes = await cache.GetAsync(cacheKey, ct);
    var cachedType = await cache.GetStringAsync(cacheKey + ":type", ct);
    if (cachedBytes is not null && cachedType is not null)
    {
        context.Response.Headers.CacheControl = "public,max-age=21600,stale-while-revalidate=86400";
        return Results.File(cachedBytes, cachedType);
    }

    var image = await thumbnails.FetchAsync(url!, ct);
    if (image is null) return Results.NotFound();
    await cache.SetAsync(cacheKey, image.Bytes, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(12) }, ct);
    await cache.SetStringAsync(cacheKey + ":type", image.ContentType, new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(12) }, ct);
    context.Response.Headers.CacheControl = "public,max-age=21600,stale-while-revalidate=86400";
    return Results.File(image.Bytes, image.ContentType);
});

static string FeedCacheKey(string[] ids, IReadOnlyDictionary<string, string> pageTokens, int? pageSize)
{
    var canonical = string.Join(',', ids.OrderBy(id => id, StringComparer.Ordinal));
    var pageState = string.Join(',', pageTokens.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{pair.Key}:{pair.Value}"));
    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{canonical}|{pageState}|{pageSize}")));
    return $"ttube:feed:v3:{hash}";
}

app.Run();

record ResolveChannelRequest(string Url);
record FeedRequest(string[] ChannelIds, Dictionary<string, string>? PageTokens = null, int? PageSize = null);
record FeedPage(IReadOnlyList<VideoItem> Videos, Dictionary<string, string> NextPageTokens, int PageSize);
record ChannelItem(string Id, string Title, string? Thumbnail, string? Handle, string UploadsPlaylistId);
record ChannelSearchItem(string Id, string Title, string? Description, string? Thumbnail, long Subscribers, long Views);
record VideoItem(string Id, string Title, string? Description, string? Thumbnail, string ChannelId, string ChannelTitle,
    string PublishedAt, long Views, string Duration, int DurationSeconds, bool AgeRestricted);
record VideoComment(string Id, string Text, string Author, string? AuthorThumbnail, string PublishedAt, long Likes);
record CommentPage(IReadOnlyList<VideoComment> Comments, string? NextPageToken);
record ThumbnailImage(byte[] Bytes, string ContentType);

sealed class YouTubeApiException(string message, int statusCode = 502) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

sealed class YouTubeDataClient(HttpClient http, IConfiguration config)
{
    private readonly string? _key = config["YouTube:ApiKey"];
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private const int MaxParallelRequests = 6;

    public async Task<ChannelItem?> ResolveChannelAsync(string? id, string? handle, CancellationToken ct)
    {
        var key = RequireKey();
        var query = id is not null
            ? $"channels?part=snippet,contentDetails&id={Uri.EscapeDataString(id)}&key={Uri.EscapeDataString(key)}"
            : $"channels?part=snippet,contentDetails&forHandle={Uri.EscapeDataString(handle!)}&key={Uri.EscapeDataString(key)}";
        var response = await GetAsync<ChannelResponse>(query, ct);
        var item = response.Items.FirstOrDefault();
        return item is null ? null : ToChannel(item);
    }

    public async Task<IReadOnlyList<ChannelSearchItem>> SearchChannelsAsync(string query, string? language, bool safeSearch, CancellationToken ct)
    {
        var key = RequireKey();
        var languageQuery = string.IsNullOrWhiteSpace(language) ? "" : $"&relevanceLanguage={Uri.EscapeDataString(language)}";
        var safeSearchQuery = safeSearch ? "&safeSearch=strict" : "";
        var response = await GetAsync<SearchResponse>(
            $"search?part=snippet&type=channel&maxResults=12&q={Uri.EscapeDataString(query)}{languageQuery}{safeSearchQuery}&key={Uri.EscapeDataString(key)}", ct);
        var matches = response.Items.Where(item => !string.IsNullOrWhiteSpace(item.Id?.ChannelId)).ToArray();
        if (matches.Length == 0) return [];
        var ids = matches.Select(item => item.Id!.ChannelId!).Distinct(StringComparer.Ordinal).ToArray();
        var details = await GetAsync<ChannelResponse>(
            $"channels?part=snippet,statistics&id={Uri.EscapeDataString(string.Join(',', ids))}&key={Uri.EscapeDataString(key)}", ct);
        var detailsById = details.Items.ToDictionary(item => item.Id, StringComparer.Ordinal);
        return matches.Select(item =>
            {
                var id = item.Id!.ChannelId!;
                detailsById.TryGetValue(id, out var channel);
                return new ChannelSearchItem(id, item.Snippet?.Title ?? channel?.Snippet?.Title ?? "YouTube channel",
                    item.Snippet?.Description ?? channel?.Snippet?.Description, BestThumbnail(item.Snippet?.Thumbnails) ?? BestThumbnail(channel?.Snippet?.Thumbnails),
                    long.TryParse(channel?.Statistics?.SubscriberCount, out var subscribers) ? subscribers : 0,
                    long.TryParse(channel?.Statistics?.ViewCount, out var views) ? views : 0);
            })
            .OrderByDescending(item => item.Subscribers)
            .ThenByDescending(item => item.Views)
            .ToArray();
    }

    public async Task<FeedPage> GetVideosAsync(string[] channelIds, IReadOnlyDictionary<string, string> pageTokens, int? requestedPageSize, CancellationToken ct)
    {
        var key = RequireKey();
        var channelIdBatches = channelIds.Chunk(50).ToArray();
        var channelResults = new List<ChannelDto>[channelIdBatches.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, channelIdBatches.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var response = await GetAsync<ChannelResponse>(
                $"channels?part=snippet,contentDetails&id={Uri.EscapeDataString(string.Join(',', channelIdBatches[index]))}&key={Uri.EscapeDataString(key)}", token);
            channelResults[index] = response.Items;
        });
        var channels = channelResults.SelectMany(items => items ?? []).ToArray();
        var playlists = channels.Select(channel => (channel.Id, PlaylistId: channel.ContentDetails?.RelatedPlaylists?.Uploads))
            .Where(item => !string.IsNullOrWhiteSpace(item.Id) && !string.IsNullOrWhiteSpace(item.PlaylistId)).ToArray();
        var perChannelPageSize = requestedPageSize ?? Math.Clamp(300 / Math.Max(1, playlists.Length), 1, 20);
        var playlistResults = new PlaylistPageResult[playlists.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, playlists.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var item = playlists[index];
            try
            {
                var pageToken = pageTokens.GetValueOrDefault(item.Id);
                var tokenQuery = string.IsNullOrWhiteSpace(pageToken) ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}";
                var page = await GetAsync<PlaylistResponse>(
                    $"playlistItems?part=contentDetails&playlistId={Uri.EscapeDataString(item.PlaylistId!)}&maxResults={perChannelPageSize}{tokenQuery}&key={Uri.EscapeDataString(key)}", token);
                playlistResults[index] = new PlaylistPageResult(item.Id, page.Items.Select(x => x.ContentDetails?.VideoId)
                    .Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id!).ToArray(), page.NextPageToken);
            }
            catch (YouTubeApiException ex) when (ex.StatusCode == StatusCodes.Status404NotFound)
            {
                playlistResults[index] = new PlaylistPageResult(item.Id, [], null);
            }
        });
        var batches = playlistResults.SelectMany(page => page.VideoIds).Distinct().Chunk(50).ToArray();
        var videoResults = new List<VideoItem>[batches.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, batches.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var response = await GetAsync<VideoResponse>(
                $"videos?part=snippet,contentDetails,statistics&id={Uri.EscapeDataString(string.Join(',', batches[index]))}&key={Uri.EscapeDataString(key)}", token);
            videoResults[index] = response.Items.Select(video =>
            {
                var seconds = ParseDuration(video.ContentDetails?.Duration);
                return new VideoItem(video.Id, video.Snippet?.Title ?? "Untitled video", video.Snippet?.Description,
                    BestThumbnail(video.Snippet?.Thumbnails), video.Snippet?.ChannelId ?? "", video.Snippet?.ChannelTitle ?? "YouTube channel",
                    video.Snippet?.PublishedAt ?? "", long.TryParse(video.Statistics?.ViewCount, out var views) ? views : 0,
                    FormatDuration(seconds), seconds, video.ContentDetails?.ContentRating?.YtRating == "ytAgeRestricted");
            }).ToList();
        });
        var videos = videoResults.SelectMany(items => items ?? []).ToList();
        var nextPageTokens = playlistResults.Where(page => !string.IsNullOrWhiteSpace(page.NextPageToken))
            .ToDictionary(page => page.ChannelId, page => page.NextPageToken!, StringComparer.Ordinal);
        return new FeedPage(videos.OrderByDescending(v => v.Views).ToArray(), nextPageTokens, perChannelPageSize);
    }

    public async Task<IReadOnlyList<VideoItem>> GetLatestUploadsAsync(string[] channelIds, CancellationToken ct)
    {
        var key = RequireKey();
        var channelBatches = channelIds.Chunk(50).ToArray();
        var channelResults = new List<ChannelDto>[channelBatches.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, channelBatches.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var response = await GetAsync<ChannelResponse>(
                $"channels?part=contentDetails&id={Uri.EscapeDataString(string.Join(',', channelBatches[index]))}&key={Uri.EscapeDataString(key)}", token);
            channelResults[index] = response.Items;
        });

        var channelPlaylists = channelResults.SelectMany(items => items ?? [])
            .Select(channel => (ChannelId: channel.Id, PlaylistId: channel.ContentDetails?.RelatedPlaylists?.Uploads))
            .Where(item => !string.IsNullOrWhiteSpace(item.ChannelId) && !string.IsNullOrWhiteSpace(item.PlaylistId)).ToArray();
        var latestByChannel = new (string ChannelId, string VideoId)?[channelPlaylists.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, channelPlaylists.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var item = channelPlaylists[index];
            try
            {
                var page = await GetAsync<PlaylistResponse>(
                    $"playlistItems?part=contentDetails&playlistId={Uri.EscapeDataString(item.PlaylistId!)}&maxResults=1&key={Uri.EscapeDataString(key)}", token);
                var videoId = page.Items.FirstOrDefault()?.ContentDetails?.VideoId;
                if (!string.IsNullOrWhiteSpace(videoId)) latestByChannel[index] = (item.ChannelId!, videoId);
            }
            catch (YouTubeApiException ex) when (ex.StatusCode == StatusCodes.Status404NotFound) { }
        });

        var latest = latestByChannel.Where(item => item.HasValue).Select(item => item!.Value).ToArray();
        var videoBatches = latest.Select(item => item.VideoId).Distinct(StringComparer.Ordinal).Chunk(50).ToArray();
        var videoResults = new List<VideoItem>[videoBatches.Length];
        await Parallel.ForEachAsync(Enumerable.Range(0, videoBatches.Length), new ParallelOptions { MaxDegreeOfParallelism = MaxParallelRequests, CancellationToken = ct }, async (index, token) =>
        {
            var response = await GetAsync<VideoResponse>(
                $"videos?part=snippet,contentDetails,statistics&id={Uri.EscapeDataString(string.Join(',', videoBatches[index]))}&key={Uri.EscapeDataString(key)}", token);
            videoResults[index] = response.Items.Select(video =>
            {
                var seconds = ParseDuration(video.ContentDetails?.Duration);
                return new VideoItem(video.Id, video.Snippet?.Title ?? "Untitled video", video.Snippet?.Description,
                    BestThumbnail(video.Snippet?.Thumbnails), video.Snippet?.ChannelId ?? "", video.Snippet?.ChannelTitle ?? "YouTube channel",
                    video.Snippet?.PublishedAt ?? "", long.TryParse(video.Statistics?.ViewCount, out var views) ? views : 0,
                    FormatDuration(seconds), seconds, video.ContentDetails?.ContentRating?.YtRating == "ytAgeRestricted");
            }).ToList();
        });
        return videoResults.SelectMany(items => items ?? []).OrderByDescending(video => video.PublishedAt, StringComparer.Ordinal).ToArray();
    }

    public async Task<CommentPage> GetCommentsAsync(string videoId, string? pageToken, CancellationToken ct)
    {
        var key = RequireKey();
        var query = $"commentThreads?part=snippet&videoId={Uri.EscapeDataString(videoId)}&maxResults=30&order=relevance&textFormat=plainText&key={Uri.EscapeDataString(key)}" +
            (string.IsNullOrWhiteSpace(pageToken) ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        var response = await GetAsync<CommentThreadResponse>(query, ct);
        var comments = response.Items.Select(item => item.Snippet?.TopLevelComment is { } top
            ? new VideoComment(top.Id ?? "", top.Snippet?.TextDisplay ?? "", top.Snippet?.AuthorDisplayName ?? "YouTube user",
                top.Snippet?.AuthorProfileImageUrl, top.Snippet?.PublishedAt ?? "", top.Snippet?.LikeCount ?? 0)
            : null).OfType<VideoComment>().ToArray();
        return new CommentPage(comments, response.NextPageToken);
    }

    private string RequireKey() => string.IsNullOrWhiteSpace(_key)
        ? throw new YouTubeApiException("The server has no YouTube Data API key yet. Add YouTube__ApiKey to its environment, then restart Ttube.", 503)
        : _key;

    private async Task<T> GetAsync<T>(string path, CancellationToken ct)
    {
        using var response = await http.GetAsync(path, ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadFromJsonAsync<GoogleErrorResponse>(JsonOptions, ct);
            var reason = detail?.Error?.Errors?.FirstOrDefault()?.Reason;
            var message = response.StatusCode == HttpStatusCode.Forbidden
                ? $"YouTube rejected the request ({reason ?? "forbidden"}). Check the API key restrictions and remaining quota."
                : $"YouTube returned {(int)response.StatusCode} ({reason ?? detail?.Error?.Status ?? "request_failed"}): {detail?.Error?.Message ?? "request failed"}";
            throw new YouTubeApiException(message, response.StatusCode == HttpStatusCode.Forbidden ? 502 : (int)response.StatusCode);
        }
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, ct) ?? throw new YouTubeApiException("YouTube returned an empty response.");
    }

    private static ChannelItem ToChannel(ChannelDto x) => new(x.Id, x.Snippet?.Title ?? "YouTube channel",
        BestThumbnail(x.Snippet?.Thumbnails), x.Snippet?.CustomUrl, x.ContentDetails?.RelatedPlaylists?.Uploads ?? "");
    private static string? BestThumbnail(Thumbnails? t) => t?.High?.Url ?? t?.Medium?.Url ?? t?.Default?.Url;
    private static int ParseDuration(string? value)
    {
        try { return (int)System.Xml.XmlConvert.ToTimeSpan(value ?? "PT0S").TotalSeconds; }
        catch { return 0; }
    }
    private static string FormatDuration(int s) => $"{s / 3600:00}:{s % 3600 / 60:00}:{s % 60:00}";

    private sealed class ChannelResponse { public List<ChannelDto> Items { get; set; } = []; }
    private sealed class ChannelDto { public string Id { get; set; } = ""; public Snippet? Snippet { get; set; } public ContentDetails? ContentDetails { get; set; } public Statistics? Statistics { get; set; } }
    private sealed class SearchResponse { public List<SearchResultDto> Items { get; set; } = []; }
    private sealed class SearchResultDto { public SearchId? Id { get; set; } public Snippet? Snippet { get; set; } }
    private sealed class SearchId { public string? ChannelId { get; set; } }
    private sealed class PlaylistResponse { public List<PlaylistItemDto> Items { get; set; } = []; public string? NextPageToken { get; set; } }
    private sealed class PlaylistItemDto { public PlaylistContent? ContentDetails { get; set; } }
    private sealed class PlaylistContent { public string? VideoId { get; set; } }
    private sealed record PlaylistPageResult(string ChannelId, string[] VideoIds, string? NextPageToken);
    private sealed class VideoResponse { public List<VideoDto> Items { get; set; } = []; }
    private sealed class VideoDto { public string Id { get; set; } = ""; public Snippet? Snippet { get; set; } public ContentDetails? ContentDetails { get; set; } public Statistics? Statistics { get; set; } }
    private sealed class Snippet { public string? Title { get; set; } public string? Description { get; set; } public string? PublishedAt { get; set; } public string? ChannelId { get; set; } public string? ChannelTitle { get; set; } public string? CustomUrl { get; set; } public Thumbnails? Thumbnails { get; set; } }
    private sealed class ContentDetails { public RelatedPlaylists? RelatedPlaylists { get; set; } public string? Duration { get; set; } public ContentRating? ContentRating { get; set; } }
    private sealed class ContentRating { public string? YtRating { get; set; } }
    private sealed class RelatedPlaylists { public string? Uploads { get; set; } }
    private sealed class Statistics { public string? ViewCount { get; set; } public string? SubscriberCount { get; set; } }
    private sealed class Thumbnails { [JsonPropertyName("default")] public Thumbnail? Default { get; set; } public Thumbnail? Medium { get; set; } public Thumbnail? High { get; set; } }
    private sealed class Thumbnail { public string? Url { get; set; } }
    private sealed class CommentThreadResponse { public List<CommentThreadDto> Items { get; set; } = []; public string? NextPageToken { get; set; } }
    private sealed class CommentThreadDto { public CommentThreadSnippet? Snippet { get; set; } }
    private sealed class CommentThreadSnippet { public CommentDto? TopLevelComment { get; set; } }
    private sealed class CommentDto { public string? Id { get; set; } public CommentSnippet? Snippet { get; set; } }
    private sealed class CommentSnippet { public string? TextDisplay { get; set; } public string? AuthorDisplayName { get; set; } public string? AuthorProfileImageUrl { get; set; } public string? PublishedAt { get; set; } public long? LikeCount { get; set; } }
    private sealed class GoogleErrorResponse { public GoogleError? Error { get; set; } }
    private sealed class GoogleError { public int? Code { get; set; } public string? Message { get; set; } public string? Status { get; set; } public List<GoogleErrorItem>? Errors { get; set; } }
    private sealed class GoogleErrorItem { public string? Reason { get; set; } }
}

sealed class ChannelImportStore(IDistributedCache cache)
{
    private static readonly JsonSerializerOptions JsonOptions = JsonSerializerOptions.Web;

    public async Task<string> StartAuthorizationAsync(string redirectUri, CancellationToken ct)
    {
        var state = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        await cache.SetStringAsync($"ttube:oauth-state:{state}", redirectUri,
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10) }, ct);
        return state;
    }

    public async Task<string?> CompleteAuthorizationAsync(string state, CancellationToken ct)
    {
        var key = $"ttube:oauth-state:{state}";
        var redirectUri = await cache.GetStringAsync(key, ct);
        await cache.RemoveAsync(key, ct);
        return redirectUri;
    }

    public async Task<string> StoreResultAsync(IReadOnlyList<ChannelItem> channels, CancellationToken ct)
    {
        var id = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        await cache.SetStringAsync($"ttube:import-result:{id}", JsonSerializer.Serialize(channels, JsonOptions),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) }, ct);
        return id;
    }

    public async Task<IReadOnlyList<ChannelItem>?> TakeResultAsync(string id, CancellationToken ct)
    {
        var key = $"ttube:import-result:{id}";
        var json = await cache.GetStringAsync(key, ct);
        if (json is null) return null;
        await cache.RemoveAsync(key, ct);
        return JsonSerializer.Deserialize<ChannelItem[]>(json, JsonOptions);
    }
}

sealed class YouTubeOAuthException(string userMessage) : Exception(userMessage)
{
    public string UserMessage { get; } = userMessage;
}

sealed class YouTubeOAuthClient(HttpClient http)
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task<IReadOnlyList<ChannelItem>> ImportSubscriptionsAsync(
        string authorizationCode, string redirectUri, string clientId, string clientSecret, CancellationToken ct)
    {
        using var tokenRequest = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["code"] = authorizationCode,
                ["client_id"] = clientId,
                ["client_secret"] = clientSecret,
                ["redirect_uri"] = redirectUri,
                ["grant_type"] = "authorization_code"
            })
        };
        using var tokenResponse = await http.SendAsync(tokenRequest, ct);
        if (!tokenResponse.IsSuccessStatusCode)
            throw new YouTubeOAuthException("token_exchange_failed");
        var token = await tokenResponse.Content.ReadFromJsonAsync<OAuthTokenResponse>(JsonOptions, ct);
        if (string.IsNullOrWhiteSpace(token?.AccessToken)) throw new YouTubeOAuthException("token_exchange_failed");

        var channels = new List<ChannelItem>();
        string? pageToken = null;
        do
        {
            var query = "subscriptions?part=snippet&mine=true&maxResults=50" +
                (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
            using var request = new HttpRequestMessage(HttpMethod.Get, query);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.AccessToken);
            using var response = await http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) throw new YouTubeOAuthException("subscription_read_failed");
            var page = await response.Content.ReadFromJsonAsync<SubscriptionPage>(JsonOptions, ct)
                ?? throw new YouTubeOAuthException("subscription_read_failed");
            foreach (var item in page.Items)
            {
                var channelId = item.Snippet?.ResourceId?.ChannelId;
                if (string.IsNullOrWhiteSpace(channelId)) continue;
                var thumbnail = item.Snippet?.Thumbnails?.High?.Url ?? item.Snippet?.Thumbnails?.Medium?.Url ?? item.Snippet?.Thumbnails?.Default?.Url;
                channels.Add(new ChannelItem(channelId, item.Snippet?.Title ?? "YouTube channel", thumbnail, null, ""));
            }
            pageToken = page.NextPageToken;
        } while (!string.IsNullOrWhiteSpace(pageToken));

        return channels.GroupBy(channel => channel.Id, StringComparer.Ordinal).Select(group => group.First())
            .OrderBy(channel => channel.Title, StringComparer.CurrentCultureIgnoreCase).ToArray();
    }

    private sealed class OAuthTokenResponse { [JsonPropertyName("access_token")] public string? AccessToken { get; set; } }
    private sealed class SubscriptionPage { public List<SubscriptionItem> Items { get; set; } = []; [JsonPropertyName("nextPageToken")] public string? NextPageToken { get; set; } }
    private sealed class SubscriptionItem { public SubscriptionSnippet? Snippet { get; set; } }
    private sealed class SubscriptionSnippet { public string? Title { get; set; } public SubscriptionResourceId? ResourceId { get; set; } public Thumbnails? Thumbnails { get; set; } }
    private sealed class SubscriptionResourceId { public string? ChannelId { get; set; } }
    private sealed class Thumbnails { [JsonPropertyName("default")] public Thumbnail? Default { get; set; } public Thumbnail? Medium { get; set; } public Thumbnail? High { get; set; } }
    private sealed class Thumbnail { public string? Url { get; set; } }
}

sealed class ThumbnailProxyClient(HttpClient http)
{
    private const int MaxImageBytes = 2 * 1024 * 1024;
    private static readonly HashSet<string> AllowedHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "yt3.ggpht.com", "yt3.googleusercontent.com"
    };

    public bool IsAllowedSource(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && IsAllowedHost(uri.Host);

    public async Task<ThumbnailImage?> FetchAsync(string value, CancellationToken ct)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var current) || !IsAllowedSource(value)) return null;
        for (var redirects = 0; redirects <= 4; redirects++)
        {
            if (!IsAllowedHost(current.Host) || current.Scheme != Uri.UriSchemeHttps) return null;
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
            {
                if (response.Headers.Location is not { } location) return null;
                current = location.IsAbsoluteUri ? location : new Uri(current, location);
                continue;
            }
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength is > MaxImageBytes) return null;
            var contentType = response.Content.Headers.ContentType?.MediaType;
            if (contentType is not ("image/jpeg" or "image/png" or "image/webp" or "image/gif")) return null;
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            return bytes.Length is > 0 and <= MaxImageBytes ? new ThumbnailImage(bytes, contentType) : null;
        }
        return null;
    }

    private static bool IsAllowedHost(string host) => AllowedHosts.Contains(host) ||
        host.EndsWith(".ggpht.com", StringComparison.OrdinalIgnoreCase) ||
        host.EndsWith(".googleusercontent.com", StringComparison.OrdinalIgnoreCase);
}
