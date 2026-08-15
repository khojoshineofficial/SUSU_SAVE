/**
 * Theme switching and the liquid back-to-top control.
 *
 * Three states are supported: an explicit 'light' or 'dark' choice, stored in
 * localStorage and applied as [data-theme] on <html>, or no choice at all — in
 * which case nothing is set and the CSS follows prefers-color-scheme.
 */

const STORAGE_KEY = 'susu-theme';

const systemPrefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

export const storedTheme = () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null; // private browsing, storage disabled — fall back to the system
  }
};

/** What the user is actually looking at right now. */
export const activeTheme = () => storedTheme() || (systemPrefersDark() ? 'dark' : 'light');

function apply(theme) {
  const root = document.documentElement;
  if (theme) root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');

  // Keep the browser chrome (mobile address bar) in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', activeTheme() === 'dark' ? '#0d1017' : '#5b21e6');
}

/** Call as early as possible so the first paint is already the right colour. */
export function initTheme() {
  apply(storedTheme());

  // Follow the OS while the visitor has expressed no preference of their own.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!storedTheme()) apply(null);
  });
}

export function toggleTheme() {
  const next = activeTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* not persisted, but still applied for this page */ }
  apply(next);
  return next;
}

const SUN = '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.8v2.6M12 19.6v2.6M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M1.8 12h2.6M19.6 12h2.6M6.1 17.9l-1.9 1.9M19.8 4.2l-1.9 1.9"/>';
const MOON = '<path d="M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.6 6.6 0 0 0 9.8 9.8z"/>';

const svg = (paths, cls) => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/**
 * A sliding day/night switch.
 *
 * It is a real `role="switch"`, so screen readers announce its state and the
 * keyboard treats it like a checkbox. `aria-checked` doubles as the styling
 * hook, which keeps the visual state and the accessible state from ever
 * drifting apart.
 */
export function createThemeToggle() {
  const button = document.createElement('button');
  button.className = 'theme-switch';
  button.type = 'button';
  button.setAttribute('role', 'switch');

  button.innerHTML = `
    <span class="label"></span>
    <span class="track" aria-hidden="true">
      <span class="thumb">${svg(SUN, 'icon-sun')}${svg(MOON, 'icon-moon')}</span>
    </span>`;

  const label = button.querySelector('.label');

  const paint = () => {
    const dark = activeTheme() === 'dark';
    button.setAttribute('aria-checked', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = following() ? 'Following your device setting' : `${dark ? 'Dark' : 'Light'} mode`;
    label.textContent = dark ? 'Dark' : 'Light';
  };

  button.addEventListener('click', () => {
    toggleTheme();
    paint();
  });

  // Keep every mounted switch in step when the OS flips and no choice is stored.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', paint);

  paint();
  return button;
}

/** True while the visitor has expressed no preference of their own. */
const following = () => storedTheme() === null;

/** Appends the switch to a container, if that container exists on this page. */
export function mountThemeToggle(selector, { prepend = false, floating = false } = {}) {
  const host = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!host) return null;
  const button = createThemeToggle();
  if (floating) host.classList.add('theme-float');
  if (prepend) host.prepend(button);
  else host.appendChild(button);
  return button;
}

/* --------------------------- liquid back-to-top --------------------------- */

/**
 * A circular button that fills like a glass of water as the page scrolls, then
 * returns to the top when pressed. The fill tracks real scroll progress, so it
 * doubles as a reading-position indicator.
 */
export function mountBackToTop({ showAfter = 320, scroller = window } = {}) {
  if (document.querySelector('.back-to-top')) return null;

  const button = document.createElement('button');
  button.className = 'back-to-top';
  button.type = 'button';
  button.setAttribute('aria-label', 'Back to top');
  button.title = 'Back to top';
  button.innerHTML = `
    <span class="liquid" aria-hidden="true"></span>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>
    </svg>`;
  document.body.appendChild(button);

  const liquid = button.querySelector('.liquid');
  let ticking = false;

  const update = () => {
    ticking = false;
    const doc = document.documentElement;
    const scrolled = scroller === window ? window.scrollY : scroller.scrollTop;
    const height = (scroller === window ? doc.scrollHeight : scroller.scrollHeight)
      - (scroller === window ? window.innerHeight : scroller.clientHeight);

    const progress = height > 0 ? Math.min(100, Math.max(0, (scrolled / height) * 100)) : 0;
    liquid.style.setProperty('--fill', `${progress}%`);
    button.classList.toggle('visible', scrolled > showAfter);
  };

  const onScroll = () => {
    // rAF-throttled: the handler runs at most once per frame however fast the wheel spins.
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  button.addEventListener('click', () => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (scroller === window) window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    else scroller.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  });

  update();
  return button;
}

/** The footer credit, used on every surface of the product. */
export const CREDIT_HTML = `
  <div class="credit">
    Developed by <span class="dev">Kenneth Nartey</span> —
    <a href="tel:+233555563413">0555563413</a> / <a href="tel:+233203208934">0203208934</a>
  </div>`;

export function mountCredit(container) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host || host.querySelector('.credit')) return;
  host.insertAdjacentHTML('beforeend', CREDIT_HTML);
}
