(() => {
  const $ = (selector) => document.querySelector(selector);
  const STORE = 'ttube.channels.v1';
  const SETTINGS_STORE = 'ttube.settings.v1';
  const LOCATION_STORE = 'ttube.location.v1';
  const THEME_STORE = 'ttube.theme.v1';
  let channels = readChannels();
  let settings = readSettings();
  const previousVisitAt = Number(settings.lastVisitAt) || 0;
  const sessionStartedAt = Date.now();
  let videos = [];
  let activeFilter = 'all';
  let activeChannel = null;
  let view = 'home';
  let currentVideo = null;
  let commentsNextPage = null;
  let videoLimit = 24;
  let feedRequestId = 0;
  let nextPageTokens = {};
  let feedPageSize = 20;
  let notificationChannelFilter = null;
  let channelNotificationsPending = false;
  let playerIdleTimer = null;
  let youtubeApiPromise = null;
  let youtubePlayer = null;
  let externalSearchRequestId = 0;
  let externalChannels = [];
  let relatedDiscoveryActive = false;
  let exploreSearchActive = false;
  let toastTimer;
  let uploadCheckRunning = false;
  let feedRetryTimer = null;
  let feedRetryAttempt = 0;
  let feedLastSuccess = 0;
  let feedAbortController = null;
  let feedInFlightKey = '';
  let savedLocation = readLocation();
  let sleepTimer = null;

  function readChannels() {
    try { const value = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }
  function readSettings() {
    try {
      const value = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}');
      return {
        smartSuggestions: value.smartSuggestions !== false,
        hiddenRecommendations: Array.isArray(value.hiddenRecommendations) ? value.hiddenRecommendations.slice(0, 200) : [],
        uploadNotifications: value.uploadNotifications === true,
        videoMetaFont: ['default', 'arial', 'tahoma', 'segoe'].includes(value.videoMetaFont) ? value.videoMetaFont : 'default',
        videoMetaFontSize: Math.min(16, Math.max(10, Number(value.videoMetaFontSize) || 12)),
        uploadBaselineReady: value.uploadBaselineReady === true,
        knownUploadIds: Array.isArray(value.knownUploadIds) ? value.knownUploadIds.slice(0, 600) : [],
        knownChannelIds: Array.isArray(value.knownChannelIds) ? value.knownChannelIds.slice(0, 500) : [],
        notifications: Array.isArray(value.notifications) ? value.notifications.slice(0, 40) : [],
        watchHistory: Array.isArray(value.watchHistory) ? value.watchHistory.slice(0, 100) : [],
        watchLater: Array.isArray(value.watchLater) ? value.watchLater.slice(0, 300) : [],
        lastUploadCheck: Number(value.lastUploadCheck) || 0,
        lastVisitAt: Number(value.lastVisitAt) || 0
      };
    } catch {
      return { smartSuggestions: true, hiddenRecommendations: [], uploadNotifications: false, videoMetaFont: 'default', videoMetaFontSize: 12, uploadBaselineReady: false, knownUploadIds: [], knownChannelIds: [], notifications: [], watchHistory: [], watchLater: [], lastUploadCheck: 0, lastVisitAt: 0 };
    }
  }
  function persist() { localStorage.setItem(STORE, JSON.stringify(channels)); }
  function persistSettings() { localStorage.setItem(SETTINGS_STORE, JSON.stringify(settings)); }
  function recordWatchHistory(video) {
    const entry = { ...video, watchedAt: new Date().toISOString() };
    settings.watchHistory = [entry, ...settings.watchHistory.filter(item => item.id !== video.id)].slice(0, 100);
    persistSettings();
  }
  function isWatchLater(videoId) { return settings.watchLater.some(item => item.id === videoId); }
  function toggleWatchLater(video) {
    const index = settings.watchLater.findIndex(item => item.id === video.id);
    if (index >= 0) {
      settings.watchLater.splice(index, 1);
      notify('أُزيل الفيديو من المشاهدة لاحقًا');
    } else {
      settings.watchLater = [{ ...video, savedAt: new Date().toISOString() }, ...settings.watchLater].slice(0, 300);
      notify('أُضيف الفيديو إلى المشاهدة لاحقًا');
    }
    persistSettings();
    renderWatchLaterCount();
    renderVideos();
    renderSmartRecommendations();
    updateWatchLaterButton(video);
  }
  function updateWatchLaterButton(video) {
    const button = $('#watchLaterButton');
    if (!button || !video) return;
    const saved = isWatchLater(video.id);
    button.textContent = saved ? '✓' : '＋';
    button.setAttribute('aria-label', saved ? 'إزالة من المشاهدة لاحقًا' : 'إضافة إلى المشاهدة لاحقًا');
    button.title = saved ? 'إزالة من المشاهدة لاحقًا' : 'مشاهدة لاحقًا';
    button.classList.toggle('saved', saved);
  }
  function renderWatchLaterCount() {
    const count = $('#watchLaterCount');
    if (count) count.textContent = settings.watchLater.length.toLocaleString('ar-EG');
  }
  function applyVideoTypography() {
    const fonts = {
      default: "'IBM Plex Sans Arabic','DM Sans',sans-serif",
      arial: 'Arial,sans-serif',
      tahoma: 'Tahoma,Arial,sans-serif',
      segoe: "'Segoe UI',Tahoma,sans-serif"
    };
    const size = Math.min(16, Math.max(10, Number(settings.videoMetaFontSize) || 12));
    document.documentElement.style.setProperty('--video-meta-font', fonts[settings.videoMetaFont] || fonts.default);
    document.documentElement.style.setProperty('--video-meta-size', `${size}px`);
    const fontInput = $('#videoMetaFont'); const sizeInput = $('#videoMetaFontSize'); const output = $('#videoMetaFontSizeValue');
    if (fontInput) fontInput.value = settings.videoMetaFont;
    if (sizeInput) sizeInput.value = String(size);
    if (output) output.textContent = `${size}px`;
  }
  function readLocation() {
    try {
      const value = JSON.parse(localStorage.getItem(LOCATION_STORE) || 'null');
      return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) ? value : null;
    } catch { return null; }
  }
  function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function proxyImage(url) { return `/api/channel-thumbnail?url=${encodeURIComponent(url)}`; }
  function installAvatarFallbacks(root) {
    root.querySelectorAll('img[data-avatar-fallback]').forEach(img => img.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = img.dataset.fallbackClass || 'channel-avatar channel-letter';
      fallback.textContent = img.dataset.avatarFallback || 'ق';
      img.replaceWith(fallback);
    }, { once: true }));
  }
  function notify(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
  function applyTheme(theme) {
    const light = theme === 'light';
    document.body.classList.toggle('theme-light', light);
    const button = $('#themeToggle');
    button.setAttribute('aria-pressed', String(light));
    button.setAttribute('aria-label', light ? 'التبديل إلى الوضع الليلي' : 'التبديل إلى الوضع النهاري');
    button.title = light ? 'التبديل إلى الوضع الليلي' : 'التبديل إلى الوضع النهاري';
    button.innerHTML = light
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.2A8.8 8.8 0 0 1 8.8 3.5 8.9 8.9 0 1 0 20.5 15.2Z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>';
  }
  function updateClock() {
    $('#clockLabel').textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  }
  function weatherDescription(code) {
    if (code === 0) return ['☀', 'سماء صافية'];
    if ([1, 2].includes(code)) return ['🌤', 'غائم جزئيًا'];
    if (code === 3) return ['☁', 'غائم'];
    if ([45, 48].includes(code)) return ['🌫', 'ضباب'];
    if ([51, 53, 55, 56, 57].includes(code)) return ['🌦', 'رذاذ'];
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ['🌧', 'أمطار'];
    if ([71, 73, 75, 77, 85, 86].includes(code)) return ['❄', 'ثلوج'];
    if ([95, 96, 99].includes(code)) return ['⛈', 'عواصف رعدية'];
    return ['🌡', 'الطقس الحالي'];
  }
  function showPrayerTimes(timings) {
    const prayers = [['Fajr', 'الفجر'], ['Dhuhr', 'الظهر'], ['Asr', 'العصر'], ['Maghrib', 'المغرب'], ['Isha', 'العشاء']];
    $('#prayerTimes').innerHTML = prayers.map(([key, label]) => {
      const time = String(timings?.[key] || '--:--').replace(/\s*\([^)]*\)\s*/g, '').trim();
      return `<div class="prayer-time"><span>${label}</span><b>${escapeHtml(time)}</b></div>`;
    }).join('');
  }
  async function loadLocationDashboard(location, { weather = true, prayer = true } = {}) {
    const tasks = [];
    if (weather) tasks.push((async () => {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude, current: 'temperature_2m,weather_code', timezone: 'auto' });
      const response = await fetch(url);
      if (!response.ok) throw new Error('weather');
      const payload = await response.json(); const [icon, label] = weatherDescription(Number(payload.current?.weather_code));
      $('#weatherIcon').textContent = icon; $('#weatherTemperature').textContent = `${Math.round(Number(payload.current?.temperature_2m))}°`;
      $('#weatherLabel').textContent = label;
      const zoneName = String(payload.timezone || '').split('/').pop()?.replaceAll('_', ' ');
      if (zoneName) $('#locationLabel').textContent = zoneName;
    })());
    if (prayer) tasks.push((async () => {
      const now = new Date();
      const date = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
      const url = new URL(`https://api.aladhan.com/v1/timings/${date}`);
      url.search = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude });
      const response = await fetch(url);
      if (!response.ok) throw new Error('prayer');
      const payload = await response.json();
      if (payload.code !== 200 || !payload.data?.timings) throw new Error('prayer');
      showPrayerTimes(payload.data.timings);
    })());
    const results = await Promise.allSettled(tasks);
    if (weather && results[0]?.status === 'rejected') $('#weatherLabel').textContent = 'تعذّر تحميل الطقس';
    if (prayer && results[weather ? 1 : 0]?.status === 'rejected') $('#prayerTimes').innerHTML = '<span class="prayer-placeholder">تعذّر تحميل مواقيت الصلاة</span>';
    $('#locationButton').textContent = 'تحديث موقعي';
  }
  function requestUserLocation() {
    if (!navigator.geolocation) { notify('المتصفح لا يدعم تحديد الموقع.'); return; }
    const button = $('#locationButton'); button.disabled = true; button.textContent = 'جارٍ تحديد الموقع…';
    navigator.geolocation.getCurrentPosition(async position => {
      savedLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      localStorage.setItem(LOCATION_STORE, JSON.stringify(savedLocation));
      $('#locationLabel').textContent = 'جارٍ تحميل بيانات موقعك…';
      try { await loadLocationDashboard(savedLocation); }
      finally { button.disabled = false; }
    }, error => {
      button.disabled = false; button.textContent = savedLocation ? 'تحديث موقعي' : 'استخدم موقعي';
      $('#locationLabel').textContent = error.code === error.PERMISSION_DENIED ? 'إذن الموقع مرفوض' : 'تعذّر تحديد الموقع';
      notify(error.code === error.PERMISSION_DENIED ? 'اسمح بالموقع من إعدادات المتصفح لاستخدام الطقس والمواقيت.' : 'تعذّر تحديد الموقع. حاول مرة أخرى.');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 15 * 60 * 1000 });
  }
  function initials(name) { return escapeHtml((name || 'ق').trim().slice(0, 1)); }
  function showFeedMessage(title, detail, loading = false) {
    const empty = $('#feedEmpty');
    empty.classList.toggle('is-loading', loading);
    empty.innerHTML = `<span>${loading ? '' : '⌕'}</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail)}</p>`;
    empty.hidden = false;
  }
  function closeSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) $('#sidebar').classList.remove('open');
    syncSidebarButton();
  }
  function syncSidebarButton() {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    const open = mobile ? $('#sidebar').classList.contains('open') : !document.body.classList.contains('sidebar-hidden');
    $('#sidebar').inert = !open;
    $('#sidebar').setAttribute('aria-hidden', String(!open));
    $('#menuButton').setAttribute('aria-expanded', String(open));
    $('#menuButton').setAttribute('aria-label', open ? (mobile ? 'إغلاق القائمة' : 'إخفاء الشريط الجانبي') : (mobile ? 'فتح القائمة' : 'إظهار الشريط الجانبي'));
  }

  function renderChannels() {
    const list = $('#channelList');
    $('#channelTotal').textContent = channels.length ? `(${channels.length.toLocaleString('ar-EG')})` : '';
    const channelQuery = normalizeSearchText($('#channelSearchInput')?.value || '');
    $('.channel-section').classList.toggle('searching', Boolean(channelQuery));
    const matches = channels.map((channel, index) => ({ channel, index })).filter(({ channel }) =>
      !channelQuery || normalizeSearchText(`${channel.title} ${channel.handle || ''}`).includes(channelQuery));
    list.innerHTML = matches.length ? matches.map(({ channel, index }) => `<div class="channel-item ${channel.id && activeChannel === channel.id ? 'selected' : ''}" data-index="${index}"><button class="channel-select" type="button" data-select="${index}" aria-pressed="${Boolean(channel.id && activeChannel === channel.id)}" title="${escapeHtml(channel.title)}">
      ${channel.thumbnail ? `<img class="channel-avatar remote-avatar" data-avatar-fallback="${initials(channel.title)}" data-fallback-class="channel-avatar channel-letter" src="${escapeHtml(proxyImage(channel.thumbnail))}" alt="">` : `<span class="channel-avatar channel-letter">${initials(channel.title)}</span>`}
      <span class="channel-name">${escapeHtml(channel.title)}</span>${!channel.id ? '<span title="بانتظار إعداد المفتاح">·</span>' : ''}</button><button class="remove-channel" type="button" data-remove="${index}" aria-label="إزالة ${escapeHtml(channel.title)} من قنواتك" title="إزالة القناة">×</button></div>`).join('')
      : `<div class="channel-search-empty">${channelQuery ? 'لا توجد قنوات بهذا الاسم.' : 'أضف قنواتك لتظهر هنا.'}</div>`;
    list.querySelectorAll('[data-select]').forEach((button) => {
      button.addEventListener('click', () => {
        const channel = channels[Number(button.dataset.select)];
        if (!channel.id) { notify('أكمل إعداد YouTube API لتحميل هذه القناة.'); return; }
        activeChannel = activeChannel === channel.id ? null : channel.id;
        notificationChannelFilter = activeChannel;
        channelNotificationsPending = Boolean(activeChannel);
      videoLimit = 24; loadFeed(); renderChannels();
      });
    });
    list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', (event) => {
      event.stopPropagation(); const channel = channels[Number(button.dataset.remove)];
      if (!channel) return;
      channels.splice(Number(button.dataset.remove), 1); if (activeChannel === channel.id) activeChannel = null;
      // Remove the channel's in-memory feed immediately so stale cards and smart suggestions disappear.
      feedRequestId++;
      feedAbortController?.abort();
      feedAbortController = null; feedInFlightKey = '';
      videos = videos.filter(video => video.channelId !== channel.id);
      nextPageTokens = {};
      persist(); renderChannels(); renderVideos(); loadFeed(); notify(`تم حذف ${channel.title} من قنواتك`);
    }));
    installAvatarFallbacks(list);
    $('#channelEntry').hidden = channels.length > 0;
    $('.hero-card').hidden = channels.length > 0;
    $('#feedArea').hidden = channels.length === 0;
    $('#pageTitle').innerHTML = channels.length
      ? 'مساحتك، على اختيارك<span class="title-period">.</span>'
      : 'أهلاً بك في Ttube<span class="title-period">.</span>';
    $('#pageSubtitle').textContent = channels.length
      ? 'فيديوهات من القنوات التي اخترتها.'
      : 'محتوى تحبه، من مصادر اخترتها بنفسك.';
  }

  function renderExternalChannels() {
    const panel = exploreSearchActive ? $('#exploreResults') : $('#externalSearchResults');
    if (!externalChannels.length) {
      panel.innerHTML = '<div class="search-empty">لم نعثر على قنوات مطابقة. جرّب كلمات أخرى.</div>';
      return;
    }
    const heading = exploreSearchActive ? 'قنوات تناسب اهتماماتك' : relatedDiscoveryActive ? 'قنوات قريبة من محتوى قنواتك' : 'قنوات من YouTube';
    const description = exploreSearchActive ? 'مرتبة حسب عدد المشتركين، مع تفضيل اللغة التي اخترتها.' : relatedDiscoveryActive ? 'اخترنا موضوعات من أحدث فيديوهات قنواتك' : 'أضف القناة لتظهر فيديوهاتها في Ttube';
    panel.innerHTML = `<div class="search-results-heading">${heading} <small>${description}</small></div>${externalChannels.map(channel => {
      const added = channels.some(item => item.id === channel.id);
      const subscribers = Number(channel.subscribers) || 0;
      const popularity = subscribers ? `${subscribers.toLocaleString('ar-EG')} مشترك` : 'عدد المشتركين مخفي';
      return `<article class="external-channel-result">${channel.thumbnail ? `<img src="${escapeHtml(proxyImage(channel.thumbnail))}" alt="">` : '<span class="external-channel-placeholder">▶</span>'}<div class="external-channel-copy"><b>${escapeHtml(channel.title)}</b><p class="channel-popularity">${popularity}</p><p>${escapeHtml(channel.description || '')}</p></div><button type="button" data-add-search-channel="${escapeHtml(channel.id)}" ${added ? 'disabled' : ''}>${added ? 'مضافة' : '＋ أضف'}</button></article>`;
    }).join('')}<div class="search-results-note">${exploreSearchActive ? 'تساعد التصفية على تقليل المحتوى الناضج ولا تضمن ملاءمة كل فيديو. أضف القنوات التي تثق بها فقط.' : 'هذه النتائج من خارج قائمتك؛ لن تظهر فيديوهاتها حتى تضيف القناة. يستخدم البحث حصة YouTube API المحدودة.'}</div>`;
    installAvatarFallbacks(panel);
  }
  async function searchExternalChannels(options = {}) {
    const query = (options.query ?? $('#searchInput').value).trim();
    if (query.length < 2) { notify('اكتب كلمتين أو أكثر للبحث في YouTube.'); return; }
    const requestId = ++externalSearchRequestId;
    const panel = exploreSearchActive ? $('#exploreResults') : $('#externalSearchResults');
    externalChannels = []; panel.hidden = false;
    panel.innerHTML = '<div class="search-loading">جارٍ البحث في قنوات YouTube…</div>';
    try {
      const queryParams = new URLSearchParams({ q: query });
      if (options.language) queryParams.set('language', options.language);
      if (options.safeSearch) queryParams.set('safeSearch', 'true');
      const response = await fetch(`/api/search/channels?${queryParams.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (requestId !== externalSearchRequestId) return;
      if (!response.ok) {
        panel.innerHTML = `<div class="search-error">${escapeHtml(payload.detail || 'تعذّر البحث في YouTube. تحقق من مفتاح API وحصته.')}</div>`;
        return;
      }
      externalChannels = Array.isArray(payload) ? payload : [];
      if (relatedDiscoveryActive) externalChannels = externalChannels.filter(result => !channels.some(channel => channel.id === result.id));
      renderExternalChannels();
    } catch {
      if (requestId === externalSearchRequestId) panel.innerHTML = '<div class="search-error">تعذّر الاتصال بالخادم. حاول مرة أخرى.</div>';
    }
  }
  function discoverRelatedChannels() {
    const selectedIds = new Set(channels.filter(channel => channel.id && (!activeChannel || channel.id === activeChannel)).map(channel => channel.id));
    const sourceVideos = videos.filter(video => selectedIds.has(video.channelId))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 120);
    if (!sourceVideos.length) { notify('حمّل فيديوهات قنواتك أولًا، ثم جرّب اكتشاف قنوات مشابهة.'); return; }
    const ignored = new Set(['official','channel','video','videos','episode','episodes','review','new','قناه','قناه','رسمي','الرسميه','حصري','الحلقه','حلقه','دروس','درس','كورس','دوره']);
    const topics = new Map();
    for (const video of sourceVideos) {
      const words = new Set([...contentTerms(video.title), ...contentTerms((video.description || '').slice(0, 220))]);
      for (const word of words) {
        if (ignored.has(word)) continue;
        const item = topics.get(word) || { channels: new Set(), count: 0 };
        item.channels.add(video.channelId); item.count++;
        topics.set(word, item);
      }
    }
    const query = [...topics.entries()].sort((a, b) => (b[1].channels.size * 3 + b[1].count * .2) - (a[1].channels.size * 3 + a[1].count * .2))
      .slice(0, 3).map(([word]) => word).join('|');
    const fallbackQuery = channels.filter(channel => selectedIds.has(channel.id)).slice(0, 2).map(channel => channel.title).join(' ');
    const discoveryQuery = (query || fallbackQuery).trim();
    if (discoveryQuery.length < 2) { notify('لم أجد موضوعات كافية لاكتشاف قنوات قريبة.'); return; }
    relatedDiscoveryActive = true;
    $('#searchMode').value = 'youtube';
    $('#searchMode').dispatchEvent(new Event('change'));
    $('#searchInput').value = discoveryQuery;
    $('#externalSearchResults').hidden = false;
    closeSidebar();
    searchExternalChannels();
  }
  function openExploreModal() {
    exploreSearchActive = true;
    relatedDiscoveryActive = false;
    externalChannels = [];
    $('#exploreResults').hidden = true;
    $('#exploreResults').replaceChildren();
    $('#exploreModal').hidden = false;
    $('#exploreQuery').focus();
  }
  function closeExploreModal() { $('#exploreModal').hidden = true; exploreSearchActive = false; }
  async function addExternalChannel(channelId, button) {
    if (channels.some(channel => channel.id === channelId)) { button.disabled = true; button.textContent = 'مضافة'; return; }
    button.disabled = true; button.textContent = 'جارٍ الإضافة…';
    try {
      const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
      const response = await fetch('/api/channels/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || 'تعذّرت إضافة القناة.');
      if (channels.some(channel => channel.id === payload.id)) { button.textContent = 'مضافة'; return; }
      channels.unshift({ ...payload, url }); persist(); activeChannel = null; renderChannels(); renderExternalChannels();
      await loadFeed(); notify(`أُضيفت قناة ${payload.title}`);
    } catch (error) {
      button.disabled = false; button.textContent = '＋ أضف'; notify(error.message || 'تعذّرت إضافة القناة.');
    }
  }

  function normalizeSearchText(value) {
    return String(value || '').toLocaleLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/c\s*\+\s*\+/g, ' cpp ').replace(/c\s*#|c\s*sharp/g, ' csharp ')
      .replace(/asp\s*\.?\s*net|\.net|dot\s*net/g, ' dotnet ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function searchTokens(value) {
    return normalizeSearchText(value).split(' ').filter(Boolean).map(token =>
      token.startsWith('ال') && token.length > 4 ? token.slice(2) : token);
  }
  function editDistanceAtMostOne(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; let j = 0; let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    if (i < a.length || j < b.length) edits++;
    return edits <= 1;
  }
  function fieldSearchScore(words, term) {
    let best = 0;
    for (const word of words) {
      if (word === term) return 1;
      if (Math.min(word.length, term.length) >= 3 && (word.startsWith(term) || term.startsWith(word))) best = Math.max(best, .78);
      else if (Math.min(word.length, term.length) >= 5 && editDistanceAtMostOne(word, term)) best = Math.max(best, .62);
    }
    return best;
  }
  function scoreVideoSearch(video, query, terms) {
    const title = normalizeSearchText(video.title);
    const channel = normalizeSearchText(video.channelTitle);
    const description = normalizeSearchText((video.description || '').slice(0, 1200));
    const fields = [
      { words: searchTokens(title), weight: 10 },
      { words: searchTokens(channel), weight: 7 },
      { words: searchTokens(description), weight: 2 }
    ];
    let matched = 0; let score = 0;
    for (const term of terms) {
      const relevance = Math.max(...fields.map(field => fieldSearchScore(field.words, term) * field.weight));
      if (relevance > 0) { matched++; score += relevance; }
    }
    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery && title.includes(normalizedQuery)) score += 18;
    else if (normalizedQuery && channel.includes(normalizedQuery)) score += 12;
    if (matched === terms.length && terms.length > 1) score += 10;
    return matched ? { video, score, matched } : null;
  }
  function getVisibleVideos() {
    const query = $('#searchInput').value.trim();
    const terms = [...new Set(searchTokens(query))];
    const sourceVideos = view === 'history' ? settings.watchHistory : view === 'watchlater' ? settings.watchLater : videos;
    const allowedIds = new Set(channels.filter(channel => channel.id).map(channel => channel.id));
    let result = sourceVideos.filter(video => view === 'history' || view === 'watchlater' || (allowedIds.has(video.channelId) && (!activeChannel || video.channelId === activeChannel)));
    const getVideo = row => terms.length ? row.video : row;
    const text = row => { const video = getVideo(row); return `${video.title} ${video.description || ''} ${video.channelTitle}`.toLocaleLowerCase(); };
    if (terms.length) result = result.map(video => scoreVideoSearch(video, query, terms)).filter(Boolean);
    if (activeFilter === 'islamic') result = result.filter(v => /قران|تفسير|حديث|اسلام|فقه|عقيده|السيره|النبوي|دعوه|شريعه|islam|quran|hadith|tafsir/i.test(normalizeSearchText(text(v))));
    if (activeFilter === 'dotnet') result = result.filter(v => /dotnet|aspnet|csharp|سي شارب|برمجه|visual studio|كورس|دوره|تعلم البرمجه|programming|course/i.test(normalizeSearchText(text(v))));
    if (activeFilter === 'shorts') result = result.filter(row => Number(getVideo(row).durationSeconds) <= 180 && Number(getVideo(row).durationSeconds) > 0);
    const newestFirst = (a, b) => Date.parse(view === 'history' ? b.watchedAt : view === 'watchlater' ? b.savedAt : b.publishedAt) - Date.parse(view === 'history' ? a.watchedAt : view === 'watchlater' ? a.savedAt : a.publishedAt);
    if (terms.length) result.sort((a, b) => b.score - a.score || newestFirst(a.video, b.video));
    else result.sort(newestFirst);
    return terms.length ? result.map(row => row.video) : result;
  }
  function formatViews(value) {
    const n = Number(value) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} مليار مشاهدة`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} مليون مشاهدة`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} ألف مشاهدة`;
    return `${n.toLocaleString('ar-EG')} مشاهدة`;
  }
  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'الآن';
    const relative = new Intl.RelativeTimeFormat('ar-EG', { numeric: 'auto' });
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (seconds >= size) return relative.format(-Math.floor(seconds / size), unit);
    }
    return 'الآن';
  }
  function relativeDateMarkup(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const exact = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full', timeStyle: 'short' }).format(date);
    return `<time datetime="${date.toISOString()}" title="${escapeHtml(exact)}" data-relative-date>${formatDate(value)}</time>`;
  }
  function videoCardMarkup(v, options = {}) {
    const short = Number(v.durationSeconds) > 0 && Number(v.durationSeconds) <= 180;
    const channel = channels.find(c => c.id === v.channelId);
    const avatar = channel?.thumbnail ? `<img class="video-channel-avatar remote-avatar" data-avatar-fallback="${initials(v.channelTitle)}" data-fallback-class="video-channel-avatar channel-letter" src="${escapeHtml(proxyImage(channel.thumbnail))}" alt="">` : `<span class="video-channel-avatar channel-letter">${initials(v.channelTitle)}</span>`;
    const cardDate = view === 'history' && v.watchedAt ? `شوهد ${relativeDateMarkup(v.watchedAt)}` : relativeDateMarkup(v.publishedAt);
    const saved = isWatchLater(v.id);
    const hide = options.recommendation ? '<button class="hide-recommendation" type="button" data-hide-recommendation aria-label="إخفاء هذا الاقتراح" title="إخفاء هذا الاقتراح">×</button>' : '';
    return `<article class="video-card" data-video="${escapeHtml(v.id)}" role="button" tabindex="0" aria-label="شاهد: ${escapeHtml(v.title)}"><div class="video-thumb"><img loading="lazy" src="${escapeHtml(v.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/hqdefault.jpg`)}" alt=""><span class="video-duration">${escapeHtml(v.duration || '')}</span>${short ? '<span class="video-badge">قصير</span>' : ''}${hide}<button class="watch-later-card ${saved ? 'saved' : ''}" type="button" data-watch-later="${escapeHtml(v.id)}" aria-label="${saved ? 'إزالة من المشاهدة لاحقًا' : 'إضافة إلى المشاهدة لاحقًا'}" title="${saved ? 'إزالة من المشاهدة لاحقًا' : 'مشاهدة لاحقًا'}">${saved ? '✓' : '＋'}</button></div><div class="video-info">${avatar}<div class="video-meta"><div class="video-title">${escapeHtml(v.title)}</div><div class="video-subtitle"><span>${escapeHtml(v.channelTitle)}</span><span>·</span><span>${formatViews(v.views)}</span><span>·</span><span>${cardDate}</span></div></div></div></article>`;
  }
  function smartRecommendations() {
    if (!settings.smartSuggestions || view !== 'home' || videos.length < 2) return [];
    const byDate = [...videos].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const seeds = byDate.slice(0, Math.min(8, Math.ceil(byDate.length / 3)));
    const seedIds = new Set(seeds.map(video => video.id));
    const documentFrequency = new Map();
    for (const seed of seeds) for (const term of contentTerms(`${seed.title} ${(seed.description || '').slice(0, 500)}`))
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    const idf = term => Math.log(1 + seeds.length / (1 + (documentFrequency.get(term) || 0)));
    const allowedIds = new Set(channels.filter(channel => channel.id).map(channel => channel.id));
    const scored = videos.filter(video => allowedIds.has(video.channelId) && !seedIds.has(video.id)).map(video => {
      const terms = contentTerms(`${video.title} ${(video.description || '').slice(0, 500)}`);
      let score = 0;
      for (const term of terms) if (documentFrequency.has(term)) score += idf(term);
      const date = Date.parse(video.publishedAt);
      const ageDays = Number.isFinite(date) ? Math.max(0, (Date.now() - date) / 86400000) : 90;
      const freshBoost = 1 / (1 + ageDays / 30);
      return { video, score: score + freshBoost * 0.15 + Math.log10(Number(video.views) + 1) * 0.015 };
    }).filter(row => row.score > 0.2).sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map(row => row.video);
  }
  function renderSmartRecommendations() {
    const section = $('#smartRecommendations');
    if (!section) return;
    const recommendations = smartRecommendations().filter(video => !settings.hiddenRecommendations.includes(video.id));
    section.hidden = !settings.smartSuggestions || view !== 'home' || recommendations.length === 0;
    $('#smartGrid').innerHTML = recommendations.map(video => videoCardMarkup(video, { recommendation: true })).join('');
    installAvatarFallbacks($('#smartGrid'));
    $('#smartGrid').querySelectorAll('.video-card').forEach(card => {
      card.querySelector('[data-watch-later]')?.addEventListener('click', event => { event.stopPropagation(); const video = videos.find(item => item.id === card.dataset.video); if (video) toggleWatchLater(video); });
      card.querySelector('[data-hide-recommendation]')?.addEventListener('click', event => { event.stopPropagation(); settings.hiddenRecommendations = [...new Set([...settings.hiddenRecommendations, card.dataset.video])].slice(-200); persistSettings(); renderSmartRecommendations(); notify('سأقلل هذا النوع من الاقتراحات'); });
      const open = () => { const video = videos.find(item => item.id === card.dataset.video); if (video) openPlayer(video); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  }
  function renderHomeHighlights() {
    const section = $('#homeHighlights');
    if (!section) return;
    const visible = view === 'home' && channels.length > 0;
    const continueItems = settings.watchHistory.slice().sort((a, b) => Date.parse(b.watchedAt) - Date.parse(a.watchedAt)).slice(0, 6);
    const newItems = videos.filter(video => !previousVisitAt || Date.parse(video.publishedAt) > previousVisitAt).slice(0, 6);
    section.hidden = !visible || (!continueItems.length && !newItems.length);
    const continueSection = $('#continueWatching'); const newSection = $('#newSinceVisit');
    continueSection.hidden = !continueItems.length;
    newSection.hidden = !newItems.length;
    const install = (root, items) => {
      root.innerHTML = items.map(videoCardMarkup).join('');
      root.querySelectorAll('.video-card').forEach(card => {
        const item = items.find(video => video.id === card.dataset.video);
        card.addEventListener('click', () => item && openPlayer(item));
        card.querySelector('[data-watch-later]')?.addEventListener('click', event => { event.stopPropagation(); if (item) toggleWatchLater(item); });
      });
    };
    install($('#continueGrid'), continueItems);
    install($('#newGrid'), newItems);
  }
  function renderNotifications() {
    const unread = settings.notifications.filter(item => !item.read).length;
    const badge = $('#notificationBadge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    $('#smartSuggestionsToggle').checked = settings.smartSuggestions;
    $('#uploadNotificationsToggle').checked = settings.uploadNotifications;
    const status = $('#notificationStatus');
    if (!settings.uploadNotifications) status.textContent = 'الإشعارات متوقفة. عند فتح قناة، ستظهر أحدث فيديوهاتها هنا.';
    else if (!('Notification' in window)) status.textContent = 'هذا المتصفح لا يدعم إشعارات النظام.';
    else if (Notification.permission === 'denied') status.textContent = 'الإذن مرفوض من المتصفح. غيّره من إعدادات الموقع.';
    else if (!channels.some(channel => channel.id)) status.textContent = 'أضف قنوات أولًا؛ بعدها سيفحص Ttube الرفعات كل 4 ساعات أثناء فتح الصفحة.';
    else status.textContent = 'الإشعارات مفعّلة؛ يفحص Ttube قنواتك كل 4 ساعات عند فتح الصفحة، ويعيد الفحص عند رجوعك إليها.';
    const list = $('#notificationList');
    const entries = (notificationChannelFilter
      ? settings.notifications.filter(item => item.channelId === notificationChannelFilter).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 8)
      : settings.notifications);
    const selectedChannel = channels.find(channel => channel.id === notificationChannelFilter);
    $('#notificationListHeading').textContent = selectedChannel ? `أحدث الفيديوهات · ${selectedChannel.title}` : 'أحدث الرفعات من قنواتك';
    list.innerHTML = entries.length ? entries.map(item => `<button class="notification-item" data-notification-video="${escapeHtml(item.id)}"><img loading="lazy" src="${escapeHtml(item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`)}" alt=""><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.channelTitle)} · ${formatDate(item.publishedAt)}</small></span></button>`).join('') : '<div class="notification-empty">ستظهر الفيديوهات الجديدة هنا.</div>';
  }
  function showLatestChannelNotifications(channelId, batch) {
    const channel = channels.find(item => item.id === channelId);
    const latest = batch.filter(video => video.channelId === channelId)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 5);
    if (!channel || !latest.length) return;
    const existing = new Map(settings.notifications.map(item => [item.id, item]));
    const fresh = latest.map(video => ({
      id: video.id, title: video.title, channelId: video.channelId, channelTitle: video.channelTitle || channel.title,
      thumbnail: video.thumbnail, publishedAt: video.publishedAt, duration: video.duration,
      durationSeconds: video.durationSeconds, views: video.views, ageRestricted: video.ageRestricted,
      read: existing.get(video.id)?.read ?? false
    }));
    settings.notifications = [...fresh, ...settings.notifications.filter(item => !fresh.some(video => video.id === item.id))].slice(0, 40);
    persistSettings();
    renderNotifications();
    $('#notificationsPanel').hidden = false;
    $('#notificationsButton').setAttribute('aria-expanded', 'true');
  }
  function processUploadBatch(batch, channelIds, suppressNew = false) {
    const previousIds = new Set(settings.knownUploadIds);
    const previousChannels = new Set(settings.knownChannelIds);
    const isFirstSnapshot = !settings.uploadBaselineReady;
    const newUploads = isFirstSnapshot || suppressNew ? [] : batch.filter(video => previousChannels.has(video.channelId) && !previousIds.has(video.id));
    const newNotices = (settings.uploadNotifications ? newUploads : []).map(video => ({
      id: video.id, title: video.title, channelId: video.channelId, channelTitle: video.channelTitle, thumbnail: video.thumbnail,
      publishedAt: video.publishedAt, duration: video.duration, durationSeconds: video.durationSeconds,
      views: video.views, ageRestricted: video.ageRestricted, read: false
    }));
    settings.notifications = [...newNotices, ...settings.notifications].slice(0, 40);
    settings.knownUploadIds = [...new Set([...batch.map(video => video.id), ...settings.knownUploadIds])].slice(0, 1000);
    settings.knownChannelIds = [...new Set(channelIds)].slice(0, 500);
    settings.uploadBaselineReady = true;
    settings.lastUploadCheck = Date.now();
    persistSettings();
    renderNotifications();
    if (settings.uploadNotifications && 'Notification' in window && Notification.permission === 'granted') {
      for (const item of newNotices.slice(0, 5)) {
        try {
          const notice = new Notification(item.title, { body: `فيديو جديد من ${item.channelTitle}`, icon: item.thumbnail || undefined, tag: item.id });
          notice.onclick = () => { window.focus(); const video = videos.find(candidate => candidate.id === item.id) || item; openPlayer(video); notice.close(); };
        } catch { /* Notifications can be unavailable in some browser contexts. */ }
      }
    }
  }
  async function checkForUploads(force = false, suppressNew = false) {
    if (uploadCheckRunning || !settings.uploadNotifications || !('Notification' in window) || Notification.permission !== 'granted' || document.hidden) return;
    const interval = 4 * 60 * 60 * 1000;
    if (!force && Date.now() - settings.lastUploadCheck < interval) return;
    const ids = channels.filter(channel => channel.id).map(channel => channel.id);
    if (!ids.length) return;
    uploadCheckRunning = true;
    try {
      const response = await fetch('/api/uploads/latest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds: ids }) });
      if (!response.ok) { $('#notificationStatus').textContent = 'تعذّر فحص الرفعات الجديدة. سيحاول Ttube لاحقًا.'; return; }
      processUploadBatch(await response.json(), ids, suppressNew);
    } catch {
      $('#notificationStatus').textContent = 'تعذّر الاتصال لفحص الرفعات الجديدة.';
    } finally { uploadCheckRunning = false; }
  }
  function renderVideos() {
    const grid = $('#videoGrid'); const result = getVisibleVideos();
    renderHomeHighlights();
    $('#feedEmpty').classList.remove('is-loading');
    $('#shortCount').textContent = videos.filter(v => Number(v.durationSeconds) > 0 && Number(v.durationSeconds) <= 180).length.toLocaleString('ar-EG');
    $('#feedEmpty').hidden = result.length !== 0;
    if (!result.length) {
      const query = $('#searchMode').value === 'local' ? $('#searchInput').value.trim() : '';
      $('#feedEmpty').innerHTML = view === 'history' && !query
        ? '<span>◷</span><b>سجل المشاهدة فارغ</b><p>الفيديوهات التي تفتحها ستظهر هنا، ويبقى السجل محفوظًا في هذا المتصفح.</p>'
        : view === 'watchlater' && !query
        ? '<span>＋</span><b>قائمة المشاهدة لاحقًا فارغة</b><p>اضغط زر ＋ على أي فيديو لحفظه هنا.</p>'
        : query
        ? `<span>⌕</span><b>ما لقينا نتائج لـ «${escapeHtml(query)}»</b><p>جرّب كلمات أقل أو اكتبها بالعربية أو الإنجليزية؛ البحث يرتّب أقرب النتائج من قنواتك.</p>`
        : '<span>⌕</span><b>لا توجد فيديوهات مطابقة</b><p>جرّب تغيير البحث أو أضف قنوات أخرى.</p>';
    }
    grid.innerHTML = result.slice(0, videoLimit).map(videoCardMarkup).join('');
    installAvatarFallbacks(grid);
    renderSmartRecommendations();
    const more = $('#loadMoreVideos');
    const remaining = Math.max(0, result.length - videoLimit);
    const hasMorePages = view !== 'history' && view !== 'watchlater' && Object.keys(nextPageTokens).length > 0;
    more.hidden = remaining === 0 && !hasMorePages;
    more.textContent = remaining ? `عرض المزيد (${remaining.toLocaleString('ar-EG')})` : 'تحميل المزيد من قنواتك';
    grid.querySelectorAll('.video-card').forEach(card => {
      card.querySelector('[data-watch-later]')?.addEventListener('click', event => { event.stopPropagation(); const source = view === 'history' ? settings.watchHistory : view === 'watchlater' ? settings.watchLater : videos; const video = source.find(item => item.id === card.dataset.video); if (video) toggleWatchLater(video); });
      const open = () => { const source = view === 'history' ? settings.watchHistory : view === 'watchlater' ? settings.watchLater : videos; const video = source.find(item => item.id === card.dataset.video); if (video) openPlayer(video); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  }
  const stopWords = new Set(['the','and','for','from','with','this','that','you','your','are','was','have','has','how','what','when','where','who','why','عن','من','في','على','الى','إلى','هذا','هذه','ذلك','التي','الذي','مع','كيف','ما','هو','هي','كان','كانت','كل','او','أو','ثم','بعد','قبل','بين','هذا']);
  function contentTerms(value) {
    return new Set(String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(word => word.length > 2 && !stopWords.has(word)));
  }
  function suggestionsFor(video) {
    const terms = contentTerms(`${video.title} ${(video.description || '').slice(0, 500)}`);
    const allowed = new Set(channels.filter(channel => channel.id).map(channel => channel.id));
    return videos.filter(candidate => candidate.id !== video.id && allowed.has(candidate.channelId)).map(candidate => {
      const candidateTerms = contentTerms(`${candidate.title} ${(candidate.description || '').slice(0, 500)}`);
      let overlap = 0; for (const term of terms) if (candidateTerms.has(term)) overlap++;
      const sameChannel = candidate.channelId === video.channelId;
      const score = overlap * 3 + (sameChannel ? 2 : 0) + Math.log10(Number(candidate.views) + 1) / 10;
      return { video: candidate, score };
    }).sort((a, b) => b.score - a.score).slice(0, 12).map(row => row.video);
  }
  function renderSuggestions(video) {
    $('.watch-suggestions').hidden = !settings.smartSuggestions;
    if (!settings.smartSuggestions) return;
    const suggestions = suggestionsFor(video);
    $('#suggestedList').innerHTML = suggestions.length ? suggestions.map(item => `<button class="suggested-video" data-watch="${escapeHtml(item.id)}"><span class="suggested-thumb"><img loading="lazy" src="${escapeHtml(item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/hqdefault.jpg`)}" alt=""><span class="suggested-duration">${escapeHtml(item.duration || '')}</span></span><span class="suggested-info"><span class="suggested-title">${escapeHtml(item.title)}</span><span class="suggested-meta">${escapeHtml(item.channelTitle)}<br>${formatViews(item.views)}</span></span></button>`).join('') : '<div class="comments-message">أضف المزيد من قنواتك لتظهر لك اقتراحات إضافية.</div>';
  }
  function openPlayer(video) {
    youtubePlayer?.destroy?.(); youtubePlayer = null;
    $('#miniPlayerFrame').replaceChildren(); $('#miniPlayer').hidden = true;
    $('#watchModal').classList.remove('mini-watch');
    $('#minimizeWatch').textContent = '−';
    $('#minimizeWatch').setAttribute('aria-label', 'تصغير الفيديو');
    $('#minimizeWatch').title = 'تصغير';
    currentVideo = video; commentsNextPage = null;
    updateWatchLaterButton(video);
    recordWatchHistory(video);
    $('#watchTitle').textContent = video.title;
    $('#miniWatchTitle').textContent = video.title;
    $('#watchChannel').textContent = video.channelTitle;
    $('#watchStats').textContent = `${formatViews(video.views)} · ${formatDate(video.publishedAt)}`;
    $('#watchStats').title = Number.isFinite(Date.parse(video.publishedAt)) ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(video.publishedAt)) : '';
    const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
    $('#watchOnYouTube').href = youtubeUrl;
    $('#miniWatchOnYouTube').href = youtubeUrl;
    $('#watchDescription').textContent = video.description || 'لا يوجد وصف لهذا الفيديو.';
    const descriptionPanel = $('.watch-description');
    descriptionPanel.classList.remove('expanded');
    $('#toggleDescription').hidden = (video.description || '').length < 320;
    $('#toggleDescription').textContent = 'عرض المزيد';
    if (video.ageRestricted) {
      $('#playerFrame').innerHTML = `<div class="embed-fallback"><span class="restricted-mark">18+</span><b>هذا الفيديو مقيّد بالعمر</b><p>لا تسمح YouTube بتشغيل هذا الفيديو داخل Ttube. افتحه على YouTube للتحقق من العمر أو تسجيل الدخول.</p><a href="${youtubeUrl}" target="_blank" rel="noopener noreferrer">فتح الفيديو على YouTube ↗</a></div>`;
      $('#minimizeWatch').hidden = true;
      $('#fullscreenWatch').hidden = true;
    } else {
      const embedOrigin = window.location.origin;
      const embedQuery = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', controls: '1', fs: '1', origin: embedOrigin, widget_referrer: window.location.href }).toString();
      $('#playerFrame').innerHTML = `<iframe id="youtubePlayerFrame" src="https://www.youtube.com/embed/${encodeURIComponent(video.id)}?${embedQuery}&enablejsapi=1" title="${escapeHtml(video.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe><button class="fullscreen-exit" id="exitFullscreenOverlay" type="button" aria-label="إنهاء ملء الشاشة" title="إنهاء ملء الشاشة">×</button>`;
      $('#minimizeWatch').hidden = false;
      $('#fullscreenWatch').hidden = false;
      observeYouTubePlayer(video);
    }
    $('#playerFrame').querySelector('iframe')?.addEventListener('pointerenter', resetPlayerCursorTimer);
    $('#playerFrame').querySelector('iframe')?.addEventListener('pointerleave', resetPlayerCursorTimer);
    $('#watchModal').hidden = false;
    $('#immersiveControls').hidden = false;
    resetPlayerCursorTimer();
    renderSuggestions(video);
    loadComments(video.id, false);
  }
  function ensureYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
      script.onerror = () => { youtubeApiPromise = null; reject(new Error('YouTube player API unavailable')); };
      document.head.appendChild(script);
    });
    return youtubeApiPromise;
  }
  function showPlayerFallback(video, reason = 'embed') {
    if (currentVideo?.id !== video.id) return;
    youtubePlayer?.destroy?.(); youtubePlayer = null;
    const message = reason === 'restricted'
      ? 'يتطلب هذا الفيديو التحقق من YouTube أو تسجيل الدخول.'
      : 'لا يسمح صاحب الفيديو بتشغيله داخل المواقع الأخرى.';
    const detail = reason === 'restricted'
      ? 'افتحه في YouTube لإكمال التحقق ثم شاهد الفيديو من هناك.'
      : 'يمكنك فتحه مباشرة على YouTube لمشاهدته.';
    const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
    $('#playerFrame').innerHTML = `<div class="embed-fallback"><span class="restricted-mark">YouTube</span><b>${message}</b><p>${detail}</p><a href="${youtubeUrl}" target="_blank" rel="noopener noreferrer">فتح الفيديو على YouTube ↗</a></div>`;
    $('#minimizeWatch').hidden = true; $('#fullscreenWatch').hidden = true;
  }
  function observeYouTubePlayer(video) {
    const iframe = $('#youtubePlayerFrame');
    if (!iframe) return;
    ensureYouTubeApi().then(() => {
      if (currentVideo?.id !== video.id || !document.contains(iframe)) return;
      youtubePlayer = new window.YT.Player(iframe, { events: {
        onError: event => showPlayerFallback(video, [100, 101, 150, 153].includes(Number(event.data)) ? 'embed' : 'restricted')
      }});
    }).catch(() => { /* The iframe remains usable even if the optional API monitor is unavailable. */ });
  }
  function minimizePlayer() {
    const iframe = $('#playerFrame').querySelector('iframe');
    if (!iframe || !currentVideo) return;
    $('#watchModal').classList.add('mini-watch');
    $('#watchModal').setAttribute('aria-modal', 'false');
    $('#minimizeWatch').textContent = '↗';
    $('#minimizeWatch').setAttribute('aria-label', 'تكبير مشغل الفيديو');
    $('#minimizeWatch').title = 'تكبير';
    resetPlayerCursorTimer();
  }
  function restoreMiniPlayer() {
    if (!$('#watchModal').classList.contains('mini-watch')) return;
    $('#watchModal').classList.remove('mini-watch');
    $('#watchModal').setAttribute('aria-modal', 'true');
    $('#minimizeWatch').textContent = '−';
    $('#minimizeWatch').setAttribute('aria-label', 'تصغير الفيديو');
    $('#minimizeWatch').title = 'تصغير';
    resetPlayerCursorTimer();
  }
  function closePlayer() {
    clearTimeout(playerIdleTimer); playerIdleTimer = null;
    $('#watchModal').hidden = true; $('#miniPlayer').hidden = true;
    $('#immersiveControls').hidden = true;
    document.body.classList.remove('cinema-mode');
    $('#cinemaWatch').setAttribute('aria-pressed', 'false');
    document.body.classList.remove('focus-listening');
    $('#cinemaWatch').setAttribute('aria-pressed', 'false'); $('#focusWatch').setAttribute('aria-pressed', 'false');
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
    $('#sleepTimer').value = '0';
    $('#watchModal').setAttribute('aria-modal', 'true');
    $('#watchModal').classList.remove('mini-watch');
    $('#watchModal').classList.remove('cursor-idle');
    youtubePlayer?.destroy?.(); youtubePlayer = null;
    $('#playerFrame').replaceChildren(); $('#miniPlayerFrame').replaceChildren();
    currentVideo = null; commentsNextPage = null;
    if (view === 'history') renderVideos();
  }
  function toggleCinemaMode() {
    const active = document.body.classList.toggle('cinema-mode');
    $('#cinemaWatch').setAttribute('aria-pressed', String(active));
    notify(active ? 'تم تشغيل وضع السينما' : 'تم إيقاف وضع السينما');
  }
  function toggleFocusMode() {
    const active = document.body.classList.toggle('focus-listening');
    $('#focusWatch').setAttribute('aria-pressed', String(active));
    notify(active ? 'وضع الاستماع مفعّل' : 'وضع الاستماع متوقف');
  }
  function setSleepTimer(minutes) {
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
    const value = Number(minutes);
    if (!value) return;
    sleepTimer = setTimeout(() => { sleepTimer = null; notify('انتهى مؤقت النوم'); closePlayer(); }, value * 60 * 1000);
    notify(`سيُغلق المشغل بعد ${value} دقيقة`);
  }
  function resetPlayerCursorTimer() {
    clearTimeout(playerIdleTimer);
    const modal = $('#watchModal');
    const iframe = $('#playerFrame').querySelector('iframe');
    modal.classList.remove('cursor-idle');
    if (modal.hidden || !currentVideo || !iframe) return;
    playerIdleTimer = setTimeout(() => {
      if (!modal.hidden && currentVideo) {
        modal.classList.add('cursor-idle');
      }
    }, 3000);
  }
  async function toggleVideoFullscreen() {
    const iframe = $('#playerFrame').querySelector('iframe');
    if (!iframe) return;
    const frame = $('#playerFrame');
    try {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (fullscreenElement && (fullscreenElement === frame || fullscreenElement === iframe || frame.contains(fullscreenElement))) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        return;
      }
      if (frame.requestFullscreen) await frame.requestFullscreen();
      else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
      else if (iframe.requestFullscreen) await iframe.requestFullscreen();
      else notify('ملء الشاشة غير مدعوم في هذا المتصفح.');
    } catch { notify('تعذّر تشغيل وضع ملء الشاشة. جرّب زر ملء الشاشة داخل مشغل YouTube.'); }
  }
  function updateFullscreenButton() {
    const iframe = $('#playerFrame').querySelector('iframe');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const frame = $('#playerFrame');
    const active = !!iframe && (fullscreenElement === frame || fullscreenElement === iframe || frame.contains(fullscreenElement));
    const button = $('#fullscreenWatch');
    button.setAttribute('aria-label', active ? 'إنهاء ملء الشاشة' : 'ملء الشاشة');
    button.title = active ? 'إنهاء ملء الشاشة' : 'ملء الشاشة';
    button.setAttribute('aria-pressed', String(active));
  }
  async function loadComments(videoId, append) {
    const list = $('#commentList'); const more = $('#loadMoreComments');
    if (!append) { list.innerHTML = '<div class="comments-message">جارٍ تحميل التعليقات…</div>'; more.hidden = true; $('#commentCount').textContent = ''; }
    else { more.disabled = true; more.textContent = 'جارٍ التحميل…'; }
    try {
      const pageQuery = append && commentsNextPage ? `?pageToken=${encodeURIComponent(commentsNextPage)}` : '';
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/comments${pageQuery}`);
      const payload = await response.json().catch(() => ({}));
      if (currentVideo?.id !== videoId) return;
      if (!response.ok) {
        if (!append) list.innerHTML = `<div class="comments-message">${escapeHtml(payload.detail || 'التعليقات مغلقة أو غير متاحة لهذا الفيديو.')}</div>`;
        commentsNextPage = null; more.hidden = true; return;
      }
      const comments = payload.comments || [];
      const html = comments.map(comment => `<article class="comment-item">${comment.authorThumbnail ? `<img class="comment-avatar remote-avatar" loading="lazy" data-avatar-fallback="${initials(comment.author)}" src="${escapeHtml(proxyImage(comment.authorThumbnail))}" alt="">` : `<span class="comment-avatar comment-avatar-fallback">${initials(comment.author)}</span>`}<div><div class="comment-author">${escapeHtml(comment.author)}<span class="comment-date">${formatDate(comment.publishedAt)}</span></div><div class="comment-text">${escapeHtml(comment.text)}</div>${Number(comment.likes) ? `<div class="comment-likes">♥ ${Number(comment.likes).toLocaleString('ar-EG')}</div>` : ''}</div></article>`).join('');
      if (append) list.insertAdjacentHTML('beforeend', html);
      else list.innerHTML = html || '<div class="comments-message">لا توجد تعليقات متاحة لهذا الفيديو.</div>';
      list.querySelectorAll('img[data-avatar-fallback]').forEach(img => img.addEventListener('error', () => {
        const fallback = document.createElement('span'); fallback.className = 'comment-avatar comment-avatar-fallback';
        fallback.textContent = img.dataset.avatarFallback || 'م'; img.replaceWith(fallback);
      }, { once: true }));
      const total = list.querySelectorAll('.comment-item').length;
      $('#commentCount').textContent = `${total.toLocaleString('ar-EG')} تعليق`;
      commentsNextPage = payload.nextPageToken || null; more.hidden = !commentsNextPage;
    } catch {
      if (currentVideo?.id !== videoId) return;
      if (!append) list.innerHTML = '<div class="comments-message">تعذّر الاتصال لتحميل التعليقات.</div>';
    } finally { more.disabled = false; more.textContent = 'تحميل المزيد من التعليقات'; }
  }
  function setView(next) {
    const reloadAllChannels = next === 'home' && activeChannel !== null;
    if (next === 'home' || next === 'history' || next === 'watchlater') {
      $('#searchInput').value = '';
      $('#searchMode').value = 'local';
      $('#searchInput').placeholder = next === 'history' ? 'ابحث في سجل المشاهدة…' : next === 'watchlater' ? 'ابحث في المشاهدة لاحقًا…' : 'ابحث في قنواتك…';
      $('#searchSubmit').hidden = true; $('#externalSearchResults').hidden = true; externalChannels = [];
    }
    if (next === 'home') activeChannel = null;
    view = next;
    videoLimit = 24;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === next));
    activeFilter = next === 'shorts' ? 'shorts' : next === 'courses' ? 'dotnet' : 'all';
    document.querySelectorAll('.filter-chip').forEach(item => item.classList.toggle('selected', item.dataset.filter === activeFilter));
    $('#feedHeading').textContent = next === 'history' ? 'سجل المشاهدة' : next === 'watchlater' ? 'المشاهدة لاحقًا' : activeChannel ? channels.find(channel => channel.id === activeChannel)?.title || 'من قنواتك' : 'من قنواتك';
    $('#pageSubtitle').textContent = next === 'history' ? 'الفيديوهات التي شاهدتها، محفوظة في هذا المتصفح فقط.' : next === 'watchlater' ? 'فيديوهات حفظتها لتعود إليها لاحقًا.' : next === 'courses' ? 'دورات ومسارات من القنوات التي أضفتها.' : next === 'shorts' ? 'مقاطع قصيرة من قنواتك فقط.' : next === 'latest' ? 'أحدث الفيديوهات من قنواتك.' : channels.length ? 'فيديوهات من القنوات التي اخترتها.' : 'محتوى تحبه، من مصادر اخترتها بنفسك.';
    $('#feedKicker').textContent = next === 'history' ? 'ما شاهدته مؤخرًا' : next === 'watchlater' ? 'قائمتك المحفوظة' : next === 'courses' ? 'مسارات من اختيارك' : next === 'shorts' ? 'لقطات قصيرة من قنواتك' : next === 'latest' ? 'أحدث الرفعات من قنواتك' : 'اختيرت لك';
    renderChannels(); renderVideos(); closeSidebar();
    if (reloadAllChannels) loadFeed();
  }
  function scheduleFeedRetry() {
    clearTimeout(feedRetryTimer);
    const delay = Math.min(300000, Math.round(8000 * Math.pow(1.6, feedRetryAttempt++)));
    feedRetryTimer = setTimeout(() => {
      if (!document.hidden && navigator.onLine !== false && channels.some(channel => channel.id)) loadFeed({ background: true });
    }, delay);
  }
  async function loadFeed({ background = false } = {}) {
    const requestId = ++feedRequestId;
    const notifyChannelId = channelNotificationsPending ? activeChannel : null;
    channelNotificationsPending = false;
    nextPageTokens = {};
    feedPageSize = 20;
    if (!channels.length) { videos = []; renderChannels(); renderVideos(); return; }
    const ids = channels.filter(c => c.id && (!activeChannel || c.id === activeChannel)).map(c => c.id);
    renderChannels();
    if (!ids.length) {
      videos = []; $('#feedHeading').textContent = 'القنوات محفوظة — يلزم إعداد مفتاح API';
      showFeedMessage('قناتك محفوظة في متصفحك', 'أضف YouTube Data API key إلى إعدادات الخادم. ستُحمّل الفيديوهات تلقائيًا عند تحديث الصفحة.');
      renderVideos(); return;
    }
    const requestKey = `${activeChannel || 'all'}:${ids.join(',')}`;
    if (feedInFlightKey === requestKey && feedAbortController) return;
    feedAbortController?.abort();
    const abortController = new AbortController();
    feedAbortController = abortController;
    feedInFlightKey = requestKey;
    $('#feedHeading').textContent = background && videos.length ? 'نحدّث فيديوهات قنواتك…' : 'جارٍ تحميل فيديوهات قنواتك…';
    if (!videos.length) { $('#videoGrid').innerHTML = ''; $('#loadMoreVideos').hidden = true; showFeedMessage('جارٍ تحميل الفيديوهات…', 'قد يحتاج الخادم لحظات ليستيقظ، وسنحاول تلقائيًا.', true); }
    try {
      const timeout = setTimeout(() => abortController.abort(), 25000);
      let response;
      try {
        response = await fetch('/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds: ids }), signal: abortController.signal });
      } finally { clearTimeout(timeout); }
      if (requestId !== feedRequestId) return;
      if (!response.ok) {
        let detail = ''; try { detail = (await response.json()).detail || ''; } catch {}
        if (requestId !== feedRequestId) return;
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        const missingKey = response.status === 503 && /api key|مفتاح/i.test(detail);
        if (retryable && !missingKey) {
          if (videos.length) { $('#feedHeading').textContent = 'نحاول إعادة الاتصال بالخادم…'; }
          else showFeedMessage('الخادم يستيقظ الآن…', 'سنحاول تلقائيًا مرة أخرى خلال لحظات.', true);
          scheduleFeedRetry();
          return;
        }
        if (response.status === 503) $('#feedHeading').textContent = 'أضف مفتاح YouTube API لعرض الفيديوهات';
        else if (response.status === 413) $('#feedHeading').textContent = 'قلّل عدد القنوات المحمّلة في وقت واحد';
        else $('#feedHeading').textContent = 'تعذّر تحميل الفيديوهات';
        showFeedMessage(response.status === 413 ? 'عدد القنوات يتجاوز حدّ الطلب' : 'الاتصال بـ YouTube تعذّر', detail || 'تحقق من مفتاح API والاتصال، ثم حدّث الفيديوهات.');
        return;
      }
      const feedPage = await response.json();
      if (requestId !== feedRequestId) return;
      const loadedVideos = Array.isArray(feedPage) ? feedPage : (feedPage.videos || []);
      nextPageTokens = feedPage.nextPageTokens || {};
      feedPageSize = feedPage.pageSize || 20;
      videos = loadedVideos;
      feedRetryAttempt = 0; feedLastSuccess = Date.now(); clearTimeout(feedRetryTimer); feedRetryTimer = null;
      // A manual feed/channel load should update the in-app baseline without firing a burst of desktop alerts.
      processUploadBatch(loadedVideos, channels.filter(channel => channel.id).map(channel => channel.id), true);
      if (notifyChannelId && notifyChannelId === activeChannel) showLatestChannelNotifications(notifyChannelId, loadedVideos);
      $('#feedHeading').textContent = activeChannel ? channels.find(c => c.id === activeChannel)?.title || 'من قنواتك' : 'من قنواتك';
      $('#feedEmpty').innerHTML = '<span>⌕</span><b>لا توجد فيديوهات مطابقة</b><p>جرّب تغيير البحث أو أضف قنوات أخرى.</p>';
      renderVideos();
    } catch (error) {
      if (requestId !== feedRequestId) return;
      if (error?.name === 'AbortError' && abortController.signal.aborted && feedAbortController !== abortController) return;
      if (videos.length) $('#feedHeading').textContent = 'نحاول إعادة الاتصال بالخادم…';
      else showFeedMessage('الخادم يستيقظ الآن…', 'سنحاول تلقائيًا مرة أخرى خلال لحظات.', true);
      scheduleFeedRetry();
    } finally {
      if (feedAbortController === abortController) { feedAbortController = null; feedInFlightKey = ''; }
    }
  }
  async function loadNextFeedPage() {
    const pageTokens = nextPageTokens;
    const channelIds = Object.keys(pageTokens);
    if (!channelIds.length) return;
    const button = $('#loadMoreVideos'); const requestId = feedRequestId;
    button.disabled = true; button.textContent = 'جارٍ تحميل فيديوهات أقدم…';
    try {
      const response = await fetch('/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelIds, pageTokens, pageSize: feedPageSize }) });
      if (!response.ok) throw new Error('تعذّر تحميل المزيد من فيديوهات قنواتك. حاول مرة أخرى.');
      const page = await response.json();
      if (requestId !== feedRequestId) return;
      const seen = new Set(videos.map(video => video.id));
      videos = [...videos, ...(page.videos || []).filter(video => !seen.has(video.id))];
      nextPageTokens = page.nextPageTokens || {};
      renderVideos();
    } catch (error) {
      if (requestId === feedRequestId) notify(error.message || 'تعذّر تحميل المزيد من الفيديوهات.');
    } finally {
      if (requestId === feedRequestId) button.disabled = false;
    }
  }
  async function resolvePending() {
    let changed = false;
    for (const channel of channels.filter(c => !c.id && c.url)) {
      try {
        const response = await fetch('/api/channels/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: channel.url }) });
        if (!response.ok) continue;
        Object.assign(channel, await response.json()); changed = true;
      } catch { break; }
    }
    if (changed) { persist(); renderChannels(); loadFeed(); }
  }
  function openModal() { $('#channelModal').hidden = false; $('#channelUrl').focus(); $('#formError').textContent = ''; }
  function closeModal() { $('#channelModal').hidden = true; $('#channelForm').reset(); $('#formError').textContent = ''; }
  function openImportModal() { $('#importModal').hidden = false; $('#importError').textContent = ''; }
  function closeImportModal() { $('#importModal').hidden = true; }
  async function beginSubscriptionImport() {
    const button = $('#startImport'); const error = $('#importError');
    button.disabled = true; button.querySelector('span').textContent = 'جارٍ تجهيز الاتصال…'; error.textContent = '';
    try {
      const response = await fetch('/api/auth/google/start');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { error.textContent = payload.detail || 'أكمل إعداد بيانات OAuth في إعدادات Ttube أولًا.'; return; }
      window.location.assign(payload.authorizationUrl);
    } catch { error.textContent = 'تعذّر الاتصال بالخادم. حاول مرة أخرى.'; }
    finally { button.disabled = false; button.querySelector('span').textContent = 'المتابعة إلى Google'; }
  }
  async function handleSubscriptionImportReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('subscriptionImport');
    if (!result) return;
    window.history.replaceState({}, '', window.location.pathname);
    const errors = {
      cancelled: 'ألغيت استيراد الاشتراكات.',
      expired: 'انتهت صلاحية رابط الاستيراد. ابدأ العملية مرة أخرى.',
      token_exchange_failed: 'تعذّر إكمال تسجيل Google. تأكد من إعداد OAuth ورابط الرجوع، ثم حاول مرة أخرى.',
      subscription_read_failed: 'تعذّرت قراءة اشتراكات YouTube. تأكد من تفعيل YouTube Data API v3 والموافقة على إذن القراءة.'
    };
    if (errors[result]) { notify(errors[result]); return; }
    try {
      const response = await fetch(`/api/channels/import/${encodeURIComponent(result)}`);
      if (!response.ok) { notify('انتهت صلاحية نتيجة الاستيراد. ابدأ العملية مرة أخرى.'); return; }
      const imported = await response.json();
      const known = new Set(channels.filter(channel => channel.id).map(channel => channel.id));
      const fresh = imported.filter(channel => !known.has(channel.id));
      channels = [...fresh, ...channels]; persist(); renderChannels(); await loadFeed();
      notify(fresh.length ? `تم استيراد ${fresh.length.toLocaleString('ar-EG')} قناة إلى هذا المتصفح` : 'قنوات اشتراكاتك موجودة بالفعل في قائمتك');
    } catch { notify('تعذّر استيراد القنوات. حاول مرة أخرى.'); }
  }
  document.querySelectorAll('#openAdd,#sideAdd,#sideAddLink,#heroAdd,#entryAdd').forEach(button => button.addEventListener('click', openModal));
  document.querySelectorAll('#importSubscriptions,#importSubscriptionsEmpty').forEach(button => button.addEventListener('click', openImportModal));
  $('#discoverRelatedChannels').addEventListener('click', openExploreModal);
  $('#closeExploreModal').addEventListener('click', closeExploreModal);
  $('#exploreModal').addEventListener('click', event => { if (event.target === $('#exploreModal')) closeExploreModal(); });
  $('#exploreForm').addEventListener('submit', event => {
    event.preventDefault();
    searchExternalChannels({
      query: $('#exploreQuery').value,
      language: $('#exploreLanguage').value,
      safeSearch: $('#exploreSafeSearch').checked
    });
  });
  document.querySelectorAll('[data-explore-query]').forEach(button => button.addEventListener('click', () => {
    $('#exploreQuery').value = button.dataset.exploreQuery;
    document.querySelectorAll('[data-explore-query]').forEach(topic => topic.setAttribute('aria-pressed', String(topic === button)));
    $('#exploreQuery').focus();
  }));
  $('#exploreQuery').addEventListener('input', () => document.querySelectorAll('[data-explore-query]').forEach(topic => topic.setAttribute('aria-pressed', 'false')));
  $('#exploreRelatedFromChannels').addEventListener('click', () => { closeExploreModal(); discoverRelatedChannels(); });
  $('#closeImportModal').addEventListener('click', closeImportModal);
  $('#importModal').addEventListener('click', event => { if (event.target === $('#importModal')) closeImportModal(); });
  $('#startImport').addEventListener('click', beginSubscriptionImport);
  $('#exampleChannel').addEventListener('click', () => { openModal(); $('#channelUrl').value = 'https://www.youtube.com/@Dr.Haitham_Talaat'; });
  $('#closeModal').addEventListener('click', closeModal);
  $('#channelModal').addEventListener('click', event => { if (event.target === $('#channelModal')) closeModal(); });
  $('#closeWatch').addEventListener('click', closePlayer);
  $('#cinemaWatch').addEventListener('click', toggleCinemaMode);
  $('#focusWatch').addEventListener('click', toggleFocusMode);
  $('#sleepTimer').addEventListener('change', event => setSleepTimer(event.target.value));
  if (!$('#watchLaterButton')) {
    const button = document.createElement('button');
    button.id = 'watchLaterButton'; button.className = 'watch-later-player'; button.type = 'button';
    button.addEventListener('click', () => { if (currentVideo) toggleWatchLater(currentVideo); });
    $('#fullscreenWatch').before(button);
  }
  $('#fullscreenWatch').addEventListener('click', toggleVideoFullscreen);
  $('#playerFrame').addEventListener('click', event => {
    if (event.target.id === 'exitFullscreenOverlay') toggleVideoFullscreen();
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
  $('#minimizeWatch').addEventListener('click', () => $('#watchModal').classList.contains('mini-watch') ? restoreMiniPlayer() : minimizePlayer());
  $('#restoreMiniPlayer').addEventListener('click', restoreMiniPlayer);
  $('#closeMiniPlayer').addEventListener('click', closePlayer);
  $('#watchModal').addEventListener('click', event => { if (event.target === $('#watchModal')) minimizePlayer(); });
  $('#watchModal').addEventListener('pointermove', resetPlayerCursorTimer);
  $('#watchModal').addEventListener('pointerdown', resetPlayerCursorTimer);
  $('#watchModal').addEventListener('keydown', resetPlayerCursorTimer);
  $('#playerFrame').addEventListener('dblclick', event => {
    toggleVideoFullscreen();
  });
  $('.watch-brand').addEventListener('click', event => { event.preventDefault(); closePlayer(); });
  $('#toggleDescription').addEventListener('click', () => {
    const panel = $('.watch-description'); const expanded = panel.classList.toggle('expanded');
    $('#toggleDescription').textContent = expanded ? 'عرض أقل' : 'عرض المزيد';
  });
  $('#loadMoreComments').addEventListener('click', () => { if (currentVideo) loadComments(currentVideo.id, true); });
  $('#suggestedList').addEventListener('click', event => {
    const button = event.target.closest('[data-watch]'); if (!button) return;
    const video = videos.find(item => item.id === button.dataset.watch); if (video) openPlayer(video);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeModal(); closeImportModal(); closeExploreModal(); closePlayer(); closeSidebar(); $('#notificationsPanel').hidden = true; $('#notificationsButton').setAttribute('aria-expanded', 'false'); $('#externalSearchResults').hidden = true; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (window.matchMedia('(max-width: 760px)').matches) $('#searchWrap').classList.add('expanded');
      $('#searchInput').focus();
    }
  });
  $('#channelForm').addEventListener('submit', async event => {
    event.preventDefault(); const input = $('#channelUrl'); const url = input.value.trim(); const error = $('#formError');
    error.textContent = '';
    try {
      const parsed = new URL(url);
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase())) throw new Error('أدخل رابطًا من YouTube.');
    } catch (e) { error.textContent = e.message === 'Invalid URL' ? 'تحقق من الرابط ثم حاول مرة أخرى.' : e.message; return; }
    const submit = $('#channelForm button[type="submit"]'); submit.disabled = true; submit.querySelector('span').textContent = 'جارٍ إضافة القناة…';
    try {
      const response = await fetch('/api/channels/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      if (response.ok) {
        const channel = await response.json();
        if (channels.some(c => c.id === channel.id)) { error.textContent = 'هذه القناة موجودة بالفعل في قائمتك.'; return; }
        channels.unshift({ ...channel, url }); persist(); activeChannel = null; closeModal(); renderChannels(); await loadFeed(); notify(`أُضيفت قناة ${channel.title}`);
      } else {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 503) {
          const path = new URL(url).pathname.split('/').filter(Boolean); const handle = path.find(x => x.startsWith('@'));
          const knownName = handle ? decodeURIComponent(handle.slice(1)).replace(/[._-]/g, ' ') : 'قناة YouTube جديدة';
          channels.unshift({ id: null, title: knownName, url }); persist(); closeModal(); renderChannels();
          $('#feedHeading').textContent = 'القنوات محفوظة — يلزم إعداد مفتاح API';
          $('#feedEmpty').hidden = false; $('#feedEmpty').innerHTML = '<span>◈</span><b>قناتك محفوظة في متصفحك</b><p>أضف مفتاح YouTube Data API إلى إعدادات الخادم لتحميل الفيديوهات. ستكتمل إضافة القناة تلقائيًا بعد الإعداد.</p>';
          notify('حُفظ الرابط في متصفحك. أكمل إعداد YouTube API لعرض الفيديوهات.');
        } else error.textContent = payload.detail || payload.error || 'تعذّرت إضافة القناة. تحقق من الرابط.';
      }
    } catch { error.textContent = 'تعذّر الاتصال بالخادم. حاول مرة أخرى.'; }
    finally { submit.disabled = false; submit.querySelector('span').textContent = 'إضافة إلى قنواتي'; }
  });
  document.querySelectorAll('.filter-chip').forEach(button => button.addEventListener('click', () => {
    activeFilter = button.dataset.filter; view = 'home'; videoLimit = 24; document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.toggle('selected', chip === button));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'home')); renderVideos();
  }));
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => setView(button.dataset.viewLink)));
  $('.topbar .brand').addEventListener('click', event => {
    event.preventDefault();
    setView('home');
    history.replaceState(null, '', `${location.pathname}${location.search}#home`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#searchMode').addEventListener('change', () => {
    const external = $('#searchMode').value === 'youtube';
    $('#searchInput').placeholder = external ? 'ابحث عن قناة على YouTube…' : 'ابحث في قنواتك…';
    $('#searchSubmit').hidden = !external;
    $('#externalSearchResults').hidden = true; externalChannels = [];
    if (!external) { videoLimit = 24; renderVideos(); }
  });
  $('#searchInput').addEventListener('input', () => {
    if ($('#searchMode').value === 'local') { videoLimit = 24; renderVideos(); }
    else relatedDiscoveryActive = false;
  });
  $('#channelSearchInput').addEventListener('input', renderChannels);
  $('#searchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && $('#searchMode').value === 'youtube') { event.preventDefault(); searchExternalChannels(); }
  });
  $('#searchSubmit').addEventListener('click', searchExternalChannels);
  document.querySelectorAll('#externalSearchResults,#exploreResults').forEach(panel => panel.addEventListener('click', event => {
    const button = event.target.closest('[data-add-search-channel]');
    if (button) addExternalChannel(button.dataset.addSearchChannel, button);
  }));
  $('.search-wrap').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 760px)').matches && !$('.search-wrap').classList.contains('expanded')) {
      $('.search-wrap').classList.add('expanded'); $('#searchInput').focus();
    }
  });
  document.addEventListener('click', event => {
    if (!$('.search-wrap').contains(event.target)) {
      $('#externalSearchResults').hidden = true;
      if (window.matchMedia('(max-width: 760px)').matches) $('.search-wrap').classList.remove('expanded');
    }
  });
  $('#refreshButton').addEventListener('click', loadFeed);
  $('#loadMoreVideos').addEventListener('click', () => {
    if (getVisibleVideos().length > videoLimit) { videoLimit += 24; renderVideos(); }
    else if (view !== 'history') loadNextFeedPage();
  });
  $('#themeToggle').addEventListener('click', () => {
    const theme = document.body.classList.contains('theme-light') ? 'dark' : 'light';
    localStorage.setItem(THEME_STORE, theme); applyTheme(theme);
  });
  $('#locationButton').addEventListener('click', requestUserLocation);
  $('#notificationsButton').addEventListener('click', () => {
    const panel = $('#notificationsPanel'); const open = panel.hidden;
    if (open) notificationChannelFilter = null;
    panel.hidden = !open; $('#notificationsButton').setAttribute('aria-expanded', String(open));
    if (open) {
      settings.notifications = settings.notifications.map(item => ({ ...item, read: true }));
      persistSettings(); renderNotifications();
    }
  });
  $('#closeNotifications').addEventListener('click', () => { $('#notificationsPanel').hidden = true; $('#notificationsButton').setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', event => {
    if (!$('#notificationsPanel').hidden && !$('#notificationsPanel').contains(event.target) && !$('#notificationsButton').contains(event.target)) {
      $('#notificationsPanel').hidden = true; $('#notificationsButton').setAttribute('aria-expanded', 'false');
    }
  });
  $('#smartSuggestionsToggle').addEventListener('change', event => {
    settings.smartSuggestions = event.target.checked; persistSettings(); renderVideos();
    if (currentVideo) renderSuggestions(currentVideo);
  });
  $('#videoMetaFont').addEventListener('change', event => {
    settings.videoMetaFont = event.target.value; persistSettings(); applyVideoTypography();
  });
  $('#videoMetaFontSize').addEventListener('input', event => {
    settings.videoMetaFontSize = Number(event.target.value); persistSettings(); applyVideoTypography();
  });
  $('#resetVideoTypography').addEventListener('click', () => {
    settings.videoMetaFont = 'default'; settings.videoMetaFontSize = 12;
    persistSettings(); applyVideoTypography();
  });
  $('#uploadNotificationsToggle').addEventListener('change', async event => {
    if (!event.target.checked) {
      settings.uploadNotifications = false; persistSettings(); renderNotifications(); return;
    }
    if (!('Notification' in window)) {
      event.target.checked = false; notify('هذا المتصفح لا يدعم إشعارات النظام.'); return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      event.target.checked = false;
      $('#notificationStatus').textContent = permission === 'denied' ? 'الإذن مرفوض. اسمح بالإشعارات من إعدادات الموقع.' : 'لم يتم تفعيل الإشعارات.';
      return;
    }
    settings.uploadNotifications = true; persistSettings(); renderNotifications();
    await checkForUploads(true, true);
  });
  $('#notificationList').addEventListener('click', event => {
    const item = event.target.closest('[data-notification-video]'); if (!item) return;
    const savedVideo = settings.notifications.find(video => video.id === item.dataset.notificationVideo);
    const video = videos.find(candidate => candidate.id === item.dataset.notificationVideo) || savedVideo;
    if (video) { $('#notificationsPanel').hidden = true; $('#notificationsButton').setAttribute('aria-expanded', 'false'); openPlayer(video); }
  });
  renderNotifications();
  renderWatchLaterCount();
  setInterval(() => checkForUploads(), 4 * 60 * 60 * 1000);
  setInterval(() => { if (!document.hidden && channels.some(channel => channel.id) && Date.now() - feedLastSuccess > 10 * 60 * 1000) loadFeed({ background: true }); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkForUploads();
    if (channels.some(channel => channel.id) && (!feedLastSuccess || Date.now() - feedLastSuccess > 2 * 60 * 1000)) loadFeed({ background: true });
  });
  window.addEventListener('online', () => {
    if (channels.some(channel => channel.id)) { feedRetryAttempt = 0; loadFeed({ background: true }); }
  });
  $('#menuButton').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 760px)').matches) $('#sidebar').classList.toggle('open');
    else document.body.classList.toggle('sidebar-hidden');
    syncSidebarButton();
  });
  $('.main').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 760px)').matches && $('#sidebar').classList.contains('open')) closeSidebar();
  });
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => { $('#sidebar').classList.remove('open'); syncSidebarButton(); });
  $('#avatarButton').addEventListener('click', () => notify('حسابك غير مطلوب — بياناتك على هذا الجهاز فقط'));

  const installButton = $('#installAppButton');
  let installPrompt = null;
  const appIsInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (appIsInstalled) installButton.hidden = true;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  installButton.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const result = await installPrompt.userChoice;
      installPrompt = null;
      if (result.outcome === 'accepted') installButton.hidden = true;
      else notify('يمكنك تثبيت Ttube لاحقًا من قائمة المتصفح.');
      return;
    }
    const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) && !('MSStream' in window);
    if (isAppleMobile) notify('في Safari اضغط «مشاركة» ثم «إضافة إلى الشاشة الرئيسية».');
    else notify('من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».');
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installButton.hidden = true;
    notify('تم تثبيت Ttube على جهازك.');
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  applyTheme(localStorage.getItem(THEME_STORE) || 'dark');
  applyVideoTypography();
  syncSidebarButton();
  updateClock(); setInterval(updateClock, 1000);
  setInterval(() => {
    document.querySelectorAll('[data-relative-date]').forEach(element => { element.textContent = formatDate(element.dateTime); });
    if (currentVideo) $('#watchStats').textContent = `${formatViews(currentVideo.views)} · ${formatDate(currentVideo.publishedAt)}`;
  }, 60000);
  setInterval(() => { if (savedLocation) loadLocationDashboard(savedLocation, { weather: true, prayer: false }); }, 30 * 60 * 1000);
  setInterval(() => { if (savedLocation) loadLocationDashboard(savedLocation, { weather: false, prayer: true }); }, 6 * 60 * 60 * 1000);
  if (savedLocation) {
    $('#locationLabel').textContent = 'جارٍ تحميل بيانات موقعك…';
    loadLocationDashboard(savedLocation);
  }
  settings.lastVisitAt = sessionStartedAt; persistSettings();
  renderChannels(); renderVideos(); loadFeed(); resolvePending(); handleSubscriptionImportReturn();
})();
