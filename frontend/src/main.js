// src/main.js
// ─────────────────────────────────────────────────────────────────────────────
// PatchTicker — SaaS frontend entry point
//
// VIEWS
//  login, register, forgot-password, reset-password, verify-email,
//  pricing, dashboard (authenticated, role-aware)
//
// CSP COMPLIANCE: no inline styles, no inline handlers, no eval
// ─────────────────────────────────────────────────────────────────────────────

import {
  register as apiRegister, login as apiLogin, logout as apiLogout,
  getMe, verifyEmail as apiVerifyEmail, resendVerification,
  forgotPassword as apiForgotPassword, resetPassword as apiResetPassword,
  createCheckout, openBillingPortal, getBillingStatus,
  fetchUpdates, fetchSummary, submitBugReport,
  fetchUpdateById, fetchRecentPosts, submitPost, createFeedStreamTicket, openFeedStream,
} from './api.js';
import { restoreSession, setUser, signOut, getUser, isLoggedIn, hasRole, onAuthChange } from './auth.js';
import { route, fallback, navigate, start, queryParams } from './router.js';
import {
  applyAnalyticsPrivacyMasks, captureAnalytics, initializeAnalyticsConsent,
  openAnalyticsPreferences, syncAnalyticsIdentity,
} from './analytics.js';
import { STEAM_GAME_CANDIDATES, STEAM_GAME_CANDIDATE_META } from './steamGameCandidates.js';

// ── Ad system ─────────────────────────────────────────────────────────────────
//
// CONDITIONAL LOADING GUARANTEE
// ───────────────────────────────
// The AdSense script is never present in index.html. It is only injected into
// the DOM after session restore confirms the user is free tier. Premium users
// (pro, admin) never trigger a request to googlesyndication.com — the script
// tag is never created for them, not just hidden.
//
// FLOW
//   1. App boots → restoreSession() resolves with user object
//   2. shouldShowAds() checks user.role === 'free'
//   3. If true  → loadAdScript() injects <script> tag once, sets _adScriptLoaded
//   4. If false → nothing. No network request. No DOM node. No cookies from Google.
//
// Role hierarchy:  free < pro < admin
// Any role above 'free' gets no ads and no ad script.

const HCAPTCHA_SITE_KEY = typeof __HCAPTCHA_SITE_KEY__ !== 'undefined' ? __HCAPTCHA_SITE_KEY__ : '';
const STRIPE_PRICE_MONTHLY = typeof __STRIPE_PRICE_MONTHLY__ !== 'undefined' ? __STRIPE_PRICE_MONTHLY__ : '';
const STRIPE_PRICE_ANNUAL = typeof __STRIPE_PRICE_ANNUAL__ !== 'undefined' ? __STRIPE_PRICE_ANNUAL__ : '';
const ADSENSE_PUBLISHER_ID = 'ca-pub-5058946458366067';
let _adScriptLoaded = false;  // guard: only inject the script tag once per session

/**
 * Returns true only for authenticated free-tier users.
 * Logged-out visitors and any paid role return false.
 */
function shouldShowAds() {
  const user = getUser();
  if (!user) return false;
  return user.role === 'free';
}

/**
 * Dynamically load the AdSense script — called once when a free-tier user
 * is confirmed. Safe to call multiple times; subsequent calls are no-ops.
 *
 * The script is injected with async so it never blocks rendering.
 * Returns a Promise that resolves when the script loads (or rejects on error).
 *
 * @returns {Promise<void>}
 */
function loadAdScript() {
  return new Promise((resolve, reject) => {
    // Already loaded this session — no-op
    if (_adScriptLoaded || document.getElementById('adsense-script')) {
      _adScriptLoaded = true;
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.id          = 'adsense-script';
    script.async       = true;
    script.crossOrigin = 'anonymous';
    script.src         = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}`;

    script.onload = () => {
      _adScriptLoaded = true;
      resolve();
    };
    script.onerror = () => {
      // Ad blocker or network failure — fail silently, never break the app
      console.warn('[ads] AdSense script failed to load (ad blocker?)');
      resolve(); // resolve, not reject — ad failure is non-fatal
    };

    document.head.appendChild(script);
  });
}

/**
 * Inject an AdSense ad unit into a container element.
 *
 * Loads the AdSense script on first call (for free users only), then renders
 * the <ins> unit. Safe to call on every render — skips if already injected,
 * user is not free tier, or AdSense failed to load.
 *
 * @param {string} containerId  — id of the host <div>
 * @param {string} adSlot       — AdSense ad unit slot ID, or 'auto' for Auto ads
 */
async function injectAd(containerId, adSlot = 'auto') {
  // Hard gate — premium users never reach loadAdScript()
  if (!shouldShowAds()) return;

  // Load the script on first call; subsequent calls skip the network request
  await loadAdScript();

  const container = document.getElementById(containerId);
  if (!container || container.dataset.adInjected) return;

  // Mark immediately to prevent double-injection on rapid re-renders
  container.dataset.adInjected = 'true';

  const ins = document.createElement('ins');
  ins.className                  = 'adsbygoogle';
  ins.style.display              = 'block';
  ins.dataset.adClient           = ADSENSE_PUBLISHER_ID;
  ins.dataset.adSlot             = adSlot;
  ins.dataset.adFormat           = 'auto';
  ins.dataset.fullWidthResponsive = 'true';
  container.appendChild(ins);

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    console.warn('[ads] adsbygoogle.push failed:', e.message);
  }
}

/**
 * Remove all injected ad units and unload the AdSense script.
 * Called when a free user upgrades to Pro within the same session —
 * immediately removes ads without requiring a page reload.
 */
function unloadAds() {
  // Remove all <ins> ad units from the DOM
  document.querySelectorAll('ins.adsbygoogle').forEach(el => el.remove());

  // Remove the script tag so it won't reload on next navigation
  const script = document.getElementById('adsense-script');
  if (script) script.remove();

  // Clear the adsbygoogle queue so push() calls are no-ops
  window.adsbygoogle = [];
  _adScriptLoaded = false;
}

const app = document.getElementById('app');
const THEME_STORAGE_KEY = 'patchticker.theme';
const MAX_UPDATE_AGE_DAYS = 240;
const UPDATE_DISPLAY_WINDOW_MS = MAX_UPDATE_AGE_DAYS * 24 * 60 * 60 * 1000;
const QUICKBAR_TOP_ZONE_PX = 120;
const QUICKBAR_SCROLL_EPSILON_PX = 3;
const UPDATE_VISIT_STORAGE_KEY = 'patchticker.updates.lastSeenAt';
const _updateVisitBaseline = Date.parse(localStorage.getItem(UPDATE_VISIT_STORAGE_KEY) || '');
let _updateVisitRecorded = false;
let _quickbarScrollController = null;
let _liveFeedCleanup = null;

function isUpdateWithinDisplayWindow(update, now = Date.now()) {
  const releasedAt = Date.parse(update?.releasedAt);
  return Number.isFinite(releasedAt) && releasedAt >= now - UPDATE_DISPLAY_WINDOW_MS;
}

function preferredTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
  return next;
}

applyTheme(preferredTheme());

// ── HTML escape ───────────────────────────────────────────────────────────────
const H = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;' }[c])
);

// ── Render helpers ────────────────────────────────────────────────────────────
function setHTML(html) {
  _quickbarScrollController?.abort();
  _quickbarScrollController = null;
  _liveFeedCleanup?.();
  _liveFeedCleanup = null;
  document.body.classList.remove('dashboard-shell-active');
  app.innerHTML = html;
  applyAnalyticsPrivacyMasks(app);
  document.getElementById('analytics-privacy-choices')?.addEventListener('click', openAnalyticsPreferences);
}

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  setTimeout(() => {
    t.classList.remove('toast--visible');
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

function spinner() {
  return '<div class="spinner"></div>';
}

// ── Nav bar ───────────────────────────────────────────────────────────────────
function renderNav(user) {
  const theme = document.documentElement.dataset.theme || 'dark';
  const roleLabel = user?.role ? `<span class="nav-role nav-role--${user.role}">${user.role.toUpperCase()}</span>` : '';
  const userEmail = user ? `<span class="nav-email">${H(user.email)}</span>` : '';
  const rightLinks = user
    ? `${roleLabel}${userEmail}<a class="nav-btn" href="#/account">Account</a><button class="nav-btn" id="nav-logout">Sign out</button>`
    : `<a class="nav-link" href="#/login">Sign in</a><a class="nav-btn nav-btn--primary" href="#/register">Get started</a>`;

  const adminLink = user?.role === 'admin' ? `<a class="nav-link nav-link--admin" href="#/admin">Admin</a>` : '';

  return `
    <nav class="nav">
      <a class="nav-brand" href="#/">
        <span class="brand-pulse">Patch</span>Ticker
      </a>
      <div class="nav-right">
        ${user ? `<a class="nav-link nav-link--updates" href="#/updates">Updates</a><a class="nav-link nav-link--pricing" href="#/pricing">Pricing</a>${adminLink}` : `<a class="nav-link nav-link--updates" href="#/updates">Updates</a><a class="nav-link nav-link--pricing" href="#/pricing">Pricing</a>`}
        <button class="nav-theme-toggle" id="nav-theme-toggle" type="button" aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme" title="Switch appearance">${theme === 'dark' ? '☀' : '☾'}</button>
        ${rightLinks}
      </div>
    </nav>
  `;
}

function attachNavHandlers(user) {
  const themeBtn = document.getElementById('nav-theme-toggle');
  themeBtn?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'dark';
    const next = applyTheme(current === 'dark' ? 'light' : 'dark');
    themeBtn.textContent = next === 'dark' ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} theme`);
  });

  const logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await apiLogout();
      signOut();
      navigate('/login');
    });
  }
}

function attachTopicScrollNav() {
  const links = [...document.querySelectorAll('.topic-nav-link[data-scroll-target]')];
  const jumpLinks = [...document.querySelectorAll('[data-scroll-target]:not(.topic-nav-link)')];
  const sections = links
    .map(link => document.getElementById(link.dataset.scrollTarget))
    .filter(Boolean);

  if (!links.length || !sections.length) return;

  const setActive = (id) => {
    links.forEach(link => link.classList.toggle('active', link.dataset.scrollTarget === id));
  };

  [...links, ...jumpLinks].forEach(link => {
    link.addEventListener('click', (e) => {
      const target = document.getElementById(link.dataset.scrollTarget);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(target.id);
    });
  });

  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible?.target?.id) setActive(visible.target.id);
  }, { rootMargin: '-34% 0px -52% 0px', threshold: [0.1, 0.25, 0.5] });

  sections.forEach(section => observer.observe(section));
}

function attachQuickbarScrollBehavior() {
  const quickbar = document.querySelector('.dash-quickbar');
  const toggle = document.getElementById('dash-quickbar-toggle');
  const search = document.getElementById('dash-top-search');
  if (!quickbar || !toggle) return;

  const mainScroller = document.querySelector('.dash-main');
  const scrollRoot = window.matchMedia('(max-width: 768px)').matches || !mainScroller ? window : mainScroller;
  const getScrollY = () => scrollRoot === window ? window.scrollY : scrollRoot.scrollTop;

  _quickbarScrollController?.abort();
  _quickbarScrollController = new AbortController();
  const { signal } = _quickbarScrollController;
  let lastY = getScrollY();
  let framePending = false;
  let manualOpenUntil = 0;
  let lastDirection = lastY > QUICKBAR_TOP_ZONE_PX ? 'down' : 'idle';
  let directionLockedUntil = 0;
  let settleTimer = null;
  let touchY = null;

  const lockDirection = (direction, durationMs = 420) => {
    lastDirection = direction;
    directionLockedUntil = Date.now() + durationMs;
  };

  const setCollapsed = (collapsed) => {
    quickbar.classList.toggle('is-collapsed', collapsed);
    quickbar.dataset.collapsed = String(collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Show update filters' : 'Hide update filters');
    toggle.querySelector('span').textContent = collapsed ? 'Show filters' : 'Hide filters';
    toggle.querySelector('b').textContent = collapsed ? '↓' : '↑';
  };

  const setHidden = (hidden) => {
    quickbar.classList.toggle('is-scroll-hidden', hidden);
    quickbar.dataset.scrollState = hidden ? 'hidden' : 'visible';
    quickbar.inert = hidden;
    if (hidden) quickbar.setAttribute('aria-hidden', 'true');
    else quickbar.removeAttribute('aria-hidden');
  };

  const updateForScroll = () => {
    framePending = false;
    const currentY = Math.max(0, getScrollY());
    const delta = currentY - lastY;
    const direction = Date.now() < directionLockedUntil
      ? lastDirection
      : (delta < -QUICKBAR_SCROLL_EPSILON_PX ? 'up' : delta > QUICKBAR_SCROLL_EPSILON_PX ? 'down' : lastDirection);

    if (currentY <= QUICKBAR_TOP_ZONE_PX) {
      lastDirection = 'idle';
      setHidden(false);
      setCollapsed(false);
    } else if (Date.now() < manualOpenUntil) {
      setHidden(false);
    } else if (direction === 'up') {
      lastDirection = 'up';
      setHidden(false);
      setCollapsed(true);
    } else if (direction === 'down') {
      // Collapsing changes layout height and can trigger a small synthetic
      // upward scroll. Hold the real downward intent through that reflow.
      lockDirection('down', 520);
      if (document.activeElement === search) search.blur();
      setCollapsed(true);
      setHidden(true);
    }
    lastY = currentY;
  };

  const settleScrollState = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const currentY = Math.max(0, getScrollY());
      if (currentY <= QUICKBAR_TOP_ZONE_PX) {
        setHidden(false);
        setCollapsed(false);
        return;
      }
      // Trackpads and browser-driven jumps can coalesce several scroll events
      // into one frame. Ensure the final resting state still retreats below the
      // header unless the user was deliberately moving back toward the top.
      if (Date.now() >= manualOpenUntil && lastDirection !== 'up') {
        if (document.activeElement === search) search.blur();
        setCollapsed(true);
        setHidden(true);
      }
    }, 90);
  };

  const onScroll = () => {
    if (!framePending) {
      framePending = true;
      requestAnimationFrame(updateForScroll);
    }
    settleScrollState();
  };

  const onWheel = (event) => {
    if (Math.abs(event.deltaY) > 4) lockDirection(event.deltaY > 0 ? 'down' : 'up');
  };

  const onKeyDown = (event) => {
    // Page navigation scrolls smoothly in some browsers. Hold the intended
    // direction long enough that collapsing the filter details cannot trigger
    // scroll anchoring and falsely read as a reversal.
    if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) lockDirection('down', 1200);
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) lockDirection('up', 1200);
  };

  const onTouchStart = (event) => {
    touchY = event.touches?.[0]?.clientY ?? null;
  };

  const onTouchMove = (event) => {
    const nextY = event.touches?.[0]?.clientY;
    if (!Number.isFinite(nextY) || !Number.isFinite(touchY)) return;
    if (Math.abs(nextY - touchY) > 4) lockDirection(nextY < touchY ? 'down' : 'up');
    touchY = nextY;
  };

  toggle.addEventListener('click', () => {
    const willCollapse = !quickbar.classList.contains('is-collapsed');
    if (!willCollapse) manualOpenUntil = Date.now() + 1200;
    setHidden(false);
    setCollapsed(willCollapse);
  }, { signal });
  search?.addEventListener('focus', () => setHidden(false), { signal });
  scrollRoot.addEventListener('wheel', onWheel, { passive: true, signal });
  window.addEventListener('keydown', onKeyDown, { signal });
  scrollRoot.addEventListener('touchstart', onTouchStart, { passive: true, signal });
  scrollRoot.addEventListener('touchmove', onTouchMove, { passive: true, signal });
  scrollRoot.addEventListener('scroll', onScroll, { passive: true, signal });
  signal.addEventListener('abort', () => clearTimeout(settleTimer), { once: true });

  setCollapsed(lastY > QUICKBAR_TOP_ZONE_PX);
  setHidden(lastY > QUICKBAR_TOP_ZONE_PX);
}


function attachMotionEffects(root = document) {
  // Scroll-reveal was removed by request. Keep this hook lightweight so
  // dynamic cards still receive any non-reveal motion classes safely.
  const targets = [
    ...root.querySelectorAll('.topic-section, .dash-section-header, .hero-live-console, .update-tape-panel, .platform-pill, .decision-flow-grid article, .mini-update-card, .decision-card, .follow-game-chip, .followed-game-card, .hero-console-queue div'),
  ].filter(el => !el.dataset.motionBound);

  targets.forEach((el) => {
    el.dataset.motionBound = 'true';
    el.classList.add('motion-ready');
  });
}

function refreshMotionEffects(root = document) {
  requestAnimationFrame(() => attachMotionEffects(root));
}

// ── Loading screen ────────────────────────────────────────────────────────────
function renderLoading() {
  setHTML(`
    <div class="loading-screen">
      <div class="loading-logo"><span class="brand-pulse">Patch</span>Ticker</div>
      <div class="loading-text">Initialising session...</div>
    </div>
  `);
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
function renderLogin() {
  const user = getUser();
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Sign in to PatchTicker</h1>
          <p class="auth-subtitle">Track software updates. Catch regressions early.</p>
        </div>
        <form class="auth-form" id="login-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="login-email">Email address</label>
            <input class="field-input" id="login-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="login-password">
              Password
              <a class="field-link" href="#/forgot-password">Forgot password?</a>
            </label>
            <input class="field-input" id="login-password" type="password" autocomplete="current-password" placeholder="••••••••" required />
          </div>
          <div class="auth-error hidden" id="login-error"></div>
          <button class="btn btn--primary btn--full" type="submit" id="login-submit">Sign in</button>
        </form>
        <p class="auth-footer">
          No account? <a class="auth-link" href="#/register">Create one free</a>
        </p>
      </div>
    </div>
  `);
  attachNavHandlers(null);

  const form     = document.getElementById('login-form');
  const errorEl  = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const email    = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const data     = await apiLogin({ email, password });
      setUser(data.user);
      captureAnalytics('login_completed', { plan: data.user?.role || 'free' });
      showToast('Welcome back!', 'success');
      navigate('/updates');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
function renderRegister() {
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Create your account</h1>
          <p class="auth-subtitle">Start free. Upgrade when you want real-time alerts and API access.</p>
        </div>
        <form class="auth-form" id="register-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="reg-email">Email address</label>
            <input class="field-input" id="reg-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="reg-password">Password</label>
            <input class="field-input" id="reg-password" type="password" autocomplete="new-password" placeholder="12+ characters" aria-describedby="reg-password-hint" required />
            <p class="field-hint" id="reg-password-hint">Use uppercase, lowercase, a number, and a symbol.</p>
            <div class="password-strength" id="pwd-strength"></div>
          </div>
          <!-- hCaptcha widget — rendered here, token collected on submit -->
          <div class="field-group">
            <div class="h-captcha"
                 id="hcaptcha-widget"
                 data-sitekey="${H(HCAPTCHA_SITE_KEY)}"
                 data-theme="${H(document.documentElement.dataset.theme || 'dark')}"
                 data-size="normal">
            </div>
          </div>
          <div class="auth-error hidden" id="reg-error"></div>
          <button class="btn btn--primary btn--full" type="submit" id="reg-submit">Create account</button>
        </form>
        <p class="auth-footer">
          Already have an account? <a class="auth-link" href="#/login">Sign in</a>
        </p>
      </div>
    </div>
  `);
  attachNavHandlers(null);

  const form      = document.getElementById('register-form');
  const errorEl   = document.getElementById('reg-error');
  const submitBtn = document.getElementById('reg-submit');
  const pwdInput  = document.getElementById('reg-password');
  const strength  = document.getElementById('pwd-strength');

  // Render hCaptcha widget once the hcaptcha global is available.
  // The async script tag in index.html sets window.hcaptcha when ready.
  let captchaWidgetId = null;
  function mountCaptcha() {
    if (!HCAPTCHA_SITE_KEY) {
      errorEl.textContent = 'CAPTCHA is not configured. Add VITE_HCAPTCHA_SITE_KEY before enabling registration.';
      errorEl.classList.remove('hidden');
      submitBtn.disabled = true;
      return;
    }
    if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId === null) {
      captchaWidgetId = window.hcaptcha.render('hcaptcha-widget', {
        sitekey: HCAPTCHA_SITE_KEY,
        theme:   document.documentElement.dataset.theme || 'dark',
        size:    'normal',
      });
    }
  }
  // Try immediately (script may already be loaded on second visit to page)
  mountCaptcha();
  // hCaptcha loads async; poll briefly so registration works even if this view mounts first.
  const captchaPoll = window.setInterval(() => {
    mountCaptcha();
    if (captchaWidgetId !== null || !HCAPTCHA_SITE_KEY) window.clearInterval(captchaPoll);
  }, 250);
  window.setTimeout(() => window.clearInterval(captchaPoll), 10000);

  pwdInput.addEventListener('input', () => {
    const v = pwdInput.value;
    let score = 0;
    if (v.length >= 12) score++;
    if (v.length >= 16) score++;
    if (/[A-Z]/.test(v)) score++;
    if (/[0-9]/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const labels = ['', 'Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    const classes = ['', 'weak', 'weak', 'fair', 'strong', 'strong'];
    strength.textContent = v ? labels[score] || 'Weak' : '';
    strength.className = `password-strength strength--${classes[score] || 'weak'}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    try {
      const email    = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-password').value;

      // Collect the hCaptcha response token.
      // getResponse() returns '' if the user hasn't completed the challenge.
      let captchaToken = '';
      if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId !== null) {
        captchaToken = window.hcaptcha.getResponse(captchaWidgetId);
      }
      if (!captchaToken) {
        throw new Error('Please complete the CAPTCHA challenge before continuing.');
      }

      const data = await apiRegister({ email, password, 'h-captcha-response': captchaToken });
      setUser(data.user);
      captureAnalytics('signup_completed', { plan: data.user?.role || 'free' });
      if (data.verificationEmailSent === false) {
        showToast('Account created, but the verification email could not be sent. Try Resend now.', 'warning');
        navigate('/verify-email');
      } else {
        showToast('Account created! Check your email to verify.', 'success');
        navigate('/updates');
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
      // Reset captcha so user can attempt again with a fresh token
      if (typeof window.hcaptcha !== 'undefined' && captchaWidgetId !== null) {
        window.hcaptcha.reset(captchaWidgetId);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
}

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
function renderForgotPassword() {
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Forgot your password?</h1>
          <p class="auth-subtitle">We'll send a reset link to your email.</p>
        </div>
        <form class="auth-form" id="forgot-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="forgot-email">Email address</label>
            <input class="field-input" id="forgot-email" type="email" autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="auth-error hidden" id="forgot-error"></div>
          <div class="auth-success hidden" id="forgot-success"></div>
          <button class="btn btn--primary btn--full" type="submit" id="forgot-submit">Send reset link</button>
        </form>
        <p class="auth-footer"><a class="auth-link" href="#/login">← Back to sign in</a></p>
      </div>
    </div>
  `);

  const form      = document.getElementById('forgot-form');
  const errorEl   = document.getElementById('forgot-error');
  const successEl = document.getElementById('forgot-success');
  const submitBtn = document.getElementById('forgot-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      const email = document.getElementById('forgot-email').value.trim();
      const data  = await apiForgotPassword(email);
      successEl.textContent = data.message;
      successEl.classList.remove('hidden');
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send reset link';
    }
  });
}

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
function renderResetPassword(params) {
  const token = params.token || '';
  setHTML(`
    ${renderNav(null)}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Set new password</h1>
          <p class="auth-subtitle">Choose a strong password for your account.</p>
        </div>
        ${!token ? '<p class="auth-error">Invalid reset link. Please request a new one.</p>' : `
        <form class="auth-form" id="reset-form" novalidate>
          <div class="field-group">
            <label class="field-label" for="reset-password">New password</label>
            <input class="field-input" id="reset-password" type="password" autocomplete="new-password" placeholder="12+ characters" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="reset-confirm">Confirm new password</label>
            <input class="field-input" id="reset-confirm" type="password" autocomplete="new-password" placeholder="Repeat password" required />
          </div>
          <div class="auth-error hidden" id="reset-error"></div>
          <div class="auth-success hidden" id="reset-success"></div>
          <button class="btn btn--primary btn--full" type="submit" id="reset-submit">Update password</button>
        </form>`}
        <p class="auth-footer"><a class="auth-link" href="#/login">← Back to sign in</a></p>
      </div>
    </div>
  `);

  if (!token) return;

  const form      = document.getElementById('reset-form');
  const errorEl   = document.getElementById('reset-error');
  const successEl = document.getElementById('reset-success');
  const submitBtn = document.getElementById('reset-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const password        = document.getElementById('reset-password').value;
    const confirmPassword = document.getElementById('reset-confirm').value;

    if (password !== confirmPassword) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';

    try {
      const data = await apiResetPassword({ token, password, confirmPassword });
      successEl.textContent = data.message + ' Redirecting to login…';
      successEl.classList.remove('hidden');
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Update password';
    }
  });
}

// ── VERIFY EMAIL ──────────────────────────────────────────────────────────────
async function renderVerifyEmail(params) {
  const token = params.token || '';

  setHTML(`
    ${renderNav(getUser())}
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo"><span class="brand-pulse">Patch</span>Ticker</div>
          <h1 class="auth-title">Verifying email…</h1>
        </div>
        <div id="verify-status">${spinner()}</div>
        <p class="auth-footer"><a class="auth-link" href="#/updates">Go to dashboard</a></p>
      </div>
    </div>
  `);
  attachNavHandlers(getUser());

  const statusEl = document.getElementById('verify-status');

  if (!token) {
    statusEl.innerHTML = '<p class="auth-error">No verification token found in the link.</p>';
    return;
  }

  try {
    const data = await apiVerifyEmail(token);
    statusEl.innerHTML = `<p class="auth-success-msg">✓ ${H(data.message)}</p>
      <a class="btn btn--primary" href="#/updates">Go to dashboard</a>`;
    showToast('Email verified!', 'success');
  } catch (err) {
    statusEl.innerHTML = `
      <p class="auth-error-msg">✗ ${H(err.message)}</p>
      <p class="auth-footer-note">Need a new link?</p>
      <button class="btn btn--secondary" id="resend-btn">Resend verification email</button>
    `;
    const resendBtn = document.getElementById('resend-btn');
    if (resendBtn) {
      resendBtn.addEventListener('click', async () => {
        resendBtn.disabled = true;
        try {
          await resendVerification();
          showToast('Verification email sent!', 'success');
        } catch (e) {
          showToast(e.message, 'error');
        } finally {
          resendBtn.disabled = false;
        }
      });
    }
  }
}

// ── PRICING ───────────────────────────────────────────────────────────────────
function renderPricing() {
  const user       = getUser();
  const isPro      = user && hasRole('pro');
  const monthlyId  = STRIPE_PRICE_MONTHLY || '';
  const annualId   = STRIPE_PRICE_ANNUAL  || '';

  setHTML(`
    ${renderNav(user)}
    <div class="pricing-page">
      <div class="pricing-header">
        <div class="pricing-eyebrow">For patch-heavy setups</div>
        <h1 class="pricing-headline">Stay on top of games, launchers,<br> drivers, and platform services.</h1>
        <p class="pricing-subhead">Browse recent patches for free, then upgrade when you want alerts, watchlists, and deeper rollout intel.</p>
      </div>

      <div class="pricing-grid">
        <!-- Free tier -->
        <div class="pricing-card">
          <div class="pricing-card-header">
            <div class="pricing-tier">Free</div>
            <div class="pricing-price">$0<span class="pricing-period">/month</span></div>
            <div class="pricing-tagline">A strong daily landing page for staying current.</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Full patch feed across tracked platforms</li>
            <li class="feature-item">✓ Recent service and launcher coverage</li>
            <li class="feature-item">✓ Clear install guidance</li>
            <li class="feature-item">✓ Community bug reports and votes</li>
            <li class="feature-item feature-item--muted">✗ Real-time watchlist alerts</li>
            <li class="feature-item feature-item--muted">✗ API access</li>
            <li class="feature-item feature-item--muted">✗ Priority report queue</li>
            <li class="feature-item feature-item--muted">✗ Advanced monitoring tools</li>
          </ul>
          <div class="pricing-cta">
            ${user
              ? isPro
                ? '<button class="btn btn--outline btn--full" disabled>Your current plan</button>'
                : '<button class="btn btn--outline btn--full" disabled>Current plan</button>'
              : '<a class="btn btn--outline btn--full" href="#/register">Get started free</a>'
            }
          </div>
        </div>

        <!-- Pro tier -->
        <div class="pricing-card pricing-card--featured">
          <div class="pricing-badge">Most popular</div>
          <div class="pricing-card-header">
            <div class="pricing-tier">Pro</div>
            <div class="pricing-price">$12<span class="pricing-period">/month</span></div>
            <div class="pricing-tagline">Or $99/year — save 31%</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Everything in Free</li>
            <li class="feature-item feature-item--pro">✓ Real-time patch alerts (email)</li>
            <li class="feature-item feature-item--pro">✓ REST API access</li>
            <li class="feature-item feature-item--pro">✓ Priority bug report queue</li>
            <li class="feature-item feature-item--pro">✓ Advanced platform and service filtering</li>
            <li class="feature-item feature-item--pro">✓ Update history (12 months)</li>
            <li class="feature-item feature-item--pro">✓ Slack / webhook integrations</li>
            <li class="feature-item feature-item--pro">✓ Priority support</li>
          </ul>
          <div class="pricing-cta">
            ${isPro
              ? '<button class="btn btn--primary btn--full" id="portal-btn">Manage subscription</button>'
              : user
                ? `<button class="btn btn--primary btn--full" id="checkout-monthly" data-price="${H(monthlyId)}">Upgrade to Pro — $12/mo</button>
                   <button class="btn btn--ghost btn--full" id="checkout-annual" data-price="${H(annualId)}">Annual — $99/yr (save 31%)</button>`
                : `<a class="btn btn--primary btn--full" href="#/register">Start free trial</a>
                   <p class="pricing-trial-note">5-day free trial · No credit card required</p>`
            }
          </div>
        </div>

        <!-- Enterprise -->
        <div class="pricing-card">
          <div class="pricing-card-header">
            <div class="pricing-tier">Enterprise</div>
            <div class="pricing-price">Custom</div>
            <div class="pricing-tagline">For large teams and compliance needs.</div>
          </div>
          <ul class="pricing-features">
            <li class="feature-item">✓ Everything in Pro</li>
            <li class="feature-item feature-item--ent">✓ SSO / SAML</li>
            <li class="feature-item feature-item--ent">✓ Dedicated support SLA</li>
            <li class="feature-item feature-item--ent">✓ Custom data retention</li>
            <li class="feature-item feature-item--ent">✓ Audit logs</li>
            <li class="feature-item feature-item--ent">✓ On-prem deployment option</li>
          </ul>
          <div class="pricing-cta">
            <a class="btn btn--outline btn--full" href="mailto:enterprise@patchticker.app">Contact sales</a>
          </div>
        </div>
      </div>

      <div class="pricing-faq">
        <h2 class="faq-title">Common questions</h2>
        <div class="faq-grid">
          <div class="faq-item">
            <div class="faq-q">What happens after the trial?</div>
            <div class="faq-a">Your card is charged only after the 5-day trial ends. Cancel any time before then at no cost.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">Can I cancel at any time?</div>
            <div class="faq-a">Yes. Cancel from your billing portal and you'll keep Pro access until the end of your billing period.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">Is the free plan really free?</div>
            <div class="faq-a">Forever. No credit card required. The free tier is fully functional for individual developers.</div>
          </div>
          <div class="faq-item">
            <div class="faq-q">How does the API work?</div>
            <div class="faq-a">Pro users get a REST API key with up to 1,000 requests/day. Full docs included at launch.</div>
          </div>
        </div>
      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
  const monthlyBtn = document.getElementById('checkout-monthly');
  const annualBtn  = document.getElementById('checkout-annual');
  const portalBtn  = document.getElementById('portal-btn');

  async function handleCheckout(btn, priceId) {
    if (!btn || !priceId) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Redirecting…';
      try {
        const { url } = await createCheckout(priceId);
        captureAnalytics('subscription_checkout_started', {
          plan: 'pro',
          billing_period: btn.id === 'checkout-annual' ? 'annual' : 'monthly',
        });
        window.location.href = url;
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = btn.dataset.label || 'Upgrade';
      }
    });
  }

  if (monthlyBtn) { monthlyBtn.dataset.label = monthlyBtn.textContent; handleCheckout(monthlyBtn, monthlyId); }
  if (annualBtn)  { annualBtn.dataset.label  = annualBtn.textContent;  handleCheckout(annualBtn, annualId); }

  if (portalBtn) {
    portalBtn.addEventListener('click', async () => {
      portalBtn.disabled = true;
      portalBtn.textContent = 'Opening portal…';
      try {
        const { url } = await openBillingPortal();
        window.location.href = url;
      } catch (err) {
        showToast(err.message, 'error');
        portalBtn.disabled = false;
        portalBtn.textContent = 'Manage subscription';
      }
    });
  }
}

// ── LANDING ───────────────────────────────────────────────────────────────────
function renderLanding() {
  const user = getUser();

  setHTML(`
    ${renderNav(user)}
    <main class="landing-page">
      <section class="landing-hero">
        <div class="landing-copy">
          <div class="landing-intro">
            <p class="landing-kicker">Update safety research</p>
            <h1 class="landing-title">Know before you update.</h1>
            <p class="landing-subtitle">PatchTicker helps you decide whether the latest driver, OS patch, firmware release, or launcher update is worth installing today — before your setup becomes the test environment.</p>
            <div class="landing-actions">
              ${user
                ? '<a class="btn btn--primary" href="#/updates">Open update feed</a><a class="btn btn--outline" href="#/account">Manage watchlist</a>'
                : '<a class="btn btn--primary" href="#/register">Create free account</a><a class="btn btn--outline" href="#/updates">Browse live updates</a>'}
            </div>
          </div>
          <div class="landing-proof">
            <span id="landing-live-coverage">Checking live coverage</span>
            <span>Release-note research</span>
            <span>Live community voting</span>
            <span>More platforms coming soon</span>
          </div>
          <div class="landing-scroll-map" aria-label="PatchTicker workflow">
            <span>Watch the tape</span>
            <span>Choose setup</span>
            <span>Compare risk</span>
            <span>Open patch notes</span>
          </div>
        </div>

        <div class="landing-panel">
          <div class="landing-card-head">
            <span>Latest verified patch</span>
            <span class="landing-live" id="landing-live-state">CONNECTING</span>
          </div>
          <div class="landing-score-row">
            <div class="landing-score-value">
              <strong id="landing-live-score">—</strong>
              <small>PatchTicker score /10</small>
            </div>
            <div>
              <span class="status-badge caution" id="landing-live-status">CHECKING</span>
              <p id="landing-live-name">Loading the newest official release…</p>
            </div>
          </div>
          <div class="landing-meter landing-meter--0" id="landing-live-meter"><span></span></div>
          <p class="landing-verdict" id="landing-live-verdict">Connecting to PatchTicker’s verified source desk.</p>
          <div class="landing-votes" id="landing-live-meta">
            <span>Source check pending</span>
          </div>
          <a class="landing-signal-link hidden" id="landing-live-link" href="#/updates">Open patch notes →</a>
        </div>
      </section>

      <section class="landing-grid landing-grid--bento">
        <article class="landing-bento-large">
          <span class="landing-bento-tag">Live desk</span>
          <h2>One screen for updates that usually live across ten tabs.</h2>
          <p>Windows, NVIDIA, AMD, Apple, Switch, consoles, Steam, Discord, GOG, Battle.net, and Intel all land in one decision feed.</p>
        </article>
        <article>
          <span class="landing-bento-tag">Risk view</span>
          <h2>Stable / Caution / Avoid.</h2>
          <p>Visitors get a clear action before reading full notes.</p>
        </article>
        <article>
          <span class="landing-bento-tag">Your setup</span>
          <h2>Filter by what you run.</h2>
          <p>Drivers, launchers, OS releases, handhelds, and games stay separated.</p>
        </article>
      </section>

      <section class="landing-band">
        <div>
          <p class="landing-kicker">Built for everyday install decisions</p>
          <h2>Stable / Caution / Avoid gives you a fast answer when an update is waiting.</h2>
        </div>
        <a class="btn btn--primary" href="#/pricing">See pricing</a>
      </section>
    </main>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
  hydrateLandingSignals();
}

async function hydrateLandingSignals() {
  const coverage = document.getElementById('landing-live-coverage');
  try {
    const [updatesResponse, summaryResponse] = await Promise.all([fetchUpdates({ sort: 'date_desc' }), fetchSummary()]);
    const updates = normaliseUpdatesResponse(updatesResponse)
      .filter(update => isUpdateWithinDisplayWindow(update))
      .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
    const latest = updates[0];
    const summary = summaryResponse?.data || summaryResponse;

    if (coverage && summary) {
      coverage.textContent = `${summary.platformsTracked ?? 0} live source lane${summary.platformsTracked === 1 ? '' : 's'}`;
    }
    if (!latest) throw new Error('No verified updates available');

    const score = validScoreOrNull(latest.score);
    const scoreBucket = score === null ? null : Math.round(score);
    const status = ['stable', 'caution', 'avoid'].includes(latest.status) ? latest.status : 'caution';
    const state = document.getElementById('landing-live-state');
    const scoreEl = document.getElementById('landing-live-score');
    const statusEl = document.getElementById('landing-live-status');
    const name = document.getElementById('landing-live-name');
    const meter = document.getElementById('landing-live-meter');
    const verdict = document.getElementById('landing-live-verdict');
    const meta = document.getElementById('landing-live-meta');
    const link = document.getElementById('landing-live-link');

    if (state) state.textContent = 'LIVE';
    if (scoreEl) {
      scoreEl.textContent = scoreDisplay(score);
      scoreEl.setAttribute('aria-label', score === null ? 'PatchTicker score unavailable' : `${score.toFixed(1)} out of 10 PatchTicker score`);
    }
    if (statusEl) {
      statusEl.className = `status-badge ${status}`;
      statusEl.textContent = status.toUpperCase();
    }
    if (name) {
      const updateName = String(latest.name || platformLabel(latest.platform));
      const version = String(latest.version || '');
      name.textContent = version && !updateName.toLowerCase().includes(version.toLowerCase())
        ? `${updateName} · ${version}`
        : updateName;
    }
    if (meter) meter.className = scoreBucket === null ? 'landing-meter landing-meter--unscored' : `landing-meter landing-meter--${scoreBucket}`;
    if (verdict) verdict.textContent = latest.verdict || latest.reasoning || 'Open the verified release notes for the current install read.';
    if (meta) {
      const liveVotes = Number(latest.userRating?.totalVotes || 0);
      meta.innerHTML = liveVotes > 0
        ? `<span>${H(String(liveVotes))} verified vote${liveVotes === 1 ? '' : 's'}</span><span>Install ${H(String(latest.userRating.breakdown?.install ?? 0))}%</span><span>Wait ${H(String(latest.userRating.breakdown?.wait ?? 0))}%</span><span>Avoid ${H(String(latest.userRating.breakdown?.avoid ?? 0))}%</span>`
        : `<span>${H(platformLabel(latest.platform))}</span><span>Released ${H(timeAgo(latest.releasedAt))}</span><span>Source checked ${H(timeAgo(latest.lastCheckedAt))}</span>`;
    }
    if (link) {
      link.href = `#/updates/${encodeURIComponent(latest.id)}`;
      link.classList.remove('hidden');
    }
  } catch {
    if (coverage) coverage.textContent = 'Verified sources reconnecting';
    const state = document.getElementById('landing-live-state');
    const name = document.getElementById('landing-live-name');
    const verdict = document.getElementById('landing-live-verdict');
    if (state) state.textContent = 'RECONNECTING';
    if (name) name.textContent = 'Live patch desk temporarily unavailable';
    if (verdict) verdict.textContent = 'No sample score is shown while verified source data is unavailable.';
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
const PLATFORM_CLASS = {
  AMD:'amd', NVIDIA:'nvidia', Apple:'apple', PS5:'ps5', Windows:'windows', Steam:'steam',
  macOS:'macos', Intel:'intel', Xbox:'xbox', Switch:'switch', Discord:'discord', BattleNet:'battlenet', GOG:'gog',
};
const PLATFORM_SHORT = { AMD:'AMD', NVIDIA:'NV', Apple:'', PS5:'PS5', Windows:'WIN', Steam:'STM', macOS:'MAC', Intel:'INT', Xbox:'XBX', Switch:'SW', Discord:'DSC', BattleNet:'BNET', GOG:'GOG' };
const PLATFORM_LOGOS = {
  AMD:       '/platform-logos/simple-icons/amd.svg',
  NVIDIA:    '/platform-logos/simple-icons/nvidia.svg',
  Apple:     '/platform-logos/simple-icons/apple.svg',
  macOS:     '/platform-logos/simple-icons/macos.svg',
  Intel:     '/platform-logos/simple-icons/intel.svg',
  Windows:   '/platform-logos/wikimedia/windows.svg',
  Steam:     '/platform-logos/simple-icons/steam.svg',
  SteamDeck: '/platform-logos/simple-icons/steamdeck.svg',
  Switch:    '/platform-logos/wikimedia/nintendo-switch.svg',
  Xbox:      '/platform-logos/wikimedia/xbox.svg',
  PS5:       '/platform-logos/simple-icons/playstation5.svg',
  Discord:   '/platform-logos/simple-icons/discord.svg',
  BattleNet: '/platform-logos/simple-icons/battledotnet.svg',
  GOG:       '/platform-logos/simple-icons/gogdotcom.svg',
};
const TRACKED_PLATFORMS = ['AMD','NVIDIA','Intel','Apple','macOS','Windows','Steam','Discord','BattleNet','GOG','Switch','Xbox','PS5'];
const TICKER_SERVICES = [
  'AMD', 'NVIDIA', 'Intel', 'Apple iOS', 'macOS', 'Windows',
  'Steam', 'Steam Deck', 'SteamOS', 'Discord', 'Battle.net', 'GOG Galaxy', 'Switch', 'Xbox', 'PS5',
];
const PLATFORM_CATEGORY_META = {
  pcHardware: { title: 'PC Hardware & Drivers', subtitle: 'GPU, graphics driver, and silicon update lanes.', platforms: ['NVIDIA', 'AMD', 'Intel'] },
  desktopOs:  { title: 'Desktop OS & Apple', subtitle: 'Windows, macOS, and iOS security and stability releases.', platforms: ['Windows', 'Apple', 'macOS'] },
  gaming:     { title: 'Gaming Platforms', subtitle: 'Steam, Steam Deck, consoles, launchers, and live game-service tooling.', platforms: ['Steam', 'Switch', 'Xbox', 'PS5', 'Discord', 'BattleNet', 'GOG'] },
  browsers:   { title: 'Web Browsers', subtitle: 'Browser-specific patch lanes are coming soon once official sources are wired.', platforms: [] },
};
const PLATFORM_CATEGORY_ORDER = ['pcHardware', 'desktopOs', 'gaming', 'browsers'];
const PLATFORM_TO_CATEGORY = Object.fromEntries(Object.entries(PLATFORM_CATEGORY_META).flatMap(([key, meta]) => meta.platforms.map(platform => [platform, key])));
const SEARCH_SUGGESTIONS = [
  'Steam Deck', 'SteamOS', 'Discord', 'Battle.net', 'GOG Galaxy',
  'Switch OLED', 'Joy-Con', 'MacBook Pro M3', 'MacBook Air M2',
  'RTX 4090', 'RTX 50', 'RX 7900 XT', 'Arc A770', 'VPN', 'anti-cheat',
];
const SEARCH_ALIASES = {
  steamos: ['steamos', 'steam os', 'steam deck', 'deck', 'valve handheld'],
  'steam deck': ['steam deck', 'steamos', 'deck', 'dock', 'docked'],
  cs2: ['cs2', 'counter-strike 2', 'counter strike 2', 'global offensive'],
  'counter strike': ['counter-strike 2', 'counter strike 2', 'cs2'],
  helldivers: ['helldivers', 'helldivers 2', 'anti-cheat', 'matchmaking'],
  switch: ['switch', 'nintendo', 'joy-con', 'joycon', 'switch oled', 'switch lite'],
  discord: ['discord', 'voice chat', 'overlay', 'rtc', 'rich presence'],
  battlenet: ['battle.net', 'battlenet', 'blizzard', 'warcraft', 'diablo', 'overwatch'],
  gog: ['gog', 'gog galaxy', 'galaxy client', 'cd projekt'],
  macbook: ['macbook', 'macbook pro', 'macbook air', 'm1', 'm2', 'm3', 'm4'],
  rtx: ['rtx', 'nvidia', 'dlss', 'game ready'],
  radeon: ['radeon', 'amd', 'rx 7900', 'adrenalin'],
};
const FOLLOWABLE_STEAM_GAMES = STEAM_GAME_CANDIDATES;

function platformSuffix(p) { return PLATFORM_CLASS[p] || 'default'; }
function platformLabel(p) { return ({ BattleNet: 'Battle.net', GOG: 'GOG Galaxy' })[p] || p; }
function platformLogoPath(platform) { return PLATFORM_LOGOS[platform] || null; }
function renderPlatformLogo(platform, extraClass = '') {
  const pSuffix = platformSuffix(platform);
  const label = platformLabel(platform);
  const short = PLATFORM_SHORT[platform] ?? String(platform || '').slice(0, 3).toUpperCase();
  const src = platformLogoPath(platform);
  const classes = `platform-logo platform--${pSuffix}${extraClass ? ` ${extraClass}` : ''}`;
  if (!src) return `<span class="${classes} platform-logo--fallback" aria-label="${H(label)}">${H(short)}</span>`;
  return `<span class="${classes}" aria-label="${H(label)}"><img src="${H(src)}" alt="" loading="eager" decoding="async" /><span class="sr-only">${H(label)}</span></span>`;
}
function serviceLogoKey(service) {
  return ({
    'Apple iOS': 'Apple',
    'Steam Deck': 'SteamDeck',
    'SteamOS': 'SteamDeck',
    'Battle.net': 'BattleNet',
    'GOG Galaxy': 'GOG',
  })[service] || service;
}
function renderServiceTickerItem(service) {
  const key = serviceLogoKey(service);
  return `<span class="service-ticker-item">${renderPlatformLogo(key, 'service-ticker-logo')}<span>${H(service)}</span></span>`;
}

function searchableTextForUpdate(u) {
  const nested = [
    ...(u.changelog || []),
    ...(u.knownIssues || []),
    ...(u.riskFactors || []).map(r => `${r.level || ''} ${r.text || ''}`),
    ...(u.evidence || []).map(e => `${e.source || ''} ${e.text || ''}`),
    u.securityCriticality?.label || '',
    ...(u.securityCriticality?.cves || []),
  ];
  return [
    u.id, u.platform, u.name, u.version, u.internalVersion, u.productId,
    u.sourceKind, releaseLaneLabel(u), u.affects, u.verdict, u.reasoning,
    ...nested,
  ].filter(Boolean).join(' ').toLowerCase();
}

function releaseLaneLabel(update) {
  if (update?.sourceKind === 'steam-game-news') return 'Steam game';
  if (update?.sourceKind === 'steam-client-news') return 'Steam client';
  if (update?.platform === 'Steam' && /steam(?:os| deck)/i.test(`${update?.name || ''} ${update?.affects || ''}`)) return 'SteamOS / Steam Deck';
  return platformLabel(update?.platform);
}

function releaseLaneKey(update) {
  const product = update?.productId || update?.sourceKind || 'platform';
  return `${update?.platform || 'unknown'}:${product}`;
}

function searchNeedles(raw) {
  const q = raw.toLowerCase().trim();
  if (!q) return [];
  const base = [q];
  for (const [key, aliases] of Object.entries(SEARCH_ALIASES)) {
    if (q === key || aliases.some(alias => alias.includes(q) || q.includes(alias))) {
      base.push(...aliases);
    }
  }
  return [...new Set(base.map(s => s.toLowerCase().trim()).filter(Boolean))];
}

function peerRatingMeta(update) {
  const rating = update?.userRating || null;
  const votes = Number(rating?.totalVotes || 0);
  const breakdown = rating?.breakdown || {};
  const install = Math.max(0, Math.min(100, Number(breakdown.install) || 0));
  const wait = Math.max(0, Math.min(100, Number(breakdown.wait) || 0));
  const avoid = Math.max(0, Math.min(100, Number(breakdown.avoid) || 0));
  const score = votes ? validScoreOrNull(rating.score) : null;
  const label = !votes ? 'Patch notes only'
    : install >= 70 ? 'Users say install'
      : avoid >= 35 ? 'Users say avoid'
        : wait >= 35 ? 'Users say wait'
          : 'Mixed community signal';
  return { score, install, wait, avoid, label, votes };
}

function formatPackageSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** unitIndex);
  const decimals = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(decimals)} ${units[unitIndex]}`;
}

function packageSizeMeta(update) {
  const downloads = [
    ...(Array.isArray(update?.downloads) ? update.downloads : []),
    ...(Array.isArray(update?.artifacts) ? update.artifacts : []),
  ];
  const evidence = Array.isArray(update?.evidence) ? update.evidence : [];
  const byteCandidates = [
    update?.sizeBytes,
    update?.packageSizeBytes,
    update?.downloadSizeBytes,
    ...downloads.map(item => item?.sizeBytes),
    ...evidence.map(item => item?.sizeBytes),
  ];
  const byteValue = byteCandidates.find(value => Number.isFinite(Number(value)) && Number(value) > 0);
  const formattedBytes = formatPackageSize(byteValue);
  if (formattedBytes) {
    return { value: formattedBytes, available: true, note: 'Vendor package' };
  }

  const textCandidates = [
    update?.packageSize,
    update?.downloadSize,
    update?.fileSize,
    ...downloads.map(item => item?.size),
    ...evidence.map(item => item?.packageSize),
  ];
  const textValue = textCandidates.find(value => typeof value === 'string' && value.trim());
  if (textValue) {
    return { value: textValue.trim().slice(0, 48), available: true, note: 'Vendor package' };
  }

  return { value: 'Not listed', available: false, note: 'Not published by vendor' };
}


function getFollowedSteamGames() {
  try { return JSON.parse(localStorage.getItem('patchticker.followedSteamGames') || '[]'); }
  catch { return []; }
}

function setFollowedSteamGames(games) {
  localStorage.setItem('patchticker.followedSteamGames', JSON.stringify(games));
}

function findSteamGame(query) {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  return FOLLOWABLE_STEAM_GAMES.find(g =>
    g.name.toLowerCase().includes(q) || g.appId === q || g.tags.toLowerCase().includes(q)
  ) || null;
}

function scoreColor(score) {
  const valid = validScoreOrNull(score);
  if (valid === null) return 'var(--text-3)';
  // Returns an interpolated hex between red (#f87171) and green (#4ade80) based on score 0–10
  const t   = valid / 10;
  const r   = Math.round(248 + (74  - 248) * t);
  const g   = Math.round(113 + (222 - 113) * t);
  const b   = Math.round(113 + (128 - 113) * t);
  return `rgb(${r},${g},${b})`;
}

function validScoreOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 10
    ? Math.round(numeric * 10) / 10
    : null;
}

function scoreDisplay(value) {
  const score = validScoreOrNull(value);
  return score === null ? 'Not scored' : score.toFixed(1);
}

// ── Bug report community feed renderer ───────────────────────────────────────
// Shared between the detail page and the platform page.
// Renders bug reports as a social community feed with severity badges,
// timestamps, and a submit form for Pro users.

function renderBugFeed(containerEl, reports, updateId) {
  const user = getUser();
  const isPro = user?.role === 'pro' || user?.role === 'admin';

  const SEVERITY_META = {
    critical: { color: 'var(--red)',    label: 'Critical', icon: '🔴' },
    high:     { color: '#f97316', label: 'High', icon: '🟠' },
    medium:   { color: 'var(--yellow)', label: 'Medium',   icon: '🟡' },
    low:      { color: 'var(--green)',  label: 'Low',      icon: '🔵' },
  };

  function reportCard(r) {
    const meta = SEVERITY_META[r.severity] || SEVERITY_META.low;
    const ago  = timeAgo(r.createdAt);
    return `
      <div class="bug-card">
        <div class="bug-card-header">
          <span class="bug-severity-badge" style="background:${meta.color}20;border-color:${meta.color};color:${meta.color}">
            ${meta.icon} ${meta.label}
          </span>
          <span class="bug-card-time">${ago}</span>
        </div>
        <p class="bug-card-body">${H(r.description)}</p>
      </div>
    `;
  }

  const listHTML = reports.length
    ? reports.map(reportCard).join('')
    : '<p class="bug-feed-empty">No bug reports yet. Be the first to report an issue.</p>';

  const formHTML = isPro ? `
    <div class="bug-submit-box" id="bug-submit-box-${H(updateId)}">
      <h3 class="bug-submit-title">Report a bug</h3>
      <div id="bug-submit-error-${H(updateId)}" class="account-alert account-alert--error hidden"></div>
      <div id="bug-submit-ok-${H(updateId)}"    class="account-alert account-alert--success hidden">Report submitted. Thanks!</div>
      <select class="field-input bug-severity-select" id="bug-severity-${H(updateId)}">
        <option value="">— Severity —</option>
        <option value="critical">🔴 Critical</option>
        <option value="high">🟠 High</option>
        <option value="medium">🟡 Medium</option>
        <option value="low">🔵 Low</option>
      </select>
      <textarea class="field-input bug-desc-input" id="bug-desc-${H(updateId)}"
        placeholder="Describe the issue clearly — hardware, OS version, steps to reproduce…"
        rows="3" maxlength="1000"></textarea>
      <button class="btn btn--primary btn--sm" id="bug-submit-btn-${H(updateId)}">Submit report</button>
    </div>
  ` : user ? `
    <div class="bug-upsell">
      <span>🔒</span> <a href="#/pricing">Upgrade to Pro</a> to submit bug reports
    </div>
  ` : `
    <div class="bug-upsell">
      <a href="#/login">Sign in</a> to submit bug reports
    </div>
  `;

  containerEl.innerHTML = `
    <div class="bug-feed">
      <div class="bug-feed-list" id="bug-feed-list-${H(updateId)}">${listHTML}</div>
      ${formHTML}
    </div>
  `;

  // Wire submit button
  const submitBtn = document.getElementById(`bug-submit-btn-${updateId}`);
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async () => {
    const errEl  = document.getElementById(`bug-submit-error-${updateId}`);
    const okEl   = document.getElementById(`bug-submit-ok-${updateId}`);
    const severity = document.getElementById(`bug-severity-${updateId}`)?.value;
    const description = document.getElementById(`bug-desc-${updateId}`)?.value?.trim();

    errEl.classList.add('hidden');
    okEl.classList.add('hidden');

    if (!severity)    { errEl.textContent = 'Please select a severity.'; errEl.classList.remove('hidden'); return; }
    if (!description || description.length < 10) {
      errEl.textContent = 'Description must be at least 10 characters.';
      errEl.classList.remove('hidden'); return;
    }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
    try {
      const { submitBugReport } = await import('./api.js');
      const result = await submitBugReport({ updateId, severity, description });

      okEl.classList.remove('hidden');
      document.getElementById(`bug-severity-${updateId}`).value = '';
      document.getElementById(`bug-desc-${updateId}`).value = '';

      // Prepend new report to feed optimistically
      const listEl = document.getElementById(`bug-feed-list-${updateId}`);
      if (listEl && result?.data) {
        const newCard = document.createElement('div');
        newCard.innerHTML = reportCard(result.data);
        listEl.prepend(newCard.firstElementChild);
        const emptyMsg = listEl.querySelector('.bug-feed-empty');
        if (emptyMsg) emptyMsg.remove();
      }
    } catch (err) {
      errEl.textContent = err.message || 'Submission failed. Please try again.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = 'Submit report';
    }
  });
}

// ── Time ago helper ───────────────────────────────────────────────────────────
function timeAgo(isoString) {
  const parsed = new Date(isoString).getTime();
  if (!Number.isFinite(parsed)) return 'refresh pending';
  const diff = Math.max(0, Date.now() - parsed);
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function updateDateLabel(update) {
  if (update?.dateBasis === 'source-updated') return 'Source updated';
  if (update?.dateBasis === 'published') return 'Published';
  return 'Released';
}

function freshnessMeta(update) {
  const evidence = Array.isArray(update?.evidence) ? update.evidence : [];
  const officialSources = Number.isFinite(Number(update?.officialSourceCount))
    ? Number(update.officialSourceCount)
    : evidence.filter(item => item?.url && !/(?:reddit\.com|^r\/)/i.test(`${item.source || ''} ${item.url}`)).length;

  if (update?.releasePosition === 'previous') {
    return {
      label: 'Earlier release',
      tone: 'archive',
      detail: 'Official source archived',
      officialSources,
    };
  }

  const checkedAt = update?.lastCheckedAt
    || update?.updatedAt
    || evidence.find(item => item?.checkedAt)?.checkedAt
    || update?.aiGeneratedAt
    || null;
  const checkedMs = checkedAt ? new Date(checkedAt).getTime() : NaN;
  const hours = Number.isFinite(checkedMs) ? Math.max(0, (Date.now() - checkedMs) / 3600000) : null;

  if (hours === null) return { label: 'Source snapshot', tone: 'snapshot', detail: 'Refresh pending', officialSources };
  if (hours <= 8) return { label: 'Fresh', tone: 'fresh', detail: `Checked ${timeAgo(checkedAt)}`, officialSources };
  if (hours <= 36) return { label: 'Recent', tone: 'recent', detail: `Checked ${timeAgo(checkedAt)}`, officialSources };
  if (hours <= 96) return { label: 'Aging', tone: 'aging', detail: `Checked ${timeAgo(checkedAt)}`, officialSources };
  return { label: 'Recheck due', tone: 'stale', detail: `Checked ${timeAgo(checkedAt)}`, officialSources };
}

function securitySignalMeta(update) {
  const security = update?.securityCriticality || {};
  const cves = Array.isArray(security.cves) ? security.cves : [];
  const reportedTotal = Number(security.totalCves);
  const total = Number.isFinite(reportedTotal) && reportedTotal >= cves.length
    ? reportedTotal
    : cves.length;
  if (!total) return null;
  const tone = ['critical', 'high', 'medium', 'low'].includes(security.level)
    ? security.level
    : 'medium';
  return {
    total,
    tone,
    label: `${total} CVE${total === 1 ? '' : 's'} documented`,
  };
}

function driverImpactMeta(update) {
  if (!['NVIDIA', 'AMD', 'Intel'].includes(update?.platform)) return null;
  const evidence = Array.isArray(update?.evidence) ? update.evidence : [];
  const metric = (key) => evidence.reduce((highest, item) => {
    const value = Number(item?.[key]);
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 0);
  const gameSupportCount = metric('gameSupportCount');
  const gameFixCount = metric('gameFixCount');
  const knownIssueCount = Math.max(metric('knownIssueCount'), (update.knownIssues || []).length);
  const parts = [];
  if (gameSupportCount) parts.push(`${gameSupportCount} supported game${gameSupportCount === 1 ? '' : 's'}`);
  if (gameFixCount) parts.push(`${gameFixCount} fix${gameFixCount === 1 ? '' : 'es'}`);
  if (knownIssueCount) parts.push(`${knownIssueCount} known issue${knownIssueCount === 1 ? '' : 's'}`);
  if (!parts.length) return null;
  return { label: parts.join(' · '), knownIssueCount };
}

function decisionPanelFacts(update, freshness) {
  const evidence = Array.isArray(update?.evidence) ? update.evidence : [];
  const knownIssueCount = Array.isArray(update?.knownIssues) ? update.knownIssues.length : 0;
  const issueFact = knownIssueCount
    ? { value: String(knownIssueCount), label: `Known issue${knownIssueCount === 1 ? '' : 's'}`, tone: 'risk' }
    : update?.knownIssuesAuthoritative
      ? { value: 'None', label: 'Vendor-known issues', tone: 'good' }
      : { value: 'Unknown', label: 'Issue coverage', tone: 'neutral' };

  const security = update?.securityCriticality || {};
  const securitySignal = securitySignalMeta(update);
  const identity = `${update?.name || ''} ${update?.version || ''} ${(update?.riskFactors || []).map(item => `${item?.label || ''} ${item?.text || ''}`).join(' ')}`.toLowerCase();
  const hasWhql = evidence.some(item => item?.whql === true);
  const hasNonWhql = evidence.some(item => item?.whql === false) || /non-whql/.test(identity);
  let contextFact;
  if (securitySignal) {
    contextFact = { value: String(securitySignal.total), label: `Documented CVE${securitySignal.total === 1 ? '' : 's'}`, tone: securitySignal.tone };
  } else if (security.level && security.level !== 'none') {
    contextFact = { value: 'Security', label: 'Update context', tone: security.level };
  } else if (hasNonWhql) {
    contextFact = { value: 'Non-WHQL', label: 'Driver channel', tone: 'warning' };
  } else if (/preview/.test(identity)) {
    contextFact = { value: 'Preview', label: 'Release channel', tone: 'warning' };
  } else if (/beta/.test(identity)) {
    contextFact = { value: 'Beta', label: 'Release channel', tone: 'warning' };
  } else if (/insider|canary|experimental/.test(identity)) {
    contextFact = { value: 'Test build', label: 'Release channel', tone: 'warning' };
  } else if (hasWhql) {
    contextFact = { value: 'WHQL', label: 'Driver certification', tone: 'good' };
  } else {
    contextFact = { value: 'Vendor', label: 'Release channel', tone: 'neutral' };
  }

  const sourceCount = Math.max(0, Number(freshness?.officialSources) || 0);
  const sourceFact = {
    value: String(sourceCount),
    label: `Official source${sourceCount === 1 ? '' : 's'}`,
    tone: sourceCount ? 'info' : 'warning',
  };
  return [issueFact, contextFact, sourceFact];
}

function updateReturnBrief(updates = []) {
  const brief = document.getElementById('dash-return-brief');
  const label = document.getElementById('dash-return-label');
  const headline = document.getElementById('dash-return-headline');
  const detail = document.getElementById('dash-return-detail');
  const logos = document.getElementById('dash-return-platforms');
  if (!brief || !label || !headline || !detail || !logos || !updates.length) return;

  const newest = [...updates].sort((a, b) => Date.parse(b.createdAt || b.releasedAt) - Date.parse(a.createdAt || a.releasedAt));
  const isReturning = Number.isFinite(_updateVisitBaseline);
  const sinceLastVisit = isReturning
    ? newest.filter(update => Date.parse(update.createdAt || update.releasedAt) > _updateVisitBaseline)
    : [];
  const featured = (sinceLastVisit.length ? sinceLastVisit : newest).slice(0, 4);
  const latest = featured[0];

  brief.classList.toggle('has-new', sinceLastVisit.length > 0);
  label.textContent = isReturning ? 'Since your last visit' : 'Your live briefing';
  headline.textContent = sinceLastVisit.length
    ? `${sinceLastVisit.length} verified patch${sinceLastVisit.length === 1 ? '' : 'es'} arrived`
    : (isReturning ? 'You’re caught up' : `${updates.length} current releases are ready`);
  detail.textContent = sinceLastVisit.length
    ? `Newest: ${latest.name}`
    : `Latest release: ${latest.name} · ${timeAgo(latest.releasedAt)}`;
  logos.innerHTML = featured.map(update => renderPlatformLogo(update.platform, 'dash-return-logo')).join('');
  brief.onclick = () => navigate(`/updates/${encodeURIComponent(latest.id)}`);
  brief.setAttribute('aria-label', `Open ${latest.name}`);

  if (!_updateVisitRecorded) {
    localStorage.setItem(UPDATE_VISIT_STORAGE_KEY, new Date().toISOString());
    _updateVisitRecorded = true;
  }
}

function analysisMethodLabel(update) {
  if (update?.ratingsLive && update?.userRating?.totalVotes) {
    return `${update.userRating.totalVotes.toLocaleString()} user votes`;
  }
  return 'Source + issue signals';
}


function decisionForUpdate(u) {
  const vote = u.userRating?.breakdown || {};
  const score = validScoreOrNull(u.score);
  if (u.status === 'avoid' || (vote.avoid || 0) >= 35 || (score !== null && score < 4.5)) return { label: 'Avoid for now', cls: 'avoid', action: 'AVOID' };
  if (u.status === 'caution' || (vote.wait || 0) >= 30 || (score !== null && score < 7)) return { label: 'Wait and watch', cls: 'caution', action: 'WAIT' };
  return { label: 'Safe to install', cls: 'stable', action: 'INSTALL' };
}

function primaryRiskText(u) {
  const risk = (u.riskFactors || []).find(r => ['critical', 'high'].includes(r.level)) || (u.riskFactors || [])[0];
  if (risk?.text) return risk.text;
  if ((u.knownIssues || [])[0]) return (u.knownIssues || [])[0];
  return u.status === 'stable' ? 'No major issue pattern found yet.' : 'Watch user reports before installing.';
}

function setupMatchScore(u, terms) {
  const text = searchableTextForUpdate(u);
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function renderScoreBar(score, status) {
  const valid = validScoreOrNull(score);
  if (valid === null) return '<div class="score-unavailable">Score unavailable · patch notes remain available</div>';
  const pct   = Math.round((valid / 10) * 100);
  const color = scoreColor(valid);
  return `
    <div class="score-bar-wrap" title="Score: ${H(String(valid))} / 10">
      <div class="score-bar-track">
        <div class="score-bar-fill" style="height:${pct}%;background:${color};box-shadow:0 0 8px ${color}55"></div>
      </div>
      <div class="score-bar-value" style="color:${color}">${H(valid.toFixed(1))}</div>
    </div>
  `;
}


function renderInlineUpdatePanel(u, decision, rating, risk) {
  const releaseNotes = (u.changelog || []).slice(0, 8);
  const knownIssues = (u.knownIssues || []).slice(0, 6);
  const riskFactors = (u.riskFactors || []).slice(0, 6);
  const evidence = (u.evidence || []).slice(0, 6);
  const security = u.securityCriticality || {};
  const securityLabel = security.label || security.level || 'Not flagged as security-critical yet';
  const cves = security.cves || [];
  const ratingBreakdown = rating.breakdown || u.userRating?.breakdown || {};

  return `
    <div class="decision-expanded" hidden>
      <div class="decision-expanded-grid">
        <section class="decision-expanded-block decision-expanded-block--wide">
          <span>Update overview</span>
          <p>${H(u.reasoning || u.verdict || risk || 'PatchTicker is still gathering source notes and user reports for this update.')}</p>
        </section>

        <section class="decision-expanded-block">
          <span>Release notes</span>
          <ul>${releaseNotes.length ? releaseNotes.map(c => `<li>${H(c)}</li>`).join('') : '<li>No release notes loaded yet.</li>'}</ul>
        </section>

        <section class="decision-expanded-block">
          <span>Known issues</span>
          <ul>${knownIssues.length ? knownIssues.map(i => `<li>${H(i)}</li>`).join('') : '<li>No major known issues recorded yet.</li>'}</ul>
        </section>

        <section class="decision-expanded-block">
          <span>Risk factors</span>
          <ul>${riskFactors.length ? riskFactors.map(r => `<li><strong>${H(r.level || 'watch')}</strong> — ${H(r.text || r)}</li>`).join('') : `<li>${H(risk || 'No specific risk factor has been detected yet.')}</li>`}</ul>
        </section>

        ${rating.votes ? `
        <section class="decision-expanded-block">
          <span>User rating</span>
          <div class="decision-vote-breakdown">
            <div><b style="width:${Number(ratingBreakdown.install || 0)}%"></b><em>Install</em><strong>${H(String(ratingBreakdown.install || 0))}%</strong></div>
            <div><b style="width:${Number(ratingBreakdown.wait || 0)}%"></b><em>Wait</em><strong>${H(String(ratingBreakdown.wait || 0))}%</strong></div>
            <div><b style="width:${Number(ratingBreakdown.avoid || 0)}%"></b><em>Avoid</em><strong>${H(String(ratingBreakdown.avoid || 0))}%</strong></div>
          </div>
          <p class="decision-expanded-note">${H(String(rating.votes))} user votes counted.</p>
        </section>` : ''}

        <section class="decision-expanded-block">
          <span>Security context</span>
          <p>${H(securityLabel)}</p>
          ${cves.length ? `<div class="decision-cve-row">${cves.slice(0, 6).map(cve => `<code>${H(cve)}</code>`).join('')}</div>` : '<p class="decision-expanded-note">No CVE list attached to this update yet.</p>'}
        </section>

        <section class="decision-expanded-block decision-expanded-block--wide">
          <span>Sources</span>
          <div class="decision-source-list">
            ${evidence.length ? evidence.map(e => `
              <a href="${H(e.url || '#')}" target="_blank" rel="noopener noreferrer">
                <strong>${H(e.source || 'Source')}</strong>
                <small>${H(e.text || e.url || 'Open source')}</small>
              </a>
            `).join('') : '<p class="decision-expanded-note">No source links attached yet.</p>'}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderUpdateCard(u) {
  const pSuffix = platformSuffix(u.platform);
  const decision = decisionForUpdate(u);
  const rating = peerRatingMeta(u);
  const risk = primaryRiskText(u);
  const age = timeAgo(u.releasedAt);
  const freshness = freshnessMeta(u);
  const securitySignal = securitySignalMeta(u);
  const driverImpact = driverImpactMeta(u);
  const packageSize = packageSizeMeta(u);
  const sourceLabel = `${freshness.officialSources} official source${freshness.officialSources === 1 ? '' : 's'}`;
  const methodLabel = analysisMethodLabel(u);
  const ratingValue = rating.votes && rating.score !== null ? rating.score : validScoreOrNull(u.score);
  const ratingDisplay = scoreDisplay(ratingValue);
  const scoreLabel = rating.votes ? 'User rating' : 'Safety score';
  const ratingSource = rating.votes ? 'Live community' : 'PatchTicker';
  const ratingDetail = rating.votes
    ? `${rating.votes.toLocaleString()} vote${rating.votes === 1 ? '' : 's'}`
    : sourceLabel;
  const routeId = encodeURIComponent(u.id);
  return `
    <article class="decision-card decision-card--compact decision-card--${H(decision.cls)}" data-id="${H(u.id)}">
      <a class="decision-card-link" href="#/updates/${H(routeId)}" aria-label="Open ${H(u.name)} details">
        <div class="decision-card-content">
          <header class="decision-card-heading">
            ${renderPlatformLogo(u.platform, 'update-platform-icon decision-platform-icon')}
            <div class="decision-card-heading-copy">
              <div class="decision-card-kicker">
                <span class="decision-card-platform text-platform--${pSuffix}">${H(releaseLaneLabel(u))}</span>
                ${u.version ? `<span class="decision-card-version">Version ${H(u.version)}</span>` : ''}
                <span class="release-position release-position--${H(u.releasePosition || 'current')}">${u.releasePosition === 'previous' ? 'Earlier release' : 'Latest release'}</span>
              </div>
              <h3 class="decision-title">${H(u.name)}</h3>
            </div>
          </header>
          <dl class="decision-card-facts" aria-label="Update facts">
            <div>
              <dt>${H(updateDateLabel(u))}</dt>
              <dd>${H(formatReleaseDate(u.releasedAt))}</dd>
              <small>${H(age)}</small>
            </div>
            <div class="${packageSize.available ? '' : 'is-unavailable'}">
              <dt>Package size</dt>
              <dd>${H(packageSize.value)}</dd>
              <small>${H(packageSize.note)}</small>
            </div>
          </dl>
          <p class="decision-one-line">${H(u.verdict || risk)}</p>
          <div class="decision-card-trust" aria-label="Source freshness and security context">
            <span class="freshness-signal freshness-signal--${H(freshness.tone)}"><i aria-hidden="true"></i>${H(freshness.label)}</span>
            ${securitySignal ? `<span class="security-signal security-signal--${H(securitySignal.tone)}"><i aria-hidden="true">◆</i>${H(securitySignal.label)}</span>` : ''}
            ${driverImpact ? `<span class="driver-impact-signal platform--${H(pSuffix)}"><i aria-hidden="true">◈</i>${H(driverImpact.label)}</span>` : ''}
            <span>${H(freshness.detail)}</span>
            <span>${H(sourceLabel)}</span>
            <span>${H(methodLabel)}</span>
          </div>
        </div>
        <aside class="decision-card-rating" aria-label="Patch recommendation and rating">
          <span class="decision-action decision-action--${H(decision.cls)}">${H(decision.action)}</span>
          <span class="decision-card-rating-label">${H(scoreLabel)}</span>
          <div class="decision-card-rating-value"><strong>${H(ratingDisplay)}</strong>${ratingValue === null ? '' : '<span>/10</span>'}</div>
          <em>${H(ratingSource)}</em>
          <small>${H(ratingDetail)}</small>
        </aside>
      </a>
    </article>
  `;
}

function normaliseUpdatesResponse(res) {
  const updates = Array.isArray(res) ? res : (res?.data || []);
  return updates.map(update => ({
    ...update,
    score: validScoreOrNull(update?.score),
    impactScore: validScoreOrNull(update?.impactScore),
  }));
}

function annotateReleasePositions(updates = []) {
  const latestByLane = new Map();
  for (const update of updates) {
    const parsedReleaseMs = Date.parse(update?.releasedAt || '');
    const releasedMs = Number.isFinite(parsedReleaseMs) ? parsedReleaseMs : 0;
    const tieBreakMs = Date.parse(update?.createdAt || update?.updatedAt || '') || 0;
    const laneKey = releaseLaneKey(update);
    const current = latestByLane.get(laneKey);
    if (!current
      || releasedMs > current.releasedMs
      || (releasedMs === current.releasedMs && tieBreakMs > current.tieBreakMs)) {
      latestByLane.set(laneKey, { id: update.id, releasedMs, tieBreakMs });
    }
  }
  return updates.map(update => ({
    ...update,
    releasePosition: latestByLane.get(releaseLaneKey(update))?.id === update.id ? 'current' : 'previous',
  }));
}

function formatReleaseDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function renderMiniUpdateCard(u, variant = 'default') {
  const pSuffix = platformSuffix(u.platform);
  const tone    = variant === 'compact' ? ' mini-update-card--compact' : '';
  const freshness = freshnessMeta(u);
  const packageSize = packageSizeMeta(u);
  const rating = peerRatingMeta(u);
  const ratingValue = rating.votes && rating.score !== null ? rating.score : validScoreOrNull(u.score);
  const ratingDisplay = scoreDisplay(ratingValue);
  const scoreLabel = rating.votes ? 'User rating' : 'Safety score';
  const ratingSource = rating.votes ? 'Live community' : 'PatchTicker';
  return `
    <a class="mini-update-card${tone}" href="#/updates/${H(u.id)}">
      <div class="mini-update-top">
        ${renderPlatformLogo(u.platform, 'update-platform-icon mini-update-icon')}
        <span class="mini-update-status status-badge ${H(u.status)}">${H(u.status)}</span>
      </div>
      <div class="mini-update-title">${H(u.name)}</div>
      <div class="mini-update-meta">
        <span class="text-platform--${pSuffix}">${H(releaseLaneLabel(u))}</span>
        ${u.version ? `<span>Version ${H(u.version)}</span>` : ''}
      </div>
      <dl class="mini-update-facts" aria-label="Update facts">
        <div><dt>Released</dt><dd>${H(formatReleaseDate(u.releasedAt))}</dd></div>
        <div class="${packageSize.available ? '' : 'is-unavailable'}"><dt>Size</dt><dd>${H(packageSize.value)}</dd></div>
        <div><dt>${H(scoreLabel)}</dt><dd style="color:${scoreColor(ratingValue)}">${H(ratingDisplay)}${ratingValue === null ? '' : '/10'}</dd><small>${H(ratingSource)}</small></div>
      </dl>
      <div class="mini-update-freshness freshness-signal freshness-signal--${H(freshness.tone)}"><i aria-hidden="true"></i>${H(freshness.label)} · ${H(freshness.detail)}</div>
      <p class="mini-update-copy">${H(u.verdict || u.affects || 'Recent patch coverage available.')}</p>
    </a>
  `;
}

function renderRadarCard(title, description, updates) {
  const body = updates.length
    ? updates.map((u) => renderMiniUpdateCard(u, 'compact')).join('')
    : '<p class="dash-empty-copy">No tracked patches in this lane yet.</p>';
  return `
    <section class="radar-card">
      <div class="radar-card-header">
        <p class="radar-card-kicker">${H(title)}</p>
        <p class="radar-card-desc">${H(description)}</p>
      </div>
      <div class="radar-card-list">${body}</div>
    </section>
  `;
}


function renderCompareCard(label, u) {
  if (!u) return '<p class="dash-empty-copy">No comparison data available yet.</p>';
  const decision = decisionForUpdate(u);
  const rating = peerRatingMeta(u);
  return `
    <a class="compare-card compare-card--${H(decision.cls)}" href="#/updates/${H(u.id)}">
      <span class="compare-label">${H(label)}</span>
      <strong>${H(u.name)}</strong>
      <div class="compare-meta">
        <span>${H(platformLabel(u.platform))}</span>
        <span>${H(scoreDisplay(u.score))}${validScoreOrNull(u.score) === null ? '' : '/10 safety'}</span>
        ${rating.votes ? `<span>${H(String(rating.votes))} votes</span>` : '<span>patch notes only</span>'}
      </div>
      <p>${H(primaryRiskText(u))}</p>
    </a>
  `;
}

function latestTimestamp(updates) {
  const newest = [...(updates || [])].sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt))[0];
  return newest ? formatReleaseDate(newest.releasedAt) : 'No active patches';
}

function renderPlatformHeader(platform, updates, watchedSet = new Set()) {
  const pSuffix = platformSuffix(platform);
  const latest = latestTimestamp(updates);
  const watched = watchedSet.has(platform);
  return `
    <header class="platform-header platform--${H(pSuffix)}" id="platform-section-${H(pSuffix)}" data-platform="${H(platform)}">
      <div class="platform-header-main">
        ${renderPlatformLogo(platform, 'platform-header-logo')}
        <div>
          <p class="platform-header-kicker">${H(PLATFORM_CATEGORY_META[PLATFORM_TO_CATEGORY[platform]]?.title || 'Tracked platform')}</p>
          <h3>${H(platformLabel(platform))}</h3>
          <div class="platform-header-meta">
            <span>${H(String(updates.length))} active ${updates.length === 1 ? 'patch' : 'patches'}</span>
            <span>Latest ${H(latest)}</span>
          </div>
        </div>
      </div>
      <div class="platform-header-actions">
        <button class="platform-watch-btn ${watched ? 'is-watched' : ''}" type="button" data-watch-platform="${H(platform)}" aria-pressed="${watched ? 'true' : 'false'}">${watched ? 'Watching' : 'Follow'}</button>
        <button class="platform-filter-btn" type="button" data-filter-platform="${H(platform)}">Filter feed</button>
      </div>
    </header>
  `;
}

function renderGroupedUpdateSections(updates, watchedSet = new Set()) {
  const byCategory = new Map();
  updates.forEach((update) => {
    const category = PLATFORM_TO_CATEGORY[update.platform] || 'gaming';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(update);
  });

  return PLATFORM_CATEGORY_ORDER.map((categoryKey) => {
    const categoryUpdates = byCategory.get(categoryKey) || [];
    const meta = PLATFORM_CATEGORY_META[categoryKey];

    if (!categoryUpdates.length && categoryKey === 'browsers') {
      return `
        <section class="category-feed-section category-feed-section--soon" id="category-${H(categoryKey)}">
          <div class="category-section-header">
            <div>
              <p class="dash-section-kicker">Coming soon</p>
              <h2>${H(meta.title)}</h2>
              <span>Google Chrome, Microsoft Edge, and Firefox lanes will appear here after official parsers are enabled.</span>
            </div>
            <a href="#/updates" data-scroll-target="section-overview">Back to top ↑</a>
          </div>
          <div class="category-coming-soon">
            <span>Chrome</span><span>Edge</span><span>Firefox</span>
          </div>
        </section>
      `;
    }

    if (!categoryUpdates.length) return '';
    const byPlatform = new Map();
    categoryUpdates.forEach((update) => {
      if (!byPlatform.has(update.platform)) byPlatform.set(update.platform, []);
      byPlatform.get(update.platform).push(update);
    });
    const platformSections = meta.platforms
      .filter(platform => byPlatform.has(platform))
      .map(platform => `
        <section class="platform-feed-block">
          ${renderPlatformHeader(platform, byPlatform.get(platform), watchedSet)}
          <div class="platform-feed-cards">${byPlatform.get(platform).map(renderUpdateCard).join('')}</div>
        </section>
      `).join('');
    return `
      <section class="category-feed-section" id="category-${H(categoryKey)}">
        <div class="category-section-header">
          <div>
            <p class="dash-section-kicker">Category</p>
            <h2>${H(meta.title)}</h2>
            <span>${H(meta.subtitle)}</span>
          </div>
          <a href="#/updates" data-scroll-target="section-overview">Back to top ↑</a>
        </div>
        ${platformSections}
      </section>
    `;
  }).join('');
}

function renderFilteredUpdateResults(updates, { platform, status, sort, search }) {
  const labels = [];
  if (platform) labels.push(platformLabel(platform));
  if (status) labels.push(status[0].toUpperCase() + status.slice(1));
  if (search) labels.push(`“${search}”`);
  if (sort === 'score_desc') labels.push('Highest score first');
  if (sort === 'score_asc') labels.push('Lowest score first');
  if (sort === 'date_asc') labels.push('Oldest first');

  return `
    <section class="filtered-feed-section" aria-label="Filtered update results">
      <header class="filtered-feed-header">
        <div>
          <p class="dash-section-kicker">Current view</p>
          <h2>${H(String(updates.length))} ${updates.length === 1 ? 'update' : 'updates'}</h2>
        </div>
        <span>${H(labels.join(' · ') || 'Newest first')}</span>
      </header>
      <div class="filtered-update-cards">${updates.map(renderUpdateCard).join('')}</div>
    </section>
  `;
}

function renderSubscriptionBanner(billingData) {
  if (!billingData) return '';
  const { role, subscription: sub } = billingData;

  if (role === 'admin') {
    return `<div class="sub-banner sub-banner--admin">👑 Admin — full access</div>`;
  }
  if (role === 'pro' && sub) {
    const end    = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '—';
    const cancel = sub.cancelAtPeriodEnd ? ` · Cancels ${end}` : ` · Renews ${end}`;
    const trial  = sub.trialEnd && new Date(sub.trialEnd) > new Date()
      ? ` · Trial ends ${new Date(sub.trialEnd).toLocaleDateString()}`
      : '';
    return `
      <div class="sub-banner sub-banner--pro">
        <div class="sub-banner-left">
          <span class="sub-badge">PRO</span>
          <span class="sub-status">${H(sub.status)}${trial || cancel}</span>
        </div>
        <button class="sub-manage-btn" id="manage-sub-btn">Manage subscription</button>
      </div>
    `;
  }
  return `
    <div class="sub-banner sub-banner--free">
      <span>You're on the <strong>Free</strong> plan.</span>
      <a class="sub-upgrade-link" href="#/pricing">Upgrade to Pro →</a>
    </div>
  `;
}

async function renderDashboard({ focusId = null } = {}) {
  const user = getUser();
  const isAuthed = !!user;

  setHTML(`
    ${renderNav(user)}

    <div class="dash-wrap dash-wrap--simple dash-wrap--triad">
      <div id="sub-banner-slot" class="dash-sub-banner-slot"></div>

      <div class="service-ticker" aria-label="Supported PatchTicker services">
        <div class="service-ticker-track">
          ${[...TICKER_SERVICES, ...TICKER_SERVICES].map(service => `
            ${renderServiceTickerItem(service)}
          `).join('')}
        </div>
      </div>

      <div class="dash-layout">
        <aside class="dash-sidebar" aria-label="Dashboard controls">
          <div class="dash-rail-brand">
            <span class="dash-rail-kicker">PatchTicker desk</span>
            <strong><span class="brand-pulse">Patch</span>Ticker</strong>
            <p>Live install guidance for operating systems, drivers, launchers, firmware, and games.</p>
          </div>

          <nav class="topic-nav topic-nav--rail" aria-label="PatchTicker sections">
            <a class="topic-nav-link active" href="#/updates" data-scroll-target="section-overview">Overview</a>
            <a class="topic-nav-link" href="#/updates" data-scroll-target="section-tape">Live tape</a>
            <a class="topic-nav-link" href="#/updates" data-scroll-target="section-latest">Patch desk</a>
            <a class="topic-nav-link" href="#/updates" data-scroll-target="section-services">Services</a>
            ${hasRole('pro') || user?.role === 'admin' ? '<a class="topic-nav-link" href="#/updates" data-scroll-target="section-games">My games</a>' : ''}
          </nav>

          <section class="dash-filter-card" aria-label="Precise update filters">
            <div class="dash-filter-head">
              <span>Precise filter</span>
              <button class="link-btn dash-clear-link" id="dash-clear-all" type="button">Reset</button>
            </div>
            <div class="dash-search-row">
              <input class="dash-search" id="dash-search" type="search" placeholder="Search service, device, game, version…" autocomplete="off" />
              <button class="dash-search-clear hidden" id="dash-search-clear" type="button" aria-label="Clear search">×</button>
            </div>
            <div class="dash-search-status" id="dash-search-status" aria-live="polite"></div>
            <div class="dash-active-filters hidden" id="dash-active-filters">
              <span id="dash-filter-summary"></span>
            </div>
            <div class="dash-filter-actions">
              <span class="dash-filter-pending" id="dash-filter-pending" aria-live="polite">Filters are up to date</span>
              <button class="btn btn--primary dash-apply-filters" id="dash-apply-filters" type="button" disabled>Apply filters</button>
            </div>
          </section>

          <section class="dash-filter-card">
            <div class="dash-filter-head"><span>Setup lens</span></div>
            <div class="setup-lens-grid">
              <button class="setup-lens active" type="button" data-lens="" data-label="Everything">Everything</button>
              <button class="setup-lens" type="button" data-lens="windows nvidia amd intel steam discord battle.net gog galaxy" data-label="PC &amp; Steam">PC &amp; Steam</button>
              <button class="setup-lens" type="button" data-lens="steam steamdeck steamos switch ps5 xbox" data-label="Console &amp; handheld">Console &amp; handheld</button>
              <button class="setup-lens" type="button" data-lens="apple macos ios macbook" data-label="Apple devices">Apple devices</button>
            </div>
          </section>

          <section class="dash-filter-card">
            <div class="dash-filter-head"><span>Platform</span></div>
            <div class="dash-chip-grid" id="platform-filters">
              <button class="chip active" type="button" data-platform="">All</button>
              ${TRACKED_PLATFORMS.map(p => {
                const suffix = PLATFORM_CLASS[p] || 'default';
                return `<button class="chip platform--${suffix}" type="button" data-platform="${H(p)}">${H(platformLabel(p))}</button>`;
              }).join('')}
            </div>
          </section>

          <section class="dash-filter-card">
            <div class="dash-filter-head"><span>Status</span></div>
            <div class="dash-chip-grid dash-chip-grid--status" id="status-filters">
              <button class="chip active" type="button" data-status="">All</button>
              <button class="chip" type="button" data-status="stable">Stable</button>
              <button class="chip" type="button" data-status="caution">Caution</button>
              <button class="chip" type="button" data-status="avoid">Avoid</button>
            </div>
          </section>

          <section class="dash-filter-card">
            <label class="dash-filter-label" for="dash-sort">Sort desk</label>
            <select class="dash-sort" id="dash-sort">
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="score_desc">Highest score</option>
              <option value="score_asc">Lowest score</option>
            </select>
          </section>
        </aside>

        <main class="dash-main" aria-label="PatchTicker dashboard">
          <section class="dash-quickbar" aria-label="Quick feed navigation">
            <div class="dash-quickbar-primary">
              <div class="dash-quickbar-search">
                <span>Search</span>
                <input id="dash-top-search" type="search" placeholder="Search patches, devices, versions…" autocomplete="off" />
              </div>
              <select class="dash-top-sort" id="dash-top-sort" aria-label="Sort patch desk">
                <option value="date_desc">Newest first</option>
                <option value="date_asc">Oldest first</option>
                <option value="score_desc">Highest score</option>
                <option value="score_asc">Lowest score</option>
              </select>
              <button class="btn btn--primary dash-top-apply" id="dash-top-apply-filters" type="button" disabled>Apply</button>
              <button class="dash-quickbar-toggle" id="dash-quickbar-toggle" type="button" aria-controls="dash-quickbar-details" aria-expanded="true" aria-label="Hide update filters"><span>Hide filters</span><b aria-hidden="true">↑</b></button>
            </div>
            <div class="dash-quickbar-details" id="dash-quickbar-details">
              <div class="dash-ribbon" id="platform-ribbon">
                <button class="chip active" type="button" data-platform="">All</button>
                ${TRACKED_PLATFORMS.map(p => `<button class="chip platform--${platformSuffix(p)}" type="button" data-platform="${H(p)}">${H(platformLabel(p))}</button>`).join('')}
              </div>
              <div class="dash-status-ribbon" id="status-ribbon" aria-label="Status filters">
                <button class="chip active" type="button" data-status="">All status</button>
                <button class="chip" type="button" data-status="stable">Stable</button>
                <button class="chip" type="button" data-status="caution">Caution</button>
                <button class="chip" type="button" data-status="avoid">Avoid</button>
              </div>
              <div class="dash-lens-ribbon" aria-label="Setup lenses">
                <button class="setup-lens active" type="button" data-lens="" data-label="Everything">Everything</button>
                <button class="setup-lens" type="button" data-lens="windows nvidia amd intel steam discord battle.net gog galaxy" data-label="PC &amp; Steam">PC &amp; Steam</button>
                <button class="setup-lens" type="button" data-lens="steam steamdeck steamos switch ps5 xbox" data-label="Console &amp; handheld">Console &amp; handheld</button>
                <button class="setup-lens" type="button" data-lens="apple macos ios macbook" data-label="Apple devices">Apple devices</button>
              </div>
              <div class="dash-category-jumps" aria-label="Category jumps">
                ${PLATFORM_CATEGORY_ORDER.map(key => `<a href="#/updates" data-scroll-target="category-${H(key)}">${H(PLATFORM_CATEGORY_META[key].title)}</a>`).join('')}
              </div>
            </div>
          </section>
          <section class="dash-command-hero topic-section" id="section-overview">
            <div class="dash-command-copy">
              <p class="dash-hero-kicker">Live update status</p>
              <h1 class="dash-command-title">Decide what belongs on your machine today.</h1>
              <p class="dash-command-sub">PatchTicker turns vendor release notes, stability signals, security context, and user votes where available into a clear install / wait / avoid read.</p>
              <div class="dash-hero-actions">
                <a class="btn btn--primary topic-jump" href="#/updates" data-scroll-target="section-latest">Open the patch desk</a>
                ${isAuthed
                  ? '<a class="btn btn--secondary" href="#/account">Manage watchlist</a>'
                  : '<a class="btn btn--outline" href="#/register">Create free account</a>'}
              </div>
              <button class="dash-return-brief" id="dash-return-brief" type="button">
                <span class="dash-return-copy">
                  <small id="dash-return-label">Your live briefing</small>
                  <strong id="dash-return-headline">Checking what changed…</strong>
                  <em id="dash-return-detail">Comparing verified release history</em>
                </span>
                <span class="dash-return-platforms" id="dash-return-platforms" aria-hidden="true"></span>
                <b aria-hidden="true">→</b>
              </button>
              <div class="dash-coverage-pulse" id="dash-coverage-pulse" aria-live="polite">
                <span class="freshness-signal freshness-signal--snapshot" id="coverage-mode"><i aria-hidden="true"></i>Connecting sources</span>
                <strong id="coverage-sources">Checking source coverage…</strong>
                <span id="coverage-fresh">Lane freshness pending</span>
                <span id="coverage-health">Health check pending</span>
                <span id="coverage-last">Last sweep pending</span>
              </div>
              <div class="dash-source-heartbeats" aria-label="Platform source heartbeat">
                <span>Source heartbeat</span>
                <div class="dash-source-heartbeat-track" id="coverage-heartbeats">
                  <em>Checking platform lanes…</em>
                </div>
              </div>
            </div>
            <div class="dash-command-stats" id="dash-hero-stats" aria-label="Current update status totals">
              <div class="dash-command-stat"><span class="dash-stat-val" id="stat-stable">—</span><small>Stable</small></div>
              <div class="dash-command-stat"><span class="dash-stat-val dash-stat-val--caution" id="stat-caution">—</span><small>Caution</small></div>
              <div class="dash-command-stat"><span class="dash-stat-val dash-stat-val--avoid" id="stat-avoid">—</span><small>Avoid</small></div>
            </div>
          </section>

          <section class="dash-panel update-tape-panel topic-section" id="section-tape" aria-label="Live update tape">
            <div class="dash-panel-head update-tape-heading">
              <div><p class="dash-section-kicker">Live tape</p><h2>Newest movement</h2></div>
              <span class="dash-panel-badge">Right to left</span>
            </div>
            <div class="update-tape-window">
              <div class="update-tape-track" id="update-tape-track">${spinner()}</div>
            </div>
          </section>

          <section class="dash-panel topic-section" id="section-latest">
            <div class="dash-panel-head">
              <div><p class="dash-section-kicker">Patch desk</p><h2>Recent patches worth opening</h2></div>
              <p class="dash-panel-copy">Every row opens into a dedicated update page with notes, sources, and ratings when real votes exist.</p>
            </div>
            <div class="dash-feature-grid latest-decisions-grid" id="dash-feature-grid">
              ${spinner()}
            </div>
            <div class="updates-list updates-list--desk" id="updates-list">
              ${spinner()}
            </div>
          </section>
        </main>

        <aside class="dash-aside" aria-label="Live signals and service list">
          <section class="dash-panel dash-live-feed">
            <div class="dash-panel-head dash-panel-head--compact">
              <div><p class="dash-section-kicker">Community</p><h2>PatchTicker live chat</h2></div>
              <span class="feed-status"><span class="feed-dot" id="feed-dot"></span><span id="feed-status-text">${isAuthed ? 'Connecting' : 'Recent'}</span></span>
            </div>
            <p class="feed-privacy-note">Native community chat · no third-party tracker</p>
            <div class="feed-messages" id="feed-messages" aria-live="polite">
              <div class="feed-empty">Checking recent community activity…</div>
            </div>
            ${isAuthed ? `
              <div class="feed-compose">
                <select class="feed-platform-select" id="feed-platform" aria-label="Chat platform">
                  <option value="">General</option>
                  ${TRACKED_PLATFORMS.map(platform => `<option value="${H(platform)}">${H(platformLabel(platform))}</option>`).join('')}
                </select>
                <div class="feed-compose-message">
                  <input class="feed-input" id="feed-input" type="text" maxlength="280" placeholder="Share an update note…" aria-describedby="feed-char-count" />
                  <span class="feed-char-count" id="feed-char-count">0/280</span>
                </div>
                <button class="feed-send" id="feed-send" type="button">Send</button>
              </div>
            ` : `<p class="dash-side-copy">Public reading stays open. <a href="#/login">Sign in</a> to join the chat.</p>`}
          </section>

          <section class="dash-panel topic-section" id="section-services">
            <div class="dash-panel-head dash-panel-head--compact">
              <div><p class="dash-section-kicker">Tracked services</p><h2>Coverage</h2></div>
            </div>
            <p class="dash-side-copy">More platforms and device-specific lanes are coming soon as reliable official sources are added.</p>
            <div class="dash-platform-strip dash-platform-strip--vertical">
              ${TRACKED_PLATFORMS.map(p => {
                const suffix = PLATFORM_CLASS[p] || 'default';
                const short  = PLATFORM_SHORT[p] || p.slice(0,3).toUpperCase();
                return `<a class="platform-pill platform--${suffix}" href="#/platform/${H(p)}" title="${H(platformLabel(p))}">
                  ${renderPlatformLogo(p, 'platform-pill-icon')}
                  <span class="platform-pill-name">${H(platformLabel(p))}</span>
                </a>`;
              }).join('')}
            </div>
          </section>

          ${hasRole('pro') || user?.role === 'admin' ? `
          <section class="dash-panel follow-games-panel topic-section" id="section-games">
            <div class="dash-panel-head dash-panel-head--compact">
              <div><p class="dash-section-kicker">Pro</p><h2>Follow my games</h2></div>
            </div>
            <p class="dash-side-copy">Choose from ${FOLLOWABLE_STEAM_GAMES.length} reviewed Steam games above ${Number(STEAM_GAME_CANDIDATE_META.minimumAveragePlayers).toLocaleString()} average players. Routine hotfixes stay out of the feed.</p>
            <div class="follow-games-box">
              <div class="follow-games-search">
                <input class="dash-search" id="follow-game-input" type="search" placeholder="Search Steam games…" autocomplete="off" />
                <button class="btn btn--primary btn--sm" id="follow-game-add">Follow</button>
              </div>
              <div class="follow-game-suggestions" id="follow-game-suggestions"></div>
              <div class="followed-games" id="followed-games"></div>
            </div>
          </section>
          ` : `
          <section class="dash-panel dash-pro-lock">
            <div class="dash-panel-head dash-panel-head--compact">
              <div><p class="dash-section-kicker">Pro</p><h2>Follow my games</h2></div>
            </div>
            <p class="dash-side-copy">Pro users can follow specific games and launcher updates for a cleaner personal feed.</p>
            <a class="btn btn--outline btn--sm" href="#/pricing">View Pro</a>
          </section>
          `}

          <div id="ad-slot-dashboard" class="ad-slot ad-slot--dashboard"></div>
        </aside>
      </div>
    </div><!-- /.dash-wrap -->
    ${renderFooter()}
  `);
  document.body.classList.add('dashboard-shell-active');
  attachNavHandlers(user);
  attachTopicScrollNav();
  attachQuickbarScrollBehavior();
  refreshMotionEffects();
  if (focusId) {
    requestAnimationFrame(() => {
      document.getElementById(focusId)?.scrollIntoView({ block: 'start' });
    });
  }

  // Inject AdSense banner for free-tier users.
  injectAd('ad-slot-dashboard', 'auto');

  // Load billing status
  if (isAuthed) {
    try {
      const billing = await getBillingStatus();
      document.getElementById('sub-banner-slot').innerHTML = renderSubscriptionBanner(billing);
      const manageBtn = document.getElementById('manage-sub-btn');
      if (manageBtn) {
        manageBtn.addEventListener('click', async () => {
          manageBtn.disabled = true;
          try {
            const { url } = await openBillingPortal();
            window.location.href = url;
          } catch (err) {
            showToast(err.message, 'error');
            manageBtn.disabled = false;
          }
        });
      }
    } catch {
      document.getElementById('sub-banner-slot').innerHTML = '';
    }
  }

  // ── Filter state ─────────────────────────────────────────────────────────────
  // Controls edit a draft state. The feed changes only after an explicit Apply
  // action, preventing a sequence of selections from moving the results under
  // the user before they finish choosing.
  let _allUpdates  = [];   // full dataset from last fetch
  const defaultFilterState = () => ({
    platform: '', status: '', sort: 'date_desc', search: '', searchDisplay: '', searchMode: 'local',
  });
  let _filterState = defaultFilterState();
  let _draftFilterState = defaultFilterState();
  let _serverSearchResults = null;
  let _searchMode = 'local';
  let _searchLoading = false;
  let _searchError = '';
  let _searchRequestId = 0;
  let _searchAbortController = null;
  let _watchedPlatforms = new Set(JSON.parse(localStorage.getItem('patchticker.dashboardWatchlist') || '[]'));
  const saveDashboardWatchlist = () => localStorage.setItem('patchticker.dashboardWatchlist', JSON.stringify([..._watchedPlatforms]));

  function filtersAreDirty() {
    return ['platform', 'status', 'sort', 'search', 'searchMode']
      .some(key => _draftFilterState[key] !== _filterState[key]);
  }

  function syncDraftFilterControls() {
    document.querySelectorAll('#platform-filters .chip, #platform-ribbon .chip').forEach(button =>
      button.classList.toggle('active', button.dataset.platform === _draftFilterState.platform)
    );
    document.querySelectorAll('#status-filters .chip, #status-ribbon .chip').forEach(button =>
      button.classList.toggle('active', button.dataset.status === _draftFilterState.status)
    );
    document.querySelectorAll('[data-source-platform]').forEach(button =>
      button.classList.toggle('active', button.dataset.sourcePlatform === _draftFilterState.platform)
    );
    document.querySelectorAll('.setup-lens').forEach(button =>
      button.classList.toggle('active', button.dataset.lens === _draftFilterState.search && _draftFilterState.searchMode === 'local')
    );

    const visibleSearch = _draftFilterState.searchDisplay || _draftFilterState.search;
    const searchEl = document.getElementById('dash-search');
    const topSearchEl = document.getElementById('dash-top-search');
    if (searchEl && searchEl.value !== visibleSearch) searchEl.value = visibleSearch;
    if (topSearchEl && topSearchEl.value !== visibleSearch) topSearchEl.value = visibleSearch;
    document.getElementById('dash-search-clear')?.classList.toggle('hidden', !visibleSearch);

    const sortEl = document.getElementById('dash-sort');
    const topSortEl = document.getElementById('dash-top-sort');
    if (sortEl) sortEl.value = _draftFilterState.sort;
    if (topSortEl) topSortEl.value = _draftFilterState.sort;

    const dirty = filtersAreDirty();
    document.querySelectorAll('#dash-apply-filters, #dash-top-apply-filters').forEach(button => {
      button.disabled = !dirty;
      button.classList.toggle('has-pending', dirty);
    });
    const pendingEl = document.getElementById('dash-filter-pending');
    if (pendingEl) {
      pendingEl.textContent = dirty ? 'Changes ready · press Apply' : 'Filters are up to date';
      pendingEl.classList.toggle('is-pending', dirty);
    }
    updateSearchStatus();
  }

  function setDraftFilters(patch) {
    _draftFilterState = { ..._draftFilterState, ...patch };
    syncDraftFilterControls();
  }

  function applyFilters() {
    const { platform, status, sort, search } = _filterState;
    let filtered = search && _searchMode === 'server' && Array.isArray(_serverSearchResults)
      ? _serverSearchResults
      : _allUpdates;

    if (platform) filtered = filtered.filter(u => u.platform === platform);
    if (status)   filtered = filtered.filter(u => u.status   === status);
    if (search) {
      const needles = _filterState.searchMode === 'local'
        ? search.toLowerCase().split(/\s+/).filter(Boolean)
        : searchNeedles(search);
      filtered = filtered.filter(u => {
        const haystack = searchableTextForUpdate(u);
        return needles.some(q => haystack.includes(q));
      });
    }

    const sorters = {
      date_desc:  (a, b) => new Date(b.releasedAt) - new Date(a.releasedAt),
      date_asc:   (a, b) => new Date(a.releasedAt) - new Date(b.releasedAt),
      score_desc: (a, b) => (validScoreOrNull(b.score) ?? -1) - (validScoreOrNull(a.score) ?? -1),
      score_asc:  (a, b) => (validScoreOrNull(a.score) ?? 11) - (validScoreOrNull(b.score) ?? 11),
    };
    if (sorters[sort]) filtered = [...filtered].sort(sorters[sort]);

    const listEl = document.getElementById('updates-list');
    if (!listEl) return filtered.length;

    if (!filtered.length) {
      const hasFilters = platform || status || search;
      listEl.innerHTML = hasFilters
        ? (search
          ? `<div class="empty-state empty-state--search"><strong>No verified updates found for “${H(search)}”.</strong><span>Try a full game name, version number, Steam App ID, device, or platform. PatchTicker searches the last 240 days.</span><button class="link-btn" id="clear-inline">Clear filters</button></div>`
          : '<p class="empty-state">No updates match your filters. <button class="link-btn" id="clear-inline">Clear filters</button></p>')
        : '<p class="empty-state">No updates found.</p>';
      document.getElementById('clear-inline')?.addEventListener('click', clearAllFilters);
    } else {
      const keepsPlatformBrowse = sort === 'date_desc' && !status && !search;
      listEl.innerHTML = keepsPlatformBrowse
        ? renderGroupedUpdateSections(filtered, _watchedPlatforms)
        : renderFilteredUpdateResults(filtered, _filterState);
    }

    refreshMotionEffects(listEl);
    updateFilterSummary();
    updateSearchStatus(filtered.length);
    return filtered.length;
  }

  function updateSearchStatus(resultCount = 0) {
    const el = document.getElementById('dash-search-status');
    if (!el) return;
    if (filtersAreDirty()) {
      el.textContent = 'Ready to update · press Apply filters';
      el.className = 'dash-search-status is-pending';
      return;
    }
    if (!_filterState.search) {
      el.textContent = '';
      el.className = 'dash-search-status';
      return;
    }
    if (_searchLoading) {
      el.textContent = 'Searching every verified release…';
      el.className = 'dash-search-status is-loading';
      return;
    }
    if (_searchError) {
      el.textContent = `Live search unavailable · showing cached matches (${resultCount})`;
      el.className = 'dash-search-status is-error';
      return;
    }
    el.textContent = _searchMode === 'server'
      ? `Database search · ${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`
      : `${resultCount} cached ${resultCount === 1 ? 'match' : 'matches'}`;
    el.className = 'dash-search-status is-ready';
  }

  function resetServerSearch() {
    _searchRequestId += 1;
    _searchAbortController?.abort();
    _searchAbortController = null;
    _serverSearchResults = null;
    _searchLoading = false;
    _searchError = '';
  }

  async function runAuthoritativeSearch(rawQuery) {
    const query = String(rawQuery || '').trim();
    _searchMode = 'server';
    resetServerSearch();
    if (!query) {
      _searchMode = 'local';
      return applyFilters();
    }

    const requestId = ++_searchRequestId;
    const controller = new AbortController();
    _searchAbortController = controller;
    _searchLoading = true;
    applyFilters(); // instant cached matches while the authoritative search runs

    try {
      const response = await fetchUpdates({
        platform: _filterState.platform,
        status: _filterState.status,
        search: query,
        sort: _filterState.sort,
        signal: controller.signal,
      });
      if (requestId !== _searchRequestId) return 0;
      _serverSearchResults = annotateReleasePositions(
        normaliseUpdatesResponse(response).filter(update => isUpdateWithinDisplayWindow(update))
      );
      _searchLoading = false;
      _searchError = '';
      const resultCount = applyFilters();
      captureAnalytics('search_completed', {
        query_length: query.length,
        result_count: resultCount,
        has_results: resultCount > 0,
      });
      return resultCount;
    } catch (err) {
      if (err?.name === 'AbortError' || requestId !== _searchRequestId) return 0;
      _searchLoading = false;
      _searchError = err?.message || 'Search unavailable';
      _serverSearchResults = null;
      return applyFilters();
    }
  }

  function updateFilterSummary() {
    const { platform, status, search, searchDisplay } = _filterState;
    const summaryEl  = document.getElementById('dash-filter-summary');
    const containerEl = document.getElementById('dash-active-filters');
    if (!summaryEl || !containerEl) return;

    const parts = [];
    if (platform) parts.push(`Platform: <strong>${H(platformLabel(platform))}</strong>`);
    if (status)   parts.push(`Status: <strong>${H(status)}</strong>`);
    if (search)   parts.push(`Search: <strong>"${H(searchDisplay || search)}"</strong>`);

    if (parts.length) {
      summaryEl.innerHTML = parts.join(' · ');
      containerEl.classList.remove('hidden');
    } else {
      containerEl.classList.add('hidden');
    }
  }

  function clearAllFilters() {
    resetServerSearch();
    _searchMode = 'local';
    const preservedSort = _draftFilterState.sort || _filterState.sort;
    _filterState = { ...defaultFilterState(), sort: preservedSort };
    _draftFilterState = { ..._filterState };
    syncDraftFilterControls();
    applyFilters();
  }

  function setPlatformFilter(platform) {
    setDraftFilters({ platform: platform || '' });
  }

  async function applyDraftFilters() {
    _filterState = { ..._draftFilterState };
    syncDraftFilterControls();
    captureAnalytics('filters_applied', {
      platform: _filterState.platform || 'all',
      status: _filterState.status || 'all',
      sort: _filterState.sort,
      has_search: Boolean(_filterState.search),
    });

    if (_filterState.search && _filterState.searchMode === 'server') {
      return runAuthoritativeSearch(_filterState.search);
    }

    resetServerSearch();
    _searchMode = 'local';
    return applyFilters();
  }

  function syncWatchButtons(platform) {
    const watched = _watchedPlatforms.has(platform);
    document.querySelectorAll('[data-watch-platform]').forEach((btn) => {
      if (btn.dataset.watchPlatform !== platform) return;
      btn.classList.toggle('is-watched', watched);
      btn.setAttribute('aria-pressed', watched ? 'true' : 'false');
      btn.textContent = watched ? 'Watching' : 'Follow';
    });
  }

  document.getElementById('updates-list')?.addEventListener('click', async (e) => {
    const filterBtn = e.target.closest('[data-filter-platform]');
    if (filterBtn) {
      setPlatformFilter(filterBtn.dataset.filterPlatform || '');
      document.getElementById('section-latest')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const watchBtn = e.target.closest('[data-watch-platform]');
    if (watchBtn) {
      const platform = watchBtn.dataset.watchPlatform;
      if (!platform) return;
      const shouldWatch = !_watchedPlatforms.has(platform);
      if (shouldWatch) _watchedPlatforms.add(platform);
      else _watchedPlatforms.delete(platform);
      saveDashboardWatchlist();
      syncWatchButtons(platform);
      captureAnalytics(shouldWatch ? 'watchlist_item_added' : 'watchlist_item_removed', {
        watchlist_type: 'platform',
        item_count: _watchedPlatforms.size,
      });

      if (isAuthed && (hasRole('pro') || user?.role === 'admin')) {
        try {
          const { upsertWatch, removeWatch } = await import('./api.js');
          if (shouldWatch) await upsertWatch(platform, { notifyEmail: true, notifyWebhook: false });
          else await removeWatch(platform);
        } catch (err) {
          showToast('Saved locally. Account watchlist sync failed.', 'error');
        }
      } else {
        showToast(shouldWatch ? 'Saved locally. Pro enables email and webhook alerts.' : 'Removed from local watchlist.', 'info');
      }
      return;
    }

    const card = e.target.closest('.decision-card');
    if (!card) return;
    if (e.target.closest('a')) return;
    const explicitToggle = e.target.closest('[data-expand-toggle]');
    const clickedCardShell = e.target === card || e.target.closest('.decision-card-answer, .decision-card-head, .decision-takeaway, .decision-chips, .decision-timeline, .decision-card-side');
    if (!explicitToggle && !clickedCardShell) return;

    const panel = card.querySelector('.decision-expanded');
    if (!panel) return;
    const isOpen = card.classList.toggle('is-expanded');
    panel.hidden = !isOpen;
    card.querySelectorAll('[data-expand-toggle]').forEach(btn => {
      btn.setAttribute('aria-expanded', String(isOpen));
      if (btn.classList.contains('decision-open')) btn.textContent = isOpen ? 'Close details ↑' : 'Click to open ↓';
    });
  });

  function renderTapeAndLatest(updates, message = 'Live patch feed is reconnecting. Showing recent PatchTicker coverage.') {
    const newest = [...(updates || [])].sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt));

    const tapeTrack = document.getElementById('update-tape-track');
    if (tapeTrack) {
      const tapeItems = newest.length ? [...newest, ...newest, ...newest] : [];
      tapeTrack.innerHTML = tapeItems.length
        ? tapeItems.map((u) => {
            const d = decisionForUpdate(u);
            const delta = u.status === 'stable' ? '↑' : u.status === 'avoid' ? '↓' : '•';
            return `<a class="update-tape-item update-tape-item--${H(d.cls)}" href="#/updates/${H(u.id)}"><b>${H(platformLabel(u.platform))}</b><span>${H(scoreDisplay(u.score))}</span><em>${H(d.action)} ${delta}</em></a>`;
          }).join('')
        : `<span class="update-tape-empty">${H(message)}</span>`;
    }

    const featureGrid = document.getElementById('dash-feature-grid');
    if (featureGrid) {
      featureGrid.innerHTML = newest.slice(0, 6).map(renderMiniUpdateCard).join('') || `<p class="dash-empty-copy">${H(message)}</p>`;
      refreshMotionEffects(featureGrid);
    }
    refreshMotionEffects(document.getElementById('section-tape') || document);
  }

  function renderOfflineRails(message = 'Live patch feed is reconnecting. Verified patch data will return when the connection recovers.') {
    _allUpdates = [];
    renderTapeAndLatest([], message);
  }

  function renderVerifiedFeedFallback(message = 'No community notes yet. Start with recently verified releases.') {
    const messagesEl = document.getElementById('feed-messages');
    if (!messagesEl || messagesEl.querySelector('.feed-msg')) return;
    const recent = [..._allUpdates]
      .sort((a, b) => new Date(b.releasedAt || 0) - new Date(a.releasedAt || 0))
      .slice(0, 3);
    messagesEl.innerHTML = `
      <div class="feed-verified-list">
        <p class="feed-verified-intro">${H(message)}</p>
        ${recent.map(update => {
          const decision = decisionForUpdate(update);
          return `<a class="feed-verified-item" href="#/updates/${H(update.id)}">
            ${renderPlatformLogo(update.platform, 'feed-verified-logo')}
            <span><strong>${H(update.name)}</strong><small>${H(platformLabel(update.platform))} · ${H(timeAgo(update.releasedAt))}</small></span>
            <em class="feed-verified-score feed-verified-score--${H(decision.cls)}">${H(scoreDisplay(update.score))}</em>
          </a>`;
        }).join('') || '<span class="feed-empty">Verified patch data is reconnecting…</span>'}
      </div>`;
  }

  function renderSourceHeartbeats(updates = []) {
    const track = document.getElementById('coverage-heartbeats');
    if (!track) return;
    const latestByPlatform = new Map();
    for (const update of updates) {
      const checkedAt = update.lastCheckedAt || update.updatedAt || null;
      const timestamp = Date.parse(checkedAt);
      if (!Number.isFinite(timestamp)) continue;
      const current = latestByPlatform.get(update.platform);
      if (!current || timestamp > current.timestamp) latestByPlatform.set(update.platform, { update, checkedAt, timestamp });
    }

    track.innerHTML = TRACKED_PLATFORMS.map(platform => {
      const latest = latestByPlatform.get(platform);
      const ageHours = latest ? Math.max(0, (Date.now() - latest.timestamp) / 3600000) : Infinity;
      const tone = ageHours <= 24 ? 'fresh' : ageHours <= 96 ? 'aging' : 'stale';
      const detail = latest ? `checked ${timeAgo(latest.checkedAt)}` : 'check unavailable';
      return `<button class="dash-source-heartbeat dash-source-heartbeat--${tone} platform--${H(platformSuffix(platform))}" type="button" data-source-platform="${H(platform)}" aria-label="Filter to ${H(platformLabel(platform))}; ${H(detail)}" title="${H(platformLabel(platform))} · ${H(detail)}">
        ${renderPlatformLogo(platform, 'dash-source-heartbeat-logo')}
        <i aria-hidden="true"></i>
      </button>`;
    }).join('');

    track.querySelectorAll('[data-source-platform]').forEach(button => {
      button.addEventListener('click', () => {
        setPlatformFilter(button.dataset.sourcePlatform || '');
        document.getElementById('section-latest')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    syncDraftFilterControls();
  }

  // ── Initial data load ─────────────────────────────────────────────────────
  async function loadUpdates() {
    try {
      _allUpdates = annotateReleasePositions(
        normaliseUpdatesResponse(await fetchUpdates({}))
          .filter(update => isUpdateWithinDisplayWindow(update))
      );
      updateReturnBrief(_allUpdates);
      renderTapeAndLatest(_allUpdates);
      renderSourceHeartbeats(_allUpdates);
      renderVerifiedFeedFallback();
      applyFilters();
    } catch (err) {
      renderOfflineRails(`Live patch feed is reconnecting: ${err.message}`);
    }
  }

  function renderHomepageRails(updates) {
    renderTapeAndLatest(updates);
  }

  // ── Hero stats from summary ───────────────────────────────────────────────
  fetchSummary().then(res => {
    const d = res?.data || res;
    if (!d) return;
    const stable  = document.getElementById('stat-stable');
    const caution = document.getElementById('stat-caution');
    const avoid   = document.getElementById('stat-avoid');
    const coveragePulse = document.getElementById('dash-coverage-pulse');
    const coverageMode = document.getElementById('coverage-mode');
    const coverageSources = document.getElementById('coverage-sources');
    const coverageFresh = document.getElementById('coverage-fresh');
    const coverageHealth = document.getElementById('coverage-health');
    const coverageLast = document.getElementById('coverage-last');
    if (stable)  stable.textContent  = d.stable  ?? '—';
    if (caution) caution.textContent = d.caution ?? '—';
    if (avoid)   avoid.textContent   = d.avoid   ?? '—';
    const unavailable = d.dataMode === 'unavailable';
    const degraded = !unavailable && Number(d.stale96h || 0) > 0;
    if (coveragePulse) coveragePulse.classList.toggle('is-unavailable', unavailable);
    if (coveragePulse) coveragePulse.classList.toggle('is-degraded', degraded);
    if (coverageMode) {
      coverageMode.className = `freshness-signal freshness-signal--${unavailable ? 'stale' : 'fresh'}`;
      coverageMode.innerHTML = `<i aria-hidden="true"></i>${unavailable ? 'Sources reconnecting' : 'Live source coverage'}`;
    }
    if (coverageSources) coverageSources.textContent = unavailable
      ? 'No demo records shown'
      : `${d.sourceBacked ?? 0} verified update${d.sourceBacked === 1 ? '' : 's'} across ${d.platformsTracked ?? 0} platform${d.platformsTracked === 1 ? '' : 's'}`;
    if (coverageFresh) coverageFresh.textContent = unavailable
      ? 'Waiting for verified data'
      : `${d.fresh24h ?? 0}/${d.platformsTracked ?? 0} lanes checked in 24h`;
    if (coverageHealth) coverageHealth.textContent = unavailable
      ? 'Coverage unavailable'
      : (d.stale96h > 0
        ? `${d.stale96h} lane${d.stale96h === 1 ? '' : 's'} overdue`
        : 'All live lanes current');
    if (coverageLast) coverageLast.textContent = d.lastCheckedAt
      ? `Latest check ${timeAgo(d.lastCheckedAt)}`
      : 'Latest check pending';
  }).catch(() => {});

  // ── Setup lens buttons ─────────────────────────────────────────────────────
  document.querySelectorAll('.setup-lens').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.label === 'Everything' ? '' : btn.dataset.label;
      setDraftFilters({
        search: btn.dataset.lens || '',
        searchDisplay: label,
        searchMode: 'local',
        platform: '',
      });
    });
  });

  // ── Platform chip buttons ─────────────────────────────────────────────────
  document.querySelectorAll('#platform-filters .chip, #platform-ribbon .chip').forEach(btn => {
    btn.addEventListener('click', () => setPlatformFilter(btn.dataset.platform));
  });


  // ── Pro: Follow my games ──────────────────────────────────────────────────
  function renderFollowedGames() {
    const suggestionsEl = document.getElementById('follow-game-suggestions');
    const followedEl = document.getElementById('followed-games');
    if (!suggestionsEl || !followedEl) return;
    const followed = getFollowedSteamGames();
    const followedIds = new Set(followed.map(g => g.appId));
    const query = (document.getElementById('follow-game-input')?.value || '').trim().toLowerCase();
    const suggestions = FOLLOWABLE_STEAM_GAMES
      .filter(g => !query || g.name.toLowerCase().includes(query) || g.appId === query || g.tags.includes(query))
      .slice(0, query ? 12 : 8);
    suggestionsEl.innerHTML = suggestions.map(g => `
      <button class="follow-game-chip ${followedIds.has(g.appId) ? 'active' : ''}" data-app-id="${H(g.appId)}">${H(g.name)}</button>
    `).join('') || '<span class="follow-games-empty">No tracked game matches that search.</span>';
    followedEl.innerHTML = followed.length
      ? followed.map(g => `
          <div class="followed-game-card" data-app-id="${H(g.appId)}">
            <div><strong>${H(g.name)}</strong><span>Steam App ${H(g.appId)}</span></div>
            <button class="followed-game-filter" data-game="${H(g.name)}">Filter feed</button>
            <button class="followed-game-remove" aria-label="Remove ${H(g.name)}">×</button>
          </div>
        `).join('')
      : '<p class="follow-games-empty">No followed games yet. Add a Steam game to make this feed yours.</p>';
    refreshMotionEffects(document.getElementById('section-games') || document);
  }

  function addFollowedGame(game) {
    if (!game?.name) return;
    const followed = getFollowedSteamGames();
    if (!followed.some(g => g.appId === game.appId)) {
      followed.push({ appId: game.appId, name: game.name, tags: game.tags || game.name.toLowerCase() });
      setFollowedSteamGames(followed);
    }
    renderFollowedGames();
  }

  renderFollowedGames();
  document.getElementById('follow-game-add')?.addEventListener('click', () => {
    const input = document.getElementById('follow-game-input');
    const game = findSteamGame(input?.value || '');
    if (game) addFollowedGame(game);
    if (input) input.value = '';
  });
  document.getElementById('follow-game-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('follow-game-add')?.click();
    }
  });
  document.getElementById('follow-game-input')?.addEventListener('input', renderFollowedGames);
  document.getElementById('follow-game-suggestions')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-app-id]');
    if (!chip) return;
    const game = FOLLOWABLE_STEAM_GAMES.find(g => g.appId === chip.dataset.appId);
    addFollowedGame(game);
  });
  document.getElementById('followed-games')?.addEventListener('click', (e) => {
    const card = e.target.closest('.followed-game-card');
    if (!card) return;
    if (e.target.closest('.followed-game-remove')) {
      setFollowedSteamGames(getFollowedSteamGames().filter(g => g.appId !== card.dataset.appId));
      renderFollowedGames();
      return;
    }
    const filterBtn = e.target.closest('.followed-game-filter');
    if (filterBtn) {
      const query = filterBtn.dataset.game || '';
      setDraftFilters({ search: query, searchDisplay: query, searchMode: 'server' });
      showToast('Game filter ready. Press Apply to update the patch desk.', 'info');
    }
  });

  // ── Status chip buttons ───────────────────────────────────────────────────
  document.querySelectorAll('#status-filters .chip, #status-ribbon .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      setDraftFilters({ status: btn.dataset.status || '' });
    });
  });

  // ── Sort dropdown ─────────────────────────────────────────────────────────
  document.querySelectorAll('#dash-sort, #dash-top-sort').forEach(select => {
    select.addEventListener('change', event => setDraftFilters({ sort: event.target.value }));
  });

  // ── Search input (staged; Apply performs authoritative database search) ──
  const searchEl   = document.getElementById('dash-search');
  const topSearchEl = document.getElementById('dash-top-search');
  const clearBtn   = document.getElementById('dash-search-clear');

  topSearchEl?.addEventListener('input', (e) => {
    const val = e.target.value;
    setDraftFilters({ search: val.trim(), searchDisplay: val, searchMode: 'server' });
  });

  searchEl?.addEventListener('input', (e) => {
    const val = e.target.value;
    setDraftFilters({ search: val.trim(), searchDisplay: val, searchMode: 'server' });
  });

  clearBtn?.addEventListener('click', () => {
    setDraftFilters({ search: '', searchDisplay: '', searchMode: 'local' });
  });

  // ── Clear all ─────────────────────────────────────────────────────────────
  document.getElementById('dash-clear-all')?.addEventListener('click', clearAllFilters);
  document.querySelectorAll('#dash-apply-filters, #dash-top-apply-filters').forEach(button => {
    button.addEventListener('click', applyDraftFilters);
  });
  syncDraftFilterControls();

  loadUpdates();

  // ── Live community feed ───────────────────────────────────────────────────
  (function initFeed() {
    const messagesEl = document.getElementById('feed-messages');
    const inputEl    = document.getElementById('feed-input');
    const sendBtn    = document.getElementById('feed-send');
    const dotEl      = document.getElementById('feed-dot');
    const statusEl   = document.getElementById('feed-status-text');
    const platformEl = document.getElementById('feed-platform');
    const countEl    = document.getElementById('feed-char-count');
    if (!messagesEl) return;

    let   _sseClose    = null;
    let   _reconnectTimer = null;
    let   _connectionAttempt = 0;
    let   _disposed = false;
    let   _autoScroll  = true;   // pause scroll when user scrolls up
    const MAX_MESSAGES = 80;     // cap DOM nodes to keep it light

    // Detect scroll intent to pause auto-scroll
    messagesEl.addEventListener('scroll', () => {
      const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      _autoScroll = atBottom;
    });

    function scrollToBottom() {
      if (_autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function avatarLetter(email) {
      return (email || '?')[0].toUpperCase();
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function platformBadge(platform) {
      if (!platform) return '';
      const suffix = PLATFORM_CLASS[platform] || 'default';
      return `<span class="feed-platform-tag platform--${suffix}">${H(platformLabel(platform))}</span>`;
    }

    function appendMessage(post, animate = true) {
      if (!post?.id || messagesEl.querySelector(`[data-id="${CSS.escape(String(post.id))}"]`)) return;
      messagesEl.querySelector('.feed-empty')?.remove();
      messagesEl.querySelector('.feed-verified-list')?.remove();
      const userLabel = post.userLabel || post.userEmail?.split('@')[0] || 'Member';
      const isOwn    = Boolean(post.isOwn);
      const letter   = avatarLetter(userLabel);
      const el       = document.createElement('div');
      el.className   = `feed-msg${animate ? ' feed-msg--in' : ''}${isOwn ? ' feed-msg--own' : ''}`;
      el.dataset.id  = post.id;
      el.innerHTML   = `
        <div class="feed-msg-avatar">${H(letter)}</div>
        <div class="feed-msg-content">
          <div class="feed-msg-meta">
            <span class="feed-msg-name">${H(userLabel)}</span>
            ${platformBadge(post.platform)}
            <span class="feed-msg-time">${formatTime(post.createdAt)}</span>
          </div>
          <div class="feed-msg-body">${H(post.body)}</div>
        </div>
      `;
      messagesEl.appendChild(el);

      // Trim to MAX_MESSAGES
      while (messagesEl.children.length > MAX_MESSAGES) {
        messagesEl.removeChild(messagesEl.firstChild);
      }

      scrollToBottom();
    }

    function setStatus(status) {
      const labels = { connecting: 'Connecting', live: 'Live', error: 'Reconnecting', recent: 'Recent' };
      if (dotEl) {
        dotEl.className = `feed-dot feed-dot--${status}`;
        dotEl.title = labels[status] || '';
      }
      if (statusEl) statusEl.textContent = labels[status] || 'Recent';
    }

    // Load historical posts first
    async function loadHistory() {
      try {
        const posts = await fetchRecentPosts();
        if (posts.length === 0) {
          renderVerifiedFeedFallback();
        } else {
          posts.forEach(p => appendMessage(p, false));
        }
      } catch {
        renderVerifiedFeedFallback('Community notes are reconnecting. These releases were recently verified.');
        /* non-fatal — SSE will deliver new posts regardless */
      }
    }

    // Open SSE stream
    async function connectSSE() {
      if (_disposed || !isAuthed) {
        setStatus('recent');
        return;
      }
      const attempt = ++_connectionAttempt;
      if (_sseClose) _sseClose();
      clearTimeout(_reconnectTimer);
      setStatus('connecting');

      try {
        const { ticket } = await createFeedStreamTicket();
        if (_disposed || attempt !== _connectionAttempt) return;
        _sseClose = openFeedStream(
          ticket,
          post => {
            appendMessage(post, true);
            setStatus('live');
          },
          () => {
            if (_disposed || attempt !== _connectionAttempt) return;
            _sseClose?.();
            _sseClose = null;
            setStatus('error');
            _reconnectTimer = setTimeout(connectSSE, 5000);
          }
        );
        setTimeout(() => {
          if (!_disposed && attempt === _connectionAttempt && dotEl?.classList.contains('feed-dot--connecting')) setStatus('live');
        }, 900);
      } catch {
        if (_disposed || attempt !== _connectionAttempt) return;
        setStatus('error');
        _reconnectTimer = setTimeout(connectSSE, 5000);
      }
    }

    // Send a post
    async function sendPost() {
      const body = inputEl?.value.trim();
      if (!body || body.length === 0) return;

      sendBtn.disabled  = true;
      inputEl.disabled  = true;

      try {
        const created = await submitPost({ body, platform: platformEl?.value || undefined });
        appendMessage({ ...created, isOwn: true }, true);
        inputEl.value = '';
        if (countEl) countEl.textContent = '0/280';
      } catch (err) {
        showToast(err.message || 'Failed to post', 'error');
      } finally {
        sendBtn.disabled  = false;
        inputEl.disabled  = false;
        inputEl.focus();
      }
    }

    sendBtn?.addEventListener('click', sendPost);
    inputEl?.addEventListener('input', () => {
      if (countEl) countEl.textContent = `${inputEl.value.length}/280`;
    });
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPost(); }
    });

    _liveFeedCleanup = () => {
      _disposed = true;
      _connectionAttempt += 1;
      clearTimeout(_reconnectTimer);
      _sseClose?.();
    };

    loadHistory().then(connectSSE);
  })();

  // Bug report form (Pro only)
  const bugForm = document.getElementById('bug-form');
  if (bugForm) {
    const bugError  = document.getElementById('bug-error');
    const bugSubmit = document.getElementById('bug-submit');

    bugForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      bugError.classList.add('hidden');
      bugSubmit.disabled = true;
      bugSubmit.textContent = 'Submitting…';

      try {
        const updateId    = document.getElementById('bug-update').value.trim();
        const severity    = document.getElementById('bug-severity').value;
        const description = document.getElementById('bug-desc').value.trim();
        await submitBugReport({ updateId, severity, description });
        showToast('Bug report submitted!', 'success');
        bugForm.reset();
      } catch (err) {
        bugError.textContent = err.message;
        bugError.classList.remove('hidden');
      } finally {
        bugSubmit.disabled = false;
        bugSubmit.textContent = 'Submit report';
      }
    });
  }
}

// ── TICKER / sidebar ──────────────────────────────────────────────────────────
// (Pro feature — omitted from free tier; shown as locked in dashboard)

// ── BOOT ──────────────────────────────────────────────────────────────────────
// ── UPDATE DETAIL PAGE ────────────────────────────────────────────────────────
async function renderUpdateDetail(id) {
  const user = getUser(); // null for guests — page is public

  setHTML(`
    ${renderNav(user)}
    <div class="detail-page">
      <div class="detail-loading">${spinner()}</div>
    </div>
  `);
  attachNavHandlers(user);

  let u;
  try {
    u = await fetchUpdateById(id);
  } catch (err) {
    const expired = err.status === 404;
    setHTML(`
      ${renderNav(user)}
      <div class="detail-page">
        <div class="detail-error">
          <div class="detail-error-code">${expired ? 'Archived' : 'Error'}</div>
          <p>${expired ? 'This update is outside PatchTicker’s 240-day display window.' : H(err.message)}</p>
          <a class="btn btn--outline" href="#/updates">← Back to Full Ticker</a>
        </div>
      </div>
    `);
    attachNavHandlers(user);
    return;
  }

  if (!u) {
    setHTML(`
      ${renderNav(user)}
      <div class="detail-page">
        <div class="detail-error">
          <div class="detail-error-code">404</div>
          <p>Update not found.</p>
          <a class="btn btn--outline" href="#/updates">← Back to Full Ticker</a>
        </div>
      </div>
    `);
    attachNavHandlers(user);
    return;
  }

  u = {
    ...u,
    score: validScoreOrNull(u.score),
    impactScore: validScoreOrNull(u.impactScore),
  };

  captureAnalytics('update_opened', {
    update_id: u.id,
    platform: u.platform,
    status: u.status,
  });

  const pSuffix   = platformSuffix(u.platform);
  const updateScore = validScoreOrNull(u.score);
  const updateScoreDisplay = scoreDisplay(updateScore);
  const color     = scoreColor(updateScore);
  const packageSize = packageSizeMeta(u);

  const riskLevelIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

  // ── Impact Score bar ──────────────────────────────────────────────────────
  const impactScore  = u.impactScore ?? null;

  // ── Security Criticality ──────────────────────────────────────────────────
  const sec = u.securityCriticality || { level: 'none', label: 'No Data', cves: [] };
  const secColors = {
    critical: { bg: 'rgba(248,113,113,.08)', border: 'rgba(248,113,113,.35)', text: '#f87171', badge: '#7f1d1d' },
    high:     { bg: 'rgba(251,146,60,.08)',  border: 'rgba(251,146,60,.35)',  text: '#fb923c', badge: '#7c2d12' },
    medium:   { bg: 'rgba(251,191,36,.06)',  border: 'rgba(251,191,36,.25)',  text: '#fbbf24', badge: '#713f12' },
    low:      { bg: 'rgba(74,222,128,.05)',  border: 'rgba(74,222,128,.2)',   text: '#4ade80', badge: '#14532d' },
    none:     { bg: 'rgba(85,85,85,.08)',    border: 'rgba(85,85,85,.2)',     text: '#888',    badge: '#222' },
  };
  const secC = secColors[sec.level] || secColors.none;
  const secIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', none: '⚪' }[sec.level] || '⚪';
  const secCves = Array.isArray(sec.cves) ? sec.cves : [];
  const secCveTotal = Math.max(secCves.length, Number(sec.totalCves) || 0);
  const visibleCves = secCves.slice(0, 12);
  const remainingCves = Math.max(0, secCveTotal - visibleCves.length);
  const cveHTML = visibleCves.map(c =>
    `<span class="detail-cve-tag">${H(c)}</span>`
  ).join('');
  const detailSecuritySignal = securitySignalMeta(u);
  const detailDriverImpact = driverImpactMeta(u);

  // ── User Rating (live votes only; hidden until votes exist) ──────────────────
  const ur = u.userRating || null;
  const userVote = u.userVote || null;        // voter's current choice from server
  const ratingsLive = u.ratingsLive || false; // true = real DB votes

  function ratingHTML(r, currentVote) {
    if (!r) return '<p class="detail-empty-note">User rating appears after real votes are recorded.</p>';
    const communityScore = validScoreOrNull(r.score);
    if (communityScore === null) return '<p class="detail-empty-note">The current user rating failed validation and was not displayed.</p>';
    const urColor = scoreColor(communityScore);
    const install = r.breakdown?.install ?? 0;
    const wait = r.breakdown?.wait ?? 0;
    const avoid = r.breakdown?.avoid ?? 0;
    return `
      <div class="detail-rating-card detail-rating-card--compact">
        <div class="detail-rating-top">
          <div class="detail-rating-score" style="color:${urColor}">${H(communityScore.toFixed(1))}</div>
          <div>
            <div class="detail-rating-title">User Rating</div>
            <div class="detail-rating-count">${(r.totalVotes || 0).toLocaleString()} votes${ratingsLive ? ' <span class="rating-live-dot">●</span>' : ''}</div>
          </div>
        </div>
        <div class="detail-rating-chips">
          <span class="detail-rating-chip detail-rating-chip--install">Install ${install}%</span>
          <span class="detail-rating-chip detail-rating-chip--wait">Wait ${wait}%</span>
          <span class="detail-rating-chip detail-rating-chip--avoid">Avoid ${avoid}%</span>
        </div>
      </div>`;
  }

  const urBarInstall = ur ? ur.breakdown?.install ?? 0 : 0;
  const urBarWait    = ur ? ur.breakdown?.wait    ?? 0 : 0;
  const urBarAvoid   = ur ? ur.breakdown?.avoid   ?? 0 : 0;

  const riskHTML = (u.riskFactors || []).map(r => `
    <div class="detail-risk-item detail-risk--${H(r.level)}">
      <span class="detail-risk-icon">${riskLevelIcon[r.level] || '⚪'}</span>
      <div>
        <span class="detail-risk-level">${H(r.level.toUpperCase())}</span>
        <span class="detail-risk-text">${H(r.text)}</span>
      </div>
    </div>
  `).join('');

  const evidenceHTML = (u.evidence || []).map(e => `
    <a class="detail-evidence-item" href="${H(e.url)}" target="_blank" rel="noopener">
      <span class="detail-evidence-source">${H(e.source)}</span>
      <span class="detail-evidence-text">${H(e.text)}</span>
      <span class="detail-evidence-arrow">↗</span>
    </a>
  `).join('');
  const officialEvidence = (u.evidence || []).find(e =>
    e?.url && !/(?:reddit\.com|^r\/)/i.test(`${e.source || ''} ${e.url}`)
  );
  const officialSourceUrl = u.sourceUrl || officialEvidence?.url || null;
  const freshness = freshnessMeta(u);
  const detailSourceLabel = `${freshness.officialSources} official source${freshness.officialSources === 1 ? '' : 's'}`;
  const detailMethodLabel = analysisMethodLabel(u);
  const decisionFactsHTML = decisionPanelFacts(u, freshness).map(fact => `
    <div class="detail-decision-fact detail-decision-fact--${H(fact.tone)}">
      <strong>${H(fact.value)}</strong><span>${H(fact.label)}</span>
    </div>
  `).join('');

  const changelogHTML = (u.changelog || []).map(c => `
    <li class="detail-list-item detail-list-item--positive">
      <span class="detail-list-marker">+</span>${H(c)}
    </li>
  `).join('');

  const issuesHTML = (u.knownIssues || []).length
    ? (u.knownIssues).map(i => `
        <li class="detail-list-item detail-list-item--negative">
          <span class="detail-list-marker">!</span>${H(i)}
        </li>
      `).join('')
    : u.knownIssuesAuthoritative
      ? '<li class="detail-list-item detail-list-item--verified"><span class="detail-list-marker">✓</span>The vendor currently lists no known issues for this release.</li>'
      : '<li class="detail-list-item detail-list-item--none"><span class="detail-list-marker">?</span>No authoritative known-issue list was available in the checked release notes.</li>';

  const feedHTML = (u.feed || []).slice(0, 5).map(p => `
    <a class="detail-feed-item" href="${H(p.url)}" target="_blank" rel="noopener">
      <div class="detail-feed-meta">
        <span class="detail-feed-source">${H(p.source)}</span>
        <span class="detail-feed-score">▲ ${H(String(p.score))}</span>
      </div>
      <div class="detail-feed-title">${H(p.title)}</div>
    </a>
  `).join('') || '<p class="detail-feed-empty">No community posts loaded.</p>';

  setHTML(`
    ${renderNav(user)}
    <div class="detail-page">

      <!-- Breadcrumb -->
      <div class="detail-breadcrumb">
        <a href="#/updates" class="detail-back">← Back to Full Ticker</a>
        <span class="detail-breadcrumb-sep">/</span>
        <span class="text-platform--${pSuffix}">${H(platformLabel(u.platform))}</span>
        <span class="detail-breadcrumb-sep">/</span>
        <span>${H(u.name)}</span>
      </div>

      <!-- Hero -->
      <div class="detail-hero detail-hero--brief">
        <div class="detail-hero-left">
          ${renderPlatformLogo(u.platform, 'update-platform-icon detail-platform-icon')}
          <div>
            <p class="detail-kicker">${H(platformLabel(u.platform))} update brief</p>
            <h1 class="detail-title">${H(u.name)}</h1>
            <div class="detail-meta-grid" aria-label="Update metadata">
              <div><span>Platform</span><strong>${H(platformLabel(u.platform))}</strong></div>
              <div><span>Version</span><strong>${H(u.version || 'Current release')}</strong></div>
              <div><span>${H(updateDateLabel(u))}</span><strong>${H(formatReleaseDate(u.releasedAt))}</strong></div>
              <div class="${packageSize.available ? '' : 'is-unavailable'}"><span>Package size</span><strong>${H(packageSize.value)}</strong></div>
              <div><span>Applies to</span><strong>${H(u.affects || platformLabel(u.platform))}</strong></div>
            </div>
            <div class="detail-source-health" aria-label="Source health">
              <span class="freshness-signal freshness-signal--${H(freshness.tone)}"><i aria-hidden="true"></i>${H(freshness.label)}</span>
              ${detailSecuritySignal ? `<span class="security-signal security-signal--${H(detailSecuritySignal.tone)}"><i aria-hidden="true">◆</i>${H(detailSecuritySignal.label)}</span>` : ''}
              ${detailDriverImpact ? `<span class="driver-impact-signal platform--${H(pSuffix)}"><i aria-hidden="true">◈</i>${H(detailDriverImpact.label)}</span>` : ''}
              <strong>${H(freshness.detail)}</strong>
              <span>${H(detailSourceLabel)}</span>
              <span>${H(detailMethodLabel)}</span>
            </div>
          </div>
        </div>

        <aside class="detail-decision-panel detail-decision-panel--${H(u.status)}" aria-label="PatchTicker decision summary">
          <div class="status-badge ${H(u.status)} detail-status-badge">${H(u.status.toUpperCase())}</div>
          <div class="detail-decision-score">
            <span style="color:${color}">${H(updateScoreDisplay)}</span>
            <em>${updateScore === null ? 'Patch notes available · rating rejected or unavailable' : 'PatchTicker score · out of 10'}</em>
          </div>
          <div class="detail-decision-facts">
            ${decisionFactsHTML}
          </div>
          <details class="detail-score-method">
            <summary>What shaped this score</summary>
            <p>PatchTicker weighs documented release channels, vendor-known issues, structured risk severity, source availability, and release-note completeness. Community votes and generated summaries never alter this score.</p>
          </details>
          ${officialSourceUrl
            ? `<a class="detail-source-primary" href="${H(officialSourceUrl)}" target="_blank" rel="noopener">Open official source ↗</a>`
            : '<span class="detail-source-primary detail-source-primary--disabled" aria-disabled="true">Official source unavailable</span>'}
        </aside>
      </div>

      <!-- Verdict banner -->
      <div class="detail-verdict detail-verdict--${H(u.status)}">
        <span class="detail-verdict-label">PATCHTICKER READ</span>
        <p class="detail-verdict-text">${H(u.verdict || 'No takeaway available for this update yet.')}</p>
      </div>

      <div class="detail-action-row" aria-label="Update actions">
        <button class="detail-action-btn detail-action-btn--primary" id="mark-installed-btn" type="button" data-update-id="${H(u.id)}">Mark as Installed</button>
        <button class="detail-action-btn" id="share-update-btn" type="button">Share Update</button>
        <button class="detail-action-btn detail-action-btn--danger" id="report-issue-btn" type="button">Report Issue</button>
      </div>

      <!-- Main content grid -->
      <div class="detail-grid">

        <!-- Left col: Reasoning + Changelog + Issues -->
        <div class="detail-col-main">

          <section class="detail-section">
            <h2 class="detail-section-title">Update brief</h2>
            <p class="detail-reasoning">${H(u.reasoning || 'Our notes for this update are not published yet. Check back after the community monitoring window, typically 72 hours after release.')}</p>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">What changed</h2>
            <ul class="detail-list">${changelogHTML || '<li class="detail-list-item detail-list-item--none"><span class="detail-list-marker">—</span>No changelog available</li>'}</ul>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Known issues</h2>
            <ul class="detail-list">${issuesHTML}</ul>
          </section>

          <section class="detail-section detail-section--requirements">
            <h2 class="detail-section-title">Systems affected & performance impact</h2>
            <div class="detail-requirement-grid">
              <div><span>Applies to</span><strong>${H(u.affects || platformLabel(u.platform))}</strong></div>
              <div><span>Version</span><strong>${H(u.version || 'Current release')}</strong></div>
              <div><span>Impact index</span><strong>${impactScore !== null ? H(String(impactScore)) : 'Pending'}</strong></div>
              <div><span>Recommendation</span><strong>${H(decisionForUpdate(u).action)}</strong></div>
            </div>
          </section>

        </div>

        <!-- Right col: Security Criticality + User Rating + Risk factors + Evidence + Community feed -->
        <div class="detail-col-side">

          <!-- Security Criticality -->
          <section class="detail-section">
            <h2 class="detail-section-title">Security notes</h2>
            <div class="detail-security-card" style="background:${secC.bg};border-color:${secC.border}">
              <div class="detail-security-header">
                <span class="detail-security-icon">${secIcon}</span>
                <span class="detail-security-level" style="color:${secC.text}">${H(sec.level.toUpperCase())}</span>
                <span class="detail-security-label">${H(sec.label)}</span>
              </div>
              ${cveHTML ? `<div class="detail-cve-list">${cveHTML}${remainingCves ? `<span class="detail-cve-more">+${H(String(remainingCves))} more in the official advisory</span>` : ''}</div>` : ''}
            </div>
          </section>

          ${ur?.totalVotes ? `
          <section class="detail-section">
            <h2 class="detail-section-title">User Rating
              ${ratingsLive ? '<span class="section-title-badge section-title-badge--live">LIVE</span>' : ''}
            </h2>
            <div id="rating-display">${ratingHTML(ur, userVote)}</div>
            ${isLoggedIn() ? `
            <div class="detail-vote-bar" id="vote-bar">
              <span class="detail-vote-label">Your vote:</span>
              <button class="vote-btn vote-btn--install ${userVote === 'install' ? 'active' : ''}" data-vote="install">✓ Install</button>
              <button class="vote-btn vote-btn--wait   ${userVote === 'wait'    ? 'active' : ''}" data-vote="wait">⏳ Wait</button>
              <button class="vote-btn vote-btn--avoid  ${userVote === 'avoid'   ? 'active' : ''}" data-vote="avoid">✗ Avoid</button>
              ${userVote ? `<button class="vote-btn vote-btn--retract" data-retract>Clear</button>` : ''}
            </div>` : `<p class="detail-vote-cta"><a href="#/login">Sign in</a> to cast your vote</p>`}
          </section>` : ''}

          <section class="detail-section">
            <h2 class="detail-section-title">Watch for</h2>
            <div class="detail-risk-list">
              ${riskHTML || '<p class="detail-empty-note">No specific risk factors recorded.</p>'}
            </div>
          </section>

          <section class="detail-section">
            <h2 class="detail-section-title">Sources</h2>
            <div class="detail-evidence-list">
              ${evidenceHTML || '<p class="detail-empty-note">No evidence sources recorded yet.</p>'}
            </div>
          </section>
          <section class="detail-section">
            <h2 class="detail-section-title">Community Bug Reports
              <span class="section-title-badge section-title-badge--live">LIVE</span>
            </h2>
            <div id="detail-bug-feed">
              <div class="detail-loading-inline">${spinner()}</div>
            </div>
          </section>

        </div>
      </div>

    </div>
  `);
  attachNavHandlers(user);
  document.querySelector('.detail-source-primary[href]')?.addEventListener('click', () => {
    captureAnalytics('official_source_clicked', {
      update_id: u.id,
      platform: u.platform,
      source_type: 'official',
    });
  });

  const installedKey = `patchticker.installed.${u.id}`;
  const installedBtn = document.getElementById('mark-installed-btn');
  if (installedBtn && localStorage.getItem(installedKey) === 'true') {
    installedBtn.classList.add('is-done');
    installedBtn.textContent = 'Installed ✓';
  }
  installedBtn?.addEventListener('click', () => {
    const next = localStorage.getItem(installedKey) !== 'true';
    if (next) localStorage.setItem(installedKey, 'true');
    else localStorage.removeItem(installedKey);
    installedBtn.classList.toggle('is-done', next);
    installedBtn.textContent = next ? 'Installed ✓' : 'Mark as Installed';
    showToast(next ? 'Marked installed on this device.' : 'Install mark removed.', 'success');
  });

  document.getElementById('share-update-btn')?.addEventListener('click', async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}#/updates/${encodeURIComponent(u.id)}`;
    const shareData = { title: `${u.name} — PatchTicker`, text: u.verdict || `PatchTicker notes for ${u.name}`, url: shareUrl };
    try {
      if (navigator.share) await navigator.share(shareData);
      else {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Update link copied.', 'success');
      }
    } catch (err) {
      if (err?.name !== 'AbortError') showToast('Share failed. Copy the URL from the address bar.', 'error');
    }
  });

  document.getElementById('report-issue-btn')?.addEventListener('click', () => {
    const target = document.getElementById('detail-bug-feed');
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(isLoggedIn() ? 'Use the bug report tools from your account dashboard.' : 'Sign in with Pro to submit issue reports.', 'info');
  });

  // ── Load live bug reports ─────────────────────────────────────────────────
  const bugFeedEl = document.getElementById('detail-bug-feed');
  if (bugFeedEl) {
    try {
      const { fetchBugReports } = await import('./api.js');
      const bugRes  = await fetchBugReports(u.id);
      const reports = bugRes.data || [];
      renderBugFeed(bugFeedEl, reports, u.id);
    } catch (err) {
      bugFeedEl.innerHTML = '<p class="detail-empty-note">Bug reports unavailable.</p>';
    }
  }

  // ── Live vote handlers ────────────────────────────────────────────────────
  const voteBar = document.getElementById('vote-bar');
  if (voteBar) {
    voteBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-vote],[data-retract]');
      if (!btn) return;

      const isRetract = btn.hasAttribute('data-retract');
      const vote      = btn.dataset.vote;

      // Optimistic: disable bar
      voteBar.querySelectorAll('button').forEach(b => b.disabled = true);

      try {
        const { castVote: apiCastVote, retractVote: apiRetractVote } = await import('./api.js');
        const result = isRetract
          ? await apiRetractVote(u.id)
          : await apiCastVote(u.id, vote);
        captureAnalytics('update_feedback_submitted', {
          update_id: u.id,
          platform: u.platform,
          vote: isRetract ? 'retracted' : vote,
        });

        // Update display with fresh aggregated data
        const displayEl = document.getElementById('rating-display');
        if (displayEl && result?.data) {
          displayEl.innerHTML = ratingHTML(result.data, isRetract ? null : vote);
        }

        // Rebuild vote bar to reflect new state
        const newVote = isRetract ? null : vote;
        voteBar.innerHTML = `
          <span class="detail-vote-label">Your vote:</span>
          <button class="vote-btn vote-btn--install ${newVote === 'install' ? 'active' : ''}" data-vote="install">✓ Install</button>
          <button class="vote-btn vote-btn--wait   ${newVote === 'wait'    ? 'active' : ''}" data-vote="wait">⏳ Wait</button>
          <button class="vote-btn vote-btn--avoid  ${newVote === 'avoid'   ? 'active' : ''}" data-vote="avoid">✗ Avoid</button>
          ${newVote ? `<button class="vote-btn vote-btn--retract" data-retract>Clear</button>` : ''}
        `;
      } catch (err) {
        showToast(err.message || 'Vote failed. Please try again.', 'error');
        voteBar.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    });
  }
}


// ── ACCOUNT SETTINGS ─────────────────────────────────────────────────────────
async function renderAccount() {
  if (!isLoggedIn()) { navigate('/login'); return; }
  const user = getUser();

  setHTML(`
    ${renderNav(user)}
    <div class="account-page">
      <div class="account-header">
        <h1 class="account-title">Account Settings</h1>
        <p class="account-subtitle">${H(user.email)}</p>
      </div>
      <div class="account-grid">

        <!-- LEFT: Profile + Password -->
        <div class="account-col">

          <section class="account-section">
            <h2 class="account-section-title">Profile</h2>
            <div class="account-info-row"><span class="account-info-label">Email</span><span class="account-info-value">${H(user.email)}</span></div>
            <div class="account-info-row"><span class="account-info-label">Plan</span><span class="account-info-value"><span class="nav-role nav-role--${user.role}">${user.role.toUpperCase()}</span></span></div>
            <div class="account-info-row" id="sub-info-row"><span class="account-info-label">Subscription</span><span class="account-info-value" id="sub-info">${spinner()}</span></div>
            ${user.role === 'pro' || user.role === 'admin' ? `
            <button class="btn btn--outline btn--sm account-portal-btn" id="billing-portal-btn">Manage billing →</button>` : `
            <a class="btn btn--primary btn--sm" href="#/pricing">Upgrade to Pro</a>`}
          </section>

          <section class="account-section">
            <h2 class="account-section-title">Change Password</h2>
            <div id="pw-success" class="account-alert account-alert--success hidden">Password updated.</div>
            <div id="pw-error"   class="account-alert account-alert--error   hidden"></div>
            <div class="account-field">
              <label class="account-label">Current password</label>
              <input class="field-input" id="pw-current" type="password" autocomplete="current-password" />
            </div>
            <div class="account-field">
              <label class="account-label">New password</label>
              <input class="field-input" id="pw-new" type="password" autocomplete="new-password" />
            </div>
            <div class="account-field">
              <label class="account-label">Confirm new password</label>
              <input class="field-input" id="pw-confirm" type="password" autocomplete="new-password" />
            </div>
            <button class="btn btn--primary btn--sm" id="pw-save">Update password</button>
          </section>

        </div>

        <!-- RIGHT: Watchlist + Webhooks (Pro) -->
        <div class="account-col">

          <section class="account-section">
            <h2 class="account-section-title">
              Platform Watchlist
              ${user.role !== 'pro' && user.role !== 'admin' ? '<span class="account-pro-badge">PRO</span>' : ''}
            </h2>
            <p class="account-section-desc">Get emailed when a new update drops for platforms you watch.</p>
            ${user.role === 'pro' || user.role === 'admin' ? `
            <div id="watchlist-grid" class="watchlist-grid">${spinner()}</div>
            ` : `<div class="account-upsell">
              <p>Upgrade to Pro to subscribe to platform alerts.</p>
              <a class="btn btn--primary btn--sm" href="#/pricing">Upgrade →</a>
            </div>`}
          </section>

          ${user.role === 'pro' || user.role === 'admin' ? `
          <section class="account-section">
            <h2 class="account-section-title">Webhook / Slack Integration <span class="account-pro-badge">PRO</span></h2>
            <p class="account-section-desc">Receive update alerts directly in Slack or your own endpoint.</p>
            <div id="webhook-error" class="account-alert account-alert--error hidden"></div>
            <div id="webhook-success" class="account-alert account-alert--success hidden">Settings saved.</div>
            <div class="account-field">
              <label class="account-label">Slack Incoming Webhook URL</label>
              <input class="field-input" id="wh-slack" type="url" placeholder="https://hooks.slack.com/services/…" />
            </div>
            <div class="account-field">
              <label class="account-label">Custom Webhook URL (generic JSON)</label>
              <input class="field-input" id="wh-custom" type="url" placeholder="https://your-endpoint.example.com/hooks" />
            </div>
            <div class="account-field account-field--inline">
              <input type="checkbox" id="wh-enabled" checked />
              <label class="account-label" for="wh-enabled">Webhooks enabled</label>
            </div>
            <button class="btn btn--primary btn--sm" id="wh-save">Save webhook settings</button>
          </section>
          ` : ''}

        </div>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Load subscription info ────────────────────────────────────────────────
  try {
    const { fetchAccountMe } = await import('./api.js');
    const me = await fetchAccountMe();
    const sub = me.data?.subscription;
    const subEl = document.getElementById('sub-info');
    if (subEl) {
      subEl.textContent = sub
        ? `${sub.status.toUpperCase()} · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
        : 'No active subscription';
    }
  } catch { /* DB may not be available */ }

  // ── Password change ───────────────────────────────────────────────────────
  document.getElementById('pw-save')?.addEventListener('click', async () => {
    const btn       = document.getElementById('pw-save');
    const errEl     = document.getElementById('pw-error');
    const okEl      = document.getElementById('pw-success');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');

    const currentPassword = document.getElementById('pw-current').value;
    const newPassword     = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;

    if (!currentPassword || !newPassword) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
    if (newPassword !== confirmPassword) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { changePassword } = await import('./api.js');
      await changePassword({ currentPassword, newPassword, confirmPassword });
      okEl.classList.remove('hidden');
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = 'Update password'; }
  });

  // ── Billing portal ────────────────────────────────────────────────────────
  document.getElementById('billing-portal-btn')?.addEventListener('click', async () => {
    try {
      const { openBillingPortal } = await import('./api.js');
      const { url } = await openBillingPortal();
      window.location.href = url;
    } catch (err) { showToast(err.message, 'error'); }
  });

  if (user.role !== 'pro' && user.role !== 'admin') return;

  // ── Load watchlist ────────────────────────────────────────────────────────
  const ALL_PLATFORMS = TRACKED_PLATFORMS;
  let watchlist = [];
  try {
    const { fetchWatchlist } = await import('./api.js');
    const res = await fetchWatchlist();
    watchlist = res.data || [];
  } catch { /* unavailable */ }

  const watchlistGrid = document.getElementById('watchlist-grid');
  if (watchlistGrid) {
    const watchedSet = new Set(watchlist.map(w => w.platform));
    watchlistGrid.innerHTML = ALL_PLATFORMS.map(p => `
      <div class="watchlist-item ${watchedSet.has(p) ? 'watchlist-item--active' : ''}" data-platform="${H(p)}">
        <span class="watchlist-platform">${H(platformLabel(p))}</span>
        <span class="watchlist-status">${watchedSet.has(p) ? '● Watching' : '○ Off'}</span>
      </div>
    `).join('');

    watchlistGrid.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-platform]');
      if (!item) return;
      const platform = item.dataset.platform;
      const isActive = item.classList.contains('watchlist-item--active');
      item.style.opacity = '0.5';
      try {
        const { upsertWatch, removeWatch } = await import('./api.js');
        if (isActive) {
          await removeWatch(platform);
          item.classList.remove('watchlist-item--active');
          item.querySelector('.watchlist-status').textContent = '○ Off';
        } else {
          await upsertWatch(platform, { notifyEmail: true });
          item.classList.add('watchlist-item--active');
          item.querySelector('.watchlist-status').textContent = '● Watching';
        }
        captureAnalytics(isActive ? 'watchlist_item_removed' : 'watchlist_item_added', {
          watchlist_type: 'platform',
          item_count: watchlistGrid.querySelectorAll('.watchlist-item--active').length,
        });
      } catch (err) { showToast(err.message, 'error'); }
      finally { item.style.opacity = '1'; }
    });
  }

  // ── Load webhook settings ─────────────────────────────────────────────────
  try {
    const { fetchWebhookSettings } = await import('./api.js');
    const settings = await fetchWebhookSettings();
    if (settings?.data) {
      const d = settings.data;
      if (d.slack_url)   document.getElementById('wh-slack').value   = d.slack_url;
      if (d.webhook_url) document.getElementById('wh-custom').value  = d.webhook_url;
      if (d.enabled != null) document.getElementById('wh-enabled').checked = d.enabled;
    }
  } catch { /* unavailable */ }

  document.getElementById('wh-save')?.addEventListener('click', async () => {
    const btn  = document.getElementById('wh-save');
    const errEl = document.getElementById('webhook-error');
    const okEl  = document.getElementById('webhook-success');
    errEl.classList.add('hidden'); okEl.classList.add('hidden');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { upsertWebhookSettings } = await import('./api.js');
      await upsertWebhookSettings({
        slackUrl:   document.getElementById('wh-slack').value  || undefined,
        webhookUrl: document.getElementById('wh-custom').value || undefined,
        enabled:    document.getElementById('wh-enabled').checked,
      });
      captureAnalytics('notification_preference_changed', {
        enabled: document.getElementById('wh-enabled').checked,
      });
      okEl.classList.remove('hidden');
    } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    finally { btn.disabled = false; btn.textContent = 'Save webhook settings'; }
  });
}


// ── ADMIN DASHBOARD ───────────────────────────────────────────────────────────
async function renderAdmin() {
  if (!isLoggedIn()) { navigate('/login'); return; }
  const user = getUser();
  if (user.role !== 'admin') { navigate('/'); return; }

  setHTML(`
    ${renderNav(user)}
    <div class="admin-page">
      <div class="admin-header">
        <h1 class="admin-title">Admin Dashboard</h1>
        <span class="admin-subtitle">PatchTicker Operations</span>
      </div>

      <!-- Stats strip -->
      <div class="admin-stats" id="admin-stats">
        ${[...Array(6)].map(() => `<div class="admin-stat-card">${spinner()}</div>`).join('')}
      </div>

      <!-- Tabs -->
      <div class="admin-tabs">
        <button class="admin-tab admin-tab--active" data-tab="users">Users</button>
        <button class="admin-tab" data-tab="subscriptions">Subscriptions</button>
        <button class="admin-tab" data-tab="ai-log">Review Log</button>
        <button class="admin-tab" data-tab="pipeline">Pipeline</button>
      </div>

      <!-- Tab panels -->
      <div id="admin-panel-users" class="admin-panel">
        <div class="admin-table-wrap" id="users-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-subscriptions" class="admin-panel hidden">
        <div class="admin-table-wrap" id="subs-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-ai-log" class="admin-panel hidden">
        <div class="admin-table-wrap" id="ailog-table-wrap">${spinner()}</div>
      </div>
      <div id="admin-panel-pipeline" class="admin-panel hidden">
        <div class="pipeline-controls">
          <div class="pipeline-actions">
            <button class="btn btn--primary btn--sm" id="pipeline-run-all">▶ Run full scan now</button>
            <select class="field-input pipeline-platform-select" id="pipeline-platform-select">
              <option value="">— or run single platform —</option>
              <option>AMD</option><option>NVIDIA</option><option>Intel</option>
              <option>Apple</option><option>macOS</option><option>Windows</option>
              <option>Steam</option><option>Discord</option><option>BattleNet</option><option>GOG</option>
              <option>Switch</option><option>Xbox</option><option>PS5</option>
            </select>
            <button class="btn btn--outline btn--sm" id="pipeline-run-one">Run selected</button>
          </div>
          <p class="pipeline-note">Scans run automatically every 6 hours. Security platforms (Windows, Apple, macOS) scan every hour.</p>
        </div>
        <div id="pipeline-status-wrap" class="admin-table-wrap">${spinner()}</div>
        <div class="pipeline-controls pipeline-controls--email">
          <div class="pipeline-actions">
            <input class="field-input pipeline-platform-select" id="email-test-recipient" type="email" placeholder="Test recipient email" value="${H(user.email || '')}" />
            <button class="btn btn--outline btn--sm" id="email-send-test">Send test email</button>
          </div>
          <p class="pipeline-note" id="email-status-note">Email transport: checking…</p>
        </div>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Tab switching ─────────────────────────────────────────────────────────
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('admin-tab--active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('admin-tab--active');
      document.getElementById(`admin-panel-${tab.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  // ── Load stats ────────────────────────────────────────────────────────────
  try {
    const { fetchAdminStats } = await import('./api.js');
    const { users, subscriptions } = (await fetchAdminStats()).data ?? { users: {}, subscriptions: {} };
    document.getElementById('admin-stats').innerHTML = `
      <div class="admin-stat-card"><div class="admin-stat-value">${users.total_users ?? '—'}</div><div class="admin-stat-label">Total users</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.pro_users ?? '—'}</div><div class="admin-stat-label">Pro</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.free_users ?? '—'}</div><div class="admin-stat-label">Free</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${users.new_today ?? '—'}</div><div class="admin-stat-label">New today</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${subscriptions.active ?? '—'}</div><div class="admin-stat-label">Active subs</div></div>
      <div class="admin-stat-card"><div class="admin-stat-value">${subscriptions.trialing ?? '—'}</div><div class="admin-stat-label">Trialing</div></div>
    `;
  } catch { document.getElementById('admin-stats').innerHTML = '<p class="admin-error">Stats unavailable.</p>'; }

  // ── Load users table ──────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const { fetchAdminUsers, patchUserRole } = await import('./api.js');
      const res   = await fetchAdminUsers(1);
      const users = res.users || [];

      const rows = users.map(u => `
        <tr>
          <td class="admin-td admin-td--email">${H(u.email || '—')}</td>
          <td class="admin-td">
            <select class="admin-role-select" data-user-id="${H(u.id)}" data-current-role="${H(u.role)}">
              <option value="free"  ${u.role === 'free'  ? 'selected' : ''}>free</option>
              <option value="pro"   ${u.role === 'pro'   ? 'selected' : ''}>pro</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
            </select>
          </td>
          <td class="admin-td">${u.emailVerified ? '✓' : '✗'}</td>
          <td class="admin-td admin-td--sub">${u.subscription?.status ?? '—'}</td>
          <td class="admin-td admin-td--date">${new Date(u.createdAt).toLocaleDateString()}</td>
        </tr>
      `).join('');

      document.getElementById('users-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Email</th>
            <th class="admin-th">Role</th>
            <th class="admin-th">Verified</th>
            <th class="admin-th">Subscription</th>
            <th class="admin-th">Joined</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="admin-td">No users found.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${res.pagination?.total ?? 0} total users</p>
      `;

      // Role change handlers
      document.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const userId = sel.dataset.userId;
          const role   = sel.value;
          sel.disabled = true;
          try {
            await patchUserRole(userId, role);
            showToast(`Role updated to ${role}`, 'success');
          } catch (err) {
            showToast(err.message, 'error');
            sel.value = sel.dataset.currentRole;
          } finally { sel.disabled = false; }
        });
      });
    } catch (err) { document.getElementById('users-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  // ── Load subscriptions table ──────────────────────────────────────────────
  async function loadSubscriptions() {
    try {
      const { fetchAdminSubscriptions } = await import('./api.js');
      const res  = await fetchAdminSubscriptions(1);
      const subs = res.subscriptions || [];

      const rows = subs.map(s => `
        <tr>
          <td class="admin-td admin-td--email">${H(s.email || '—')}</td>
          <td class="admin-td"><span class="status-badge ${H(s.status)}">${H(s.status)}</span></td>
          <td class="admin-td">${s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'}</td>
          <td class="admin-td">${s.cancel_at_period_end ? '⚠ Cancels' : '—'}</td>
          <td class="admin-td admin-td--date">${new Date(s.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('');

      document.getElementById('subs-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Email</th>
            <th class="admin-th">Status</th>
            <th class="admin-th">Renews</th>
            <th class="admin-th">Flag</th>
            <th class="admin-th">Created</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="admin-td">No subscriptions found.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${res.pagination?.total ?? 0} total subscriptions</p>
      `;
    } catch (err) { document.getElementById('subs-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  // ── Load review log table ──────────────────────────────────────────────────
  async function loadAiLog() {
    try {
      const { fetchAiLog } = await import('./api.js');
      const entries = (await fetchAiLog(100)).data || [];

      const rows = entries.map(e => `
        <tr>
          <td class="admin-td">${H(e.update_id)}</td>
          <td class="admin-td">${H(e.model)}</td>
          <td class="admin-td">${e.tokens_in ?? '—'}</td>
          <td class="admin-td">${e.tokens_out ?? '—'}</td>
          <td class="admin-td">${e.latency_ms ? `${e.latency_ms}ms` : '—'}</td>
          <td class="admin-td">${e.success ? '<span style="color:var(--green)">✓</span>' : `<span style="color:var(--red)" title="${H(e.error_msg || '')}">✗</span>`}</td>
          <td class="admin-td admin-td--date">${new Date(e.created_at).toLocaleString()}</td>
        </tr>
      `).join('');

      document.getElementById('ailog-table-wrap').innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Update ID</th>
            <th class="admin-th">Model</th>
            <th class="admin-th">Tokens In</th>
            <th class="admin-th">Tokens Out</th>
            <th class="admin-th">Latency</th>
            <th class="admin-th">OK</th>
            <th class="admin-th">Timestamp</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="admin-td">No review log entries.</td></tr>'}</tbody>
        </table>
        <p class="admin-count">${entries.length} entries shown</p>
      `;
    } catch (err) { document.getElementById('ailog-table-wrap').innerHTML = `<p class="admin-error">${H(err.message)}</p>`; }
  }

  loadUsers();
  loadSubscriptions();
  loadAiLog();

  // ── Pipeline tab ──────────────────────────────────────────────────────────
  async function loadPipelineStatus() {
    try {
      const { fetchPipelineStatus } = await import('./api.js');
      const res  = await fetchPipelineStatus();
      const rows = res.data || [];
      const wrap = document.getElementById('pipeline-status-wrap');
      if (!wrap) return;

      if (!rows.length) {
        wrap.innerHTML = '<p class="admin-error">No pipeline data yet — run a scan to populate.</p>';
        return;
      }

      wrap.innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th class="admin-th">Platform</th>
            <th class="admin-th">Latest Version</th>
            <th class="admin-th">Last Release</th>
            <th class="admin-th">Last Detected</th>
            <th class="admin-th">Total Versions</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="admin-td"><a href="#/platform/${H(r.platform)}" style="color:var(--text)">${H(r.platform)}</a></td>
              <td class="admin-td" style="font-family:var(--font-mono);font-size:11px">${H(r.latest_version || '—')}</td>
              <td class="admin-td admin-td--date">${r.last_release ? new Date(r.last_release).toLocaleDateString() : '—'}</td>
              <td class="admin-td admin-td--date">${r.last_detected ? new Date(r.last_detected).toLocaleString() : '—'}</td>
              <td class="admin-td">${r.total_versions}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      const wrap = document.getElementById('pipeline-status-wrap');
      if (wrap) wrap.innerHTML = `<p class="admin-error">${H(err.message)}</p>`;
    }
  }

  loadPipelineStatus();

  async function loadEmailStatus() {
    const note = document.getElementById('email-status-note');
    if (!note) return;
    try {
      const { fetchEmailStatus } = await import('./api.js');
      const res = await fetchEmailStatus();
      const data = res.data || {};
      note.textContent = `Email transport: ${data.provider || 'unknown'} · from ${data.from || 'not set'}${data.configured ? '' : ' · dev/test only'}`;
    } catch (err) {
      note.textContent = `Email transport unavailable: ${err.message}`;
    }
  }

  loadEmailStatus();

  document.getElementById('email-send-test')?.addEventListener('click', async () => {
    const btn = document.getElementById('email-send-test');
    const to = document.getElementById('email-test-recipient')?.value.trim();
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const { sendAdminTestEmail } = await import('./api.js');
      await sendAdminTestEmail(to);
      showToast(`Test email sent to ${to}.`, 'success');
      await loadEmailStatus();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Send test email'; }
  });

  document.getElementById('pipeline-run-all')?.addEventListener('click', async () => {
    const btn = document.getElementById('pipeline-run-all');
    btn.disabled = true; btn.textContent = '⏳ Running…';
    try {
      const { triggerPipeline } = await import('./api.js');
      const res = await triggerPipeline(null);
      const failures = res.errors || [];
      showToast(failures.length ? `Pipeline completed with ${failures.length} errors.` : 'Full pipeline completed.', failures.length ? 'error' : 'success');
      if (failures.length) console.warn('PatchTicker pipeline failures', failures);
      await loadPipelineStatus();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '▶ Run full scan now'; }
  });

  document.getElementById('pipeline-run-one')?.addEventListener('click', async () => {
    const platform = document.getElementById('pipeline-platform-select')?.value;
    if (!platform) { showToast('Select a platform first.', 'info'); return; }
    const btn = document.getElementById('pipeline-run-one');
    btn.disabled = true; btn.textContent = '⏳ Running…';
    try {
      const { triggerPipeline } = await import('./api.js');
      const res = await triggerPipeline(platform);
      const failures = res.errors || [];
      showToast(failures.length ? `${platform} pipeline failed.` : `${platform} pipeline completed.`, failures.length ? 'error' : 'success');
      if (failures.length) console.warn('PatchTicker pipeline failures', failures);
      await loadPipelineStatus();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Run selected'; }
  });
}


// ── PUBLIC PLATFORM PAGE ──────────────────────────────────────────────────────
async function renderPlatformPage(platformName) {
  const user = getUser();
  const name = decodeURIComponent(platformName);

  const PLATFORM_COLOR = {
    AMD: '#ef4444', NVIDIA: '#22c55e', Intel: '#0071c5', Apple: '#9ca3af',
    macOS: '#a78bfa', Windows: '#60a5fa', Steam: '#64748b',
    Xbox: '#107c10', PS5: '#3b82f6',
  };
  const color = PLATFORM_COLOR[name] || '#888';

  setHTML(`
    ${renderNav(user)}
    <div class="platform-page">
      <div class="platform-hero" style="border-left:4px solid ${color}">
        <div class="platform-hero-inner">
          <a class="platform-back" href="#/updates">← All platforms</a>
          <div class="platform-title-row">${renderPlatformLogo(name, 'platform-title-logo')}<h1 class="platform-title">${H(name)}</h1></div>
          <p class="platform-subtitle">Update history &amp; community reports</p>
        </div>
      </div>

      <div class="platform-body">
        <!-- Current update summary -->
        <div class="platform-current" id="platform-current">${spinner()}</div>

        <!-- Score history -->
        <section class="platform-section">
          <h2 class="platform-section-title">Version History</h2>
          <div id="platform-history">${spinner()}</div>
        </section>

        <!-- Community bug reports -->
        <section class="platform-section">
          <h2 class="platform-section-title">Community Bug Reports</h2>
          <div id="platform-bugs">${spinner()}</div>
        </section>
      </div>
    </div>
  `);
  attachNavHandlers(user);

  // ── Load current update ───────────────────────────────────────────────────
  const { fetchUpdates } = await import('./api.js');
  try {
    const res  = await fetchUpdates({ platform: name });
    const updates = annotateReleasePositions(res.data || []);
    const current = updates[0];
    const currentEl = document.getElementById('platform-current');

    if (!current) {
      currentEl.innerHTML = '<p class="platform-empty">No update data yet for this platform.</p>';
    } else {
      const currentScore = validScoreOrNull(current.score);
      const color  = scoreColor(currentScore);
      const status = current.status || 'caution';
      const statusColors = { stable: 'var(--green)', caution: 'var(--yellow)', avoid: 'var(--red)' };
      currentEl.innerHTML = `
        <div class="platform-current-card" style="border-color:${color}">
          <div class="platform-current-left">
            <div class="platform-current-version">${H(current.name)}</div>
            <div class="platform-current-meta">
              v${H(current.version)} · Released ${new Date(current.releasedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
            </div>
            <div class="platform-current-verdict">${H(current.verdict || 'Review pending.')}</div>
          </div>
          <div class="platform-current-right">
            <div class="platform-score-ring" style="--ring-color:${color}">
              <span class="platform-score-num" style="color:${color}">${H(scoreDisplay(currentScore))}</span>
              ${currentScore === null ? '' : '<span class="platform-score-label">/ 10</span>'}
            </div>
            <div class="platform-status-badge" style="color:${statusColors[status]||'#888'};border-color:${statusColors[status]||'#888'}">
              ${status.toUpperCase()}
            </div>
            <a class="btn btn--outline btn--sm" href="#/updates/${H(current.id)}">Full details →</a>
          </div>
        </div>
      `;
    }
  } catch (err) {
    document.getElementById('platform-current').innerHTML =
      `<p class="platform-empty">Could not load current update.</p>`;
  }

  // ── Load version history ──────────────────────────────────────────────────
  const { fetchPlatformHistory } = await import('./api.js');
  try {
    const histRes  = await fetchPlatformHistory(name, 20);
    const history  = histRes.data || [];
    const histEl   = document.getElementById('platform-history');

    if (!history.length) {
      histEl.innerHTML = '<p class="platform-empty">No version history yet — pipeline will populate this automatically.</p>';
    } else {
      histEl.innerHTML = `
        <div class="history-table-wrap">
          <table class="history-table">
            <thead><tr>
              <th class="history-th">Version</th>
              <th class="history-th">Released</th>
              <th class="history-th">Score</th>
              <th class="history-th">Status</th>
              <th class="history-th">Bugs</th>
              <th class="history-th"></th>
            </tr></thead>
            <tbody>
              ${history.map(h => {
                const historyScore = validScoreOrNull(h.score);
                const c = scoreColor(historyScore);
                const statusColors = { stable: 'var(--green)', caution: 'var(--yellow)', avoid: 'var(--red)' };
                return `<tr class="history-row">
                  <td class="history-td history-td--version">${H(h.version)}</td>
                  <td class="history-td history-td--date">${new Date(h.releasedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
                  <td class="history-td"><span style="color:${c};font-weight:700">${H(scoreDisplay(historyScore))}</span></td>
                  <td class="history-td"><span class="history-status" style="color:${statusColors[h.status]||'#888'}">${(h.status||'').toUpperCase()}</span></td>
                  <td class="history-td">${h.bugCount ?? '—'}</td>
                  <td class="history-td"><a class="history-link" href="#/updates/${H(h.id)}">View →</a></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  } catch (err) {
    document.getElementById('platform-history').innerHTML =
      '<p class="platform-empty">Version history unavailable.</p>';
  }

  // ── Load community bug reports for this platform ──────────────────────────
  // Pull the most recent update's ID to fetch its bug reports
  const { fetchUpdates: fu2, fetchBugReports } = await import('./api.js');
  try {
    const res2    = await fu2({ platform: name });
    const current2 = (res2.data || [])[0];
    const bugsEl  = document.getElementById('platform-bugs');

    if (!current2) {
      bugsEl.innerHTML = '<p class="platform-empty">No update loaded yet.</p>';
    } else {
      const bugRes  = await fetchBugReports(current2.id);
      const reports = bugRes.data || [];
      renderBugFeed(bugsEl, reports, current2.id);
    }
  } catch (err) {
    document.getElementById('platform-bugs').innerHTML =
      '<p class="platform-empty">Bug reports unavailable.</p>';
  }
}


// ── SHARED FOOTER ─────────────────────────────────────────────────────────────
function renderFooter() {
  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span class="site-footer-brand"><span class="brand-pulse">Patch</span>Ticker</span>
        <nav class="site-footer-nav">
          <a href="#/" class="site-footer-link">Home</a>
          <a href="#/updates" class="site-footer-link">Updates</a>
          <a href="#/pricing" class="site-footer-link">Pricing</a>
          <a href="#/about" class="site-footer-link">About</a>
          <a href="#/privacy" class="site-footer-link">Privacy Policy</a>
          <button class="site-footer-link site-footer-button" id="analytics-privacy-choices" type="button">Privacy choices</button>
          <a href="#/terms" class="site-footer-link">Terms of Service</a>
        </nav>
        <span class="site-footer-copy">© ${new Date().getFullYear()} Dorn Ventures LLC. All rights reserved.</span>
      </div>
    </footer>
  `;
}

function renderAbout() {
  const user = getUser();
  setHTML(`
    ${renderNav(user)}
    <main class="legal-page about-page">
      <div class="legal-header">
        <p class="dash-section-kicker">Know before you update</p>
        <h1 class="legal-title">A decision desk for the software you depend on.</h1>
        <p class="legal-effective">PatchTicker tracks official release notes, stability signals, security context, and verified user feedback across operating systems, drivers, consoles, and launchers.</p>
      </div>
      <div class="legal-body about-grid">
        <section><h2>What we track</h2><p>Vendor releases, version history, known issues, system impact, and community install decisions—organized by platform instead of scattered across support pages.</p></section>
        <section><h2>How to use it</h2><p>Search for your platform or version, read the current recommendation, then open the update brief for sources and detailed notes before installing.</p></section>
        <section><h2>Who operates it</h2><p>PatchTicker is operated by Dorn Ventures LLC. Guidance is informational and always links back to official sources where available.</p></section>
        <div class="detail-action-row">
          <a class="btn btn--primary" href="#/updates">Browse live updates</a>
          <a class="btn btn--outline" href="#/pricing">Compare plans</a>
        </div>
      </div>
    </main>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}

function renderNotFound(path) {
  const user = getUser();
  setHTML(`
    ${renderNav(user)}
    <main class="detail-page">
      <div class="detail-error">
        <div class="detail-error-code">404</div>
        <h1 class="detail-title">Page not found</h1>
        <p>That PatchTicker directory does not exist: <strong>${H(path)}</strong></p>
        <div class="detail-action-row">
          <a class="btn btn--primary" href="#/updates">Open update feed</a>
          <a class="btn btn--outline" href="#/">Return home</a>
        </div>
      </div>
    </main>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}


// ── PRIVACY POLICY ────────────────────────────────────────────────────────────
function renderPrivacy() {
  const user = getUser();
  const EFFECTIVE = 'August 12, 2026';

  setHTML(`
    ${renderNav(user)}
    <div class="legal-page">
      <div class="legal-header">
        <h1 class="legal-title">Privacy Policy</h1>
        <p class="legal-effective">Effective date: ${EFFECTIVE}</p>
      </div>
      <div class="legal-body">

        <p>PatchTicker ("we", "us", or "our") is operated by Dorn Ventures LLC. This Privacy Policy explains what information we collect, how we use it, and your rights regarding your data when you use patchticker.app (the "Service").</p>

        <h2>1. Information We Collect</h2>
        <p><strong>Account information.</strong> When you register, we collect your email address and a hashed version of your password. Your email is encrypted at rest using AES-256-GCM. We never store your password in plain text.</p>
        <p><strong>Usage data.</strong> We collect standard server logs including IP addresses, browser user-agent strings, pages visited, and timestamps. Logs are retained for 30 days and then deleted automatically.</p>
        <p><strong>Optional analytics data.</strong> If you select “Allow analytics,” PostHog receives a pseudonymous internal user ID for signed-in users plus normalized page categories and limited interaction events. Microsoft Clarity receives strictly masked page interaction data for heatmaps and session reconstruction. We do not send either service your name, email address, raw search text, watchlist contents, notification tokens, webhook URLs, or URLs containing account tokens.</p>
        <p><strong>Payment information.</strong> Payments are processed by Stripe. We never see or store your full card number. We receive a Stripe customer ID and subscription status only.</p>
        <p><strong>Submitted content.</strong> Bug reports and community feed posts you submit are stored encrypted at rest and associated with your account.</p>
        <p><strong>Cookies and local storage.</strong> We use an HTTP-only authentication cookie to keep you signed in and necessary local storage for preferences. PostHog and Microsoft Clarity are not loaded until you opt in to analytics. Your choice is saved in local storage and can be changed at any time using “Privacy choices” in the footer. Google AdSense (shown to free-tier users only) may use its own cookies or identifiers subject to Google’s consent requirements and privacy policy.</p>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To operate and provide the Service</li>
          <li>To process payments and manage your subscription</li>
          <li>To send transactional emails (verification, password reset, patch alerts you subscribed to)</li>
          <li>To detect and prevent fraud, abuse, and security incidents</li>
          <li>With your consent, to improve the Service through aggregated and pseudonymous product analytics, heatmaps, and strictly masked session replay</li>
        </ul>
        <p>We do not sell your personal data to third parties. We do not use your data for advertising targeting beyond what AdSense does autonomously for free-tier ad display.</p>

        <h2>3. Data Sharing</h2>
        <p>We share data only with the following service providers, strictly for operating the Service:</p>
        <ul>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>Supabase</strong> — database hosting</li>
          <li><strong>Brevo</strong> — transactional email delivery</li>
          <li><strong>PostHog</strong> — consented product and web analytics; PostHog session recording is disabled</li>
          <li><strong>Microsoft Clarity</strong> — consented heatmaps and strictly masked session replay; advertising storage is denied</li>
          <li><strong>Google AdSense</strong> — advertising (free-tier users only)</li>
          <li><strong>hCaptcha</strong> — bot protection at registration</li>
        </ul>

        <h2>4. Data Retention</h2>
        <p>We retain your account data for as long as your account is active. If you delete your account, your email, posts, and bug reports are deleted within 7 days. Server logs are purged after 30 days. PostHog analytics events are retained for up to 12 months under our current project plan. Microsoft Clarity session playback is retained for 30 days; click, heatmap, and favorited or labeled session data may be retained for up to 9 months. Stripe and Google retain records according to their own policies.</p>

        <h2>5. Analytics Choices and Recording Safeguards</h2>
        <p>Analytics is opt-in worldwide. Declining does not reduce core Service functionality. If you withdraw consent, we instruct the analytics services to stop collection, clear their available browser identifiers, and reload the page without their scripts. Clarity recordings use strict masking, and all form controls, search fields, account areas, email displays, webhook fields, notification fields, and free-text inputs are additionally marked for masking. Session replay is a reconstruction of page interactions, not a camera or microphone recording.</p>

        <h2>6. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. To exercise these rights, email us at <strong>privacy@patchticker.app</strong>. We will respond within 30 days.</p>
        <p>If you are in the European Economic Area, you have the right to lodge a complaint with your local data protection authority.</p>

        <h2>7. Security</h2>
        <p>We use industry-standard security practices: TLS in transit, AES-256-GCM encryption at rest for PII, argon2id password hashing, short-lived JWT access tokens, and rate limiting on all sensitive endpoints. No system is perfectly secure, and we cannot guarantee absolute security.</p>

        <h2>8. Children</h2>
        <p>The Service is not directed at children under 13. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, contact us and we will delete it promptly.</p>

        <h2>9. Changes to This Policy</h2>
        <p>We may update this policy from time to time. Material changes will be notified by email to registered users at least 14 days before taking effect. The effective date at the top of this page will always reflect the current version.</p>

        <h2>10. Contact</h2>
        <p>Questions or requests regarding this policy can be sent to <strong>privacy@patchticker.app</strong> or by mail to: Dorn Ventures LLC, United States.</p>

      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}


// ── TERMS OF SERVICE ──────────────────────────────────────────────────────────
function renderTerms() {
  const user = getUser();
  const EFFECTIVE = 'July 17, 2026';

  setHTML(`
    ${renderNav(user)}
    <div class="legal-page">
      <div class="legal-header">
        <h1 class="legal-title">Terms of Service</h1>
        <p class="legal-effective">Effective date: ${EFFECTIVE}</p>
      </div>
      <div class="legal-body">

        <p>These Terms of Service ("Terms") govern your access to and use of PatchTicker, operated by Dorn Ventures LLC ("Company", "we", "us"). By creating an account or using the Service, you agree to these Terms.</p>

        <h2>1. The Service</h2>
        <p>PatchTicker aggregates publicly available software update information, community reports, source links, and team-reviewed guidance to help users make informed decisions about installing software updates. <strong>All safety scores, verdicts, and recommendations are informational only and do not constitute professional advice.</strong> You are solely responsible for decisions made based on content provided by the Service.</p>

        <h2>2. Accounts</h2>
        <p>You must be at least 13 years old to create an account. You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. You must provide accurate information at registration and keep it current.</p>

        <h2>3. Subscriptions and Billing</h2>
        <p>Pro subscriptions are billed monthly or annually as selected at checkout. Subscriptions renew automatically unless cancelled before the renewal date. You may cancel at any time through your account settings; cancellation takes effect at the end of the current billing period with no prorated refund unless required by applicable law. Prices may change with 30 days' notice.</p>
        <p>Payments are processed by Stripe. By subscribing, you authorise Stripe to charge your payment method on our behalf.</p>

        <h2>4. Free Tier and Advertising</h2>
        <p>Free-tier users receive access to the full update feed supported by Google AdSense advertising. By using the free tier, you acknowledge that advertisements will be displayed. Pro subscribers receive an ad-free experience.</p>

        <h2>5. User-Submitted Content</h2>
        <p>You may submit bug reports and community feed posts ("Content"). By submitting Content, you grant us a non-exclusive, worldwide, royalty-free licence to store, display, and moderate that Content in connection with the Service. You represent that your Content is accurate to the best of your knowledge, does not violate any law, and does not infringe any third-party rights.</p>
        <p>We may remove Content at our discretion, including Content that is false, abusive, spam, or otherwise violates these Terms.</p>

        <h2>6. Prohibited Uses</h2>
        <p>You may not use the Service to: submit false or misleading bug reports; attempt to manipulate safety scores; scrape or harvest data through automated means beyond our public API; circumvent rate limits or security measures; or use the Service in any way that violates applicable law.</p>

        <h2>7. API Access</h2>
        <p>Pro subscribers may access the PatchTicker REST API subject to rate limits described in our documentation. API access is provided as-is and may be modified or discontinued. You may not resell or redistribute raw API data as a competing service.</p>

        <h2>8. Disclaimers</h2>
        <p>THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND. WE DO NOT WARRANT THAT SCORES OR VERDICTS ARE ACCURATE, COMPLETE, OR UP TO DATE. USE OF ANY SOFTWARE UPDATE IS AT YOUR OWN RISK. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL LIABILITY FOR DAMAGES ARISING FROM YOUR USE OF THE SERVICE OR RELIANCE ON ITS CONTENT.</p>

        <h2>9. Limitation of Liability</h2>
        <p>To the maximum extent permitted by applicable law, Dorn Ventures LLC's total liability to you for any claim arising from these Terms or your use of the Service shall not exceed the greater of (a) the amount you paid us in the 12 months before the claim arose, or (b) $50 USD.</p>

        <h2>10. Termination</h2>
        <p>We may suspend or terminate your account at any time for violation of these Terms, with or without notice. You may delete your account at any time through account settings. Upon termination, your right to use the Service ceases immediately.</p>

        <h2>11. Governing Law</h2>
        <p>These Terms are governed by the laws of the United States. Any disputes shall be resolved through binding arbitration under the American Arbitration Association rules, except that either party may seek injunctive relief in a court of competent jurisdiction.</p>

        <h2>12. Changes to Terms</h2>
        <p>We may modify these Terms at any time. Material changes will be notified by email at least 14 days in advance. Continued use of the Service after the effective date constitutes acceptance of the updated Terms.</p>

        <h2>13. Contact</h2>
        <p>Questions about these Terms can be sent to <strong>legal@patchticker.app</strong> or by mail to: Dorn Ventures LLC, United States.</p>

      </div>
    </div>
    ${renderFooter()}
  `);
  attachNavHandlers(user);
}


async function boot() {
  initializeAnalyticsConsent();
  renderLoading();

  // Try to restore session from refresh token cookie
  const restoredUser = await restoreSession();
  syncAnalyticsIdentity(restoredUser);

  // Auth event listeners
  onAuthChange((event, user) => {
    syncAnalyticsIdentity(user);
    if (event === 'expired') {
      showToast('Session expired. Please sign in again.', 'error');
      navigate('/login');
    }
  });

  // Register routes
  route('/', () => renderLanding());
  route('/updates', () => renderDashboard());
  route('/updates/:id', ({ id }) => renderUpdateDetail(id));
  route('/update/:id', ({ id }) => renderUpdateDetail(id)); // legacy permalink alias
  route('/login', () => isLoggedIn() ? navigate('/updates') : renderLogin());
  route('/register', () => isLoggedIn() ? navigate('/updates') : renderRegister());
  route('/pricing', () => renderPricing());
  route('/forgot-password', () => renderForgotPassword());
  route('/reset-password', (params) => renderResetPassword(params));
  route('/verify-email', (params) => renderVerifyEmail(params));

  route('/account',          () => renderAccount());
  route('/settings',         () => navigate('/account'));
  route('/games',            () => renderDashboard({ focusId: 'category-gaming' }));
  route('/categories',       () => renderDashboard({ focusId: 'section-latest' }));
  route('/admin',            () => renderAdmin());
  route('/platform/:name',   ({ name }) => renderPlatformPage(name));
  route('/about',            () => renderAbout());
  route('/privacy',          () => renderPrivacy());
  route('/terms',            () => renderTerms());
  fallback(({ path }) => renderNotFound(path));

  // Handle Stripe redirect params
  const hash = window.location.hash;
  if (hash.includes('checkout=success')) {
    showToast('Subscription activated! Welcome to Pro.', 'success');
    // User just upgraded — remove ads immediately without requiring a page reload.
    // The AdSense script and all <ins> units are removed from the DOM right now.
    unloadAds();
    // Remove the query param from hash
    window.history.replaceState(null, '', window.location.pathname + '#/');
  } else if (hash.includes('checkout=canceled')) {
    showToast('Checkout canceled.', 'info');
    window.history.replaceState(null, '', window.location.pathname + '#/pricing');
  }

  start();
}

boot();
