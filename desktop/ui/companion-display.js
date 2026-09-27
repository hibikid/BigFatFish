export function createCompanionDisplay({ pet, composer, reply, content }) {
  let opened = false, scheduled = false, destroyed = false, followTail = true, dismissed = false, lastMoveBottom = null, followUntil = 0;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function position() {
    scheduled = false;
    if (!opened || destroyed) return;
    const bounds = pet.getBoundingClientRect(), width = window.innerWidth, height = window.innerHeight;
    const bottomSpace = composer.offsetHeight + 12;
    if (bounds.bottom + bottomSpace > height - 8 && bounds.top > 8 && bounds.bottom !== lastMoveBottom) {
      lastMoveBottom = bounds.bottom;
      window.dispatchEvent(new CustomEvent('whale-companion-move', { detail: { y: -Math.min(bounds.top - 8, bounds.bottom + bottomSpace - height + 8) } }));
      schedule(); return;
    }
    const center = bounds.left + bounds.width / 2;
    composer.style.left = clamp(center - composer.offsetWidth / 2, 8, width - composer.offsetWidth - 8) + 'px';
    composer.style.top = clamp(bounds.bottom + 8, 8, height - composer.offsetHeight - 8) + 'px';
    reply.style.left = clamp(center - reply.offsetWidth / 2, 8, width - reply.offsetWidth - 8) + 'px';
    const available = bounds.top - 20;
    reply.style.maxHeight = Math.max(100, Math.min(420, available)) + 'px';
    const above = bounds.top - reply.offsetHeight - 12;
    if (above >= 8) reply.style.top = above + 'px';
    else {
      const leftFits = bounds.left - reply.offsetWidth - 12 >= 8;
      const rightFits = bounds.right + reply.offsetWidth + 20 <= width;
      const shift = reply.offsetHeight + 20 - bounds.top;
      if (!reply.hidden && !leftFits && !rightFits && shift > 0 && bounds.bottom + shift + bottomSpace <= height - 8) {
        window.dispatchEvent(new CustomEvent('whale-companion-move', { detail: { y: shift } }));
        schedule(); return;
      }
      const side = leftFits ? bounds.left - reply.offsetWidth - 12 : bounds.right + 12;
      reply.style.left = clamp(side, 8, width - reply.offsetWidth - 8) + 'px';
      reply.style.top = clamp(bounds.top, 8, height - reply.offsetHeight - 8) + 'px';
    }
    if (followTail) content.scrollTop = content.scrollHeight;
    window.WhaleRendering.presentFor(120);
  }
  function schedule() { if (!scheduled && !destroyed) { scheduled = true; requestAnimationFrame(position); } }
  function replace(text) {
    const scrollTop = content.scrollTop;
    content.textContent = text;
    if (!followTail) content.scrollTop = scrollTop;
    reply.hidden = !opened || dismissed || !text;
    schedule();
  }
  content.addEventListener('scroll', () => { followTail = content.scrollHeight - content.scrollTop - content.clientHeight < 24; });
  const resize = new ResizeObserver(schedule);
  resize.observe(composer); resize.observe(reply);
  const root = pet.closest('.dshwv-root');
  const observer = new MutationObserver(() => { followUntil = performance.now() + 350; schedule(); });
  observer.observe(root.parentElement, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  const stopFollowing = window.WhaleRendering.onFrame(() => { if (opened && performance.now() < followUntil) schedule(); });
  window.addEventListener('resize', schedule);
  const legacy = root.querySelector('.dshwv-pop');
  const priority = new MutationObserver(() => {
    reply.classList.toggle('companion-covered', legacy.classList.contains('dshwv-pop-open'));
    schedule();
  });
  priority.observe(legacy, { attributes: true, attributeFilter: ['class'] });
  return Object.freeze({
    open() { opened = true; composer.hidden = false; reply.hidden = dismissed || !content.textContent; schedule(); },
    close() { opened = false; composer.hidden = true; reply.hidden = true; },
    hideReply() { dismissed = true; reply.hidden = true; },
    show(text) {
      dismissed = false;
      followTail = true;
      replace(text);
      window.dispatchEvent(new Event('whale-companion-reply'));
    },
    update: replace,
    append(text) { content.append(document.createTextNode(text)); reply.hidden = !opened || dismissed; schedule(); },
    layout: schedule,
    destroy() { destroyed = true; resize.disconnect(); observer.disconnect(); priority.disconnect(); stopFollowing(); window.removeEventListener('resize', schedule); },
  });
}
