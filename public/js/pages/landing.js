/** Page script for landing. Kept in its own file because the app's
 *  Content-Security-Policy allows scripts from 'self' only —
 *  an inline <script> is blocked by the browser and never runs. */

// Pricing and support details come from the live platform configuration.
  document.getElementById('year').textContent = new Date().getFullYear();
  const money = (minor) => `GH₵${(Number(minor || 0) / 100).toLocaleString('en-GH', { minimumFractionDigits: 2 })}`;

  fetch('/api/settings/public')
.then((res) => res.json())
.then(({ data }) => {
  if (!data) return;
  document.getElementById('reg-fee').textContent = data.registrationFeeMinor ? money(data.registrationFeeMinor) : 'Free';
  document.getElementById('savings-fee').textContent = `${data.savingsFeePercent}%`;
  document.getElementById('withdrawal-fee').textContent =
    `Withdrawal fee ${data.withdrawalFeePercent}% + ${money(data.withdrawalFlatFeeMinor)}`;
  document.getElementById('support-email').textContent = data.support?.email || '';
  document.getElementById('support-phone').textContent = data.support?.phone || '';
})
.catch(() => { /* the page is fully readable without live pricing */ });

  document.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener('click', (e) => {
const target = document.querySelector(link.getAttribute('href'));
if (!target) return;
e.preventDefault();
target.scrollIntoView({ behavior: 'smooth' });
  }));
