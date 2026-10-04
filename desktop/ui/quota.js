import { createQuotaView } from './quota-view.js';

// The widget fetches the quota book and announces each snapshot; this view
// draws it under the pet. A choice made here goes straight to the book.
const root = document.querySelector('.dshwv-root');
if (root) {
  const view = createQuotaView({ root, pet: root.querySelector('.dshwv-img'), presentation: window.WhaleQuotaPresentation, money: window.WhaleMoney,
    rendering: window.WhaleRendering, geometry: window.WhalePetGeometry,
    select: async id => {
      const response = await fetch('/api/quotas/current', { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(result.error || '切换未完成，请重试');
    },
    openManager: () => window.dispatchEvent(new Event('whale-open-settings')) });
  window.addEventListener('whale-quotas', event => view.update(event.detail));
  window.addEventListener('whale-pet-layout', () => view.place());
  window.dispatchEvent(new Event('whale-quotas-request'));
  if (window.whaleDesktop?.testMode) window.__whaleQuotaTest = Object.freeze({ open: view.open, close: view.close });
}
