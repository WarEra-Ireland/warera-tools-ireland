function sectionHelp(label, content) {
  return `<span class="section-help"><button type="button" class="section-help-trigger" aria-expanded="false" aria-label="${escapeHtml(label)}"><span aria-hidden="true">ⓘ</span></button><span class="section-help-content" role="tooltip" hidden>${content}</span></span>`;
}

function wireSectionHelp() {
  const view = document.body;
  let active = null;
  let pinned = false;
  let dismissed = null;
  let nextId = 0;
  let closeTimer;
  const close = () => {
    clearTimeout(closeTimer);
    if (!active) return;
    active.querySelector('.section-help-content').hidden = true;
    active.querySelector('button').setAttribute('aria-expanded', 'false');
    active = null;
    pinned = false;
  };
  const position = () => {
    if (!active) return;
    if (!active.isConnected || (active.closest('.view') && !active.closest('.view').classList.contains('active'))) { close(); return; }
    const tip = active.querySelector('.section-help-content');
    const button = active.querySelector('button');
    if (!button.getClientRects().length) { close(); return; }
    const rect = button.getBoundingClientRect();
    const gap = 8;
    tip.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - tip.offsetWidth - gap))}px`;
    const below = rect.bottom + gap;
    tip.style.top = `${Math.max(gap, below + tip.offsetHeight <= innerHeight - gap ? below : rect.top - tip.offsetHeight - gap)}px`;
  };
  const show = wrapper => {
    clearTimeout(closeTimer);
    if (active === wrapper) return;
    close();
    active = wrapper;
    const tip = active.querySelector('.section-help-content');
    const button = active.querySelector('button');
    if (!tip.id) tip.id = `section-help-${++nextId}`;
    button.setAttribute('aria-describedby', tip.id);
    button.setAttribute('aria-expanded', 'true');
    tip.hidden = false;
    position();
  };
  view.addEventListener('pointerover', ev => {
    const wrapper = ev.target.closest('.section-help');
    if (wrapper) clearTimeout(closeTimer);
    if (wrapper && wrapper !== dismissed && ev.pointerType === 'mouse' && !pinned) show(wrapper);
  });
  view.addEventListener('pointerout', ev => {
    if (dismissed && !dismissed.contains(ev.relatedTarget)) dismissed = null;
    if (active && !pinned && !active.contains(ev.relatedTarget) && !active.contains(document.activeElement)) closeTimer = setTimeout(close, 150);
  });
  view.addEventListener('focusin', ev => {
    const wrapper = ev.target.closest('.section-help');
    if (wrapper && wrapper !== dismissed) show(wrapper);
  });
  view.addEventListener('focusout', ev => {
    dismissed = null;
    if (active && !active.contains(ev.relatedTarget)) close();
  });
  document.addEventListener('click', ev => {
    const button = ev.target.closest('.section-help-trigger');
    if (button && view.contains(button)) {
      dismissed = null;
      if (active === button.parentElement && pinned) close();
      else { show(button.parentElement); pinned = true; }
    } else if (active && !active.contains(ev.target)) close();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { dismissed = active; close(); }
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  new MutationObserver(() => { if (active) position(); }).observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

wireSectionHelp();
