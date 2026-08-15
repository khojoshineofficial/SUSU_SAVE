/** Page chrome: the liquid back-to-top control and the footer credit. */

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

/* ------------------------------ maintenance ------------------------------ */

/**
 * A banner shown on every page while the platform is in maintenance mode.
 *
 * The flag lives in the platform settings and is exposed by the public
 * settings endpoint, so signed-out visitors on the landing and login pages see
 * it too — not just people already inside the app. It re-checks periodically so
 * a session that was open when maintenance began finds out without a reload.
 */
export async function mountMaintenanceBanner({ pollMs = 60000 } = {}) {
  const paint = (settings) => {
    const existing = document.querySelector('.maintenance-bar');
    if (!settings?.maintenanceMode) {
      existing?.remove();
      document.body.classList.remove('has-maintenance-bar');
      return;
    }
    const message = settings.maintenanceMessage
      || 'SUSU SAVE is under maintenance. You can still sign in and look around, but transactions are paused.';

    if (existing) {
      existing.querySelector('.maintenance-text').textContent = message;
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'maintenance-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `
      <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span class="maintenance-text">${message}</span>`;
    document.body.prepend(bar);
    document.body.classList.add('has-maintenance-bar');
  };

  const check = async () => {
    try {
      const res = await fetch('/api/settings/public');
      const body = await res.json();
      paint(body.data);
    } catch { /* offline or mid-deploy: leave the banner as it is */ }
  };

  await check();
  if (pollMs > 0) setInterval(check, pollMs);
}
