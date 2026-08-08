// The lesson slideshow. One level in, one slide at a time out: markdown pages
// and "demo" pages that hand a command straight to the terminal.

import { el, renderMarkdown, prefersReducedMotion } from '../core/util.js';
import { Modal, icon, iconHref } from './modal.js';
import { toast } from './toast.js';

const SWAP_MS = 150;

function copyButton(pre) {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'code-copy',
      'aria-label': 'Copy this code',
      onClick: async (event) => {
        event.stopPropagation();
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied to the clipboard.', 'success', 2200);
        } catch {
          // Clipboard is blocked (insecure context, denied permission): select
          // the text instead so the user can copy it by hand.
          const range = document.createRange();
          range.selectNodeContents(code || pre);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          toast('Press Ctrl+C to copy the selected code.', 'info', 3200);
        }
      },
    },
    icon('copy'),
    el('span', { class: 'code-copy-label' }, 'Copy')
  );
  return button;
}

export class LevelDialog {
  constructor(level, { onFinish = null, onCommand = null } = {}) {
    this.level = level || {};
    this.onFinish = onFinish;
    this.onCommand = onCommand;
    this.slides = Array.isArray(this.level.dialog) ? this.level.dialog.filter(Boolean) : [];
    this.index = 0;
    this._animating = false;
    this._demoBusy = false;

    this.contentEl = el('div', { class: 'lesson-content' });
    // Next and Back replace the whole slide without moving focus, so the swap
    // has to be spoken. Polite, because the reader asked for it.
    this.viewportEl = el(
      'div',
      { class: 'lesson-viewport', 'aria-live': 'polite', 'aria-atomic': 'true' },
      this.contentEl
    );

    this.stepEl = el('p', { class: 'lesson-step' });
    this.dotsEl = el('nav', { class: 'lesson-dots', 'aria-label': 'Lesson slides' });

    this.modal = new Modal({
      title: this.level.name || 'Lesson',
      body: this.viewportEl,
      size: 'lg',
      dismissible: true,
      className: 'modal-lesson',
      buttons: [
        {
          label: 'Back',
          variant: 'ghost',
          icon: 'prev',
          keepOpen: true,
          onClick: () => this.go(-1),
        },
        {
          // Back leads with its arrow, Next trails with its own: an arrow
          // belongs on the side it points at, not in front of the word.
          label: 'Next',
          variant: 'primary',
          iconEnd: 'next',
          key: 'Enter',
          keepOpen: true,
          onClick: () => this.go(1),
        },
      ],
    });

    this.backBtn = this.modal.buttonEls[0];
    this.nextBtn = this.modal.buttonEls[1];
    this.modal.headTextEl.appendChild(this.stepEl);
    this.modal.footExtraEl.appendChild(this.dotsEl);

    this.modal.panelEl.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      const tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.go(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        this.jump(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        this.jump(this.slides.length - 1);
      }
    });
  }

  /** @returns {Promise<void>} resolves once the dialog has closed. */
  async open() {
    if (!this.slides.length) {
      this.onFinish?.();
      return;
    }
    this.paint(0);
    this.buildDots();
    const result = await this.modal.open();

    if (result && result.type === 'command') {
      this.onCommand?.(result.command);
    } else if (result === 'finish') {
      this.onFinish?.();
    }
  }

  buildDots() {
    this.dotsEl.textContent = '';
    this.slides.forEach((_, i) => {
      const dot = el('button', {
        type: 'button',
        class: 'lesson-dot',
        'aria-label': `Go to slide ${i + 1} of ${this.slides.length}`,
        onClick: () => this.jump(i),
      });
      this.dotsEl.appendChild(dot);
    });
    this.syncDots();
  }

  syncDots() {
    Array.from(this.dotsEl.children).forEach((dot, i) => {
      const current = i === this.index;
      dot.classList.toggle('is-current', current);
      dot.classList.toggle('is-done', i < this.index);
      if (current) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
  }

  go(direction) {
    const target = this.index + direction;
    if (direction > 0 && this.index === this.slides.length - 1) {
      this.modal.close('finish');
      return;
    }
    this.jump(target);
  }

  jump(target) {
    if (this._animating) return;
    const next = Math.max(0, Math.min(this.slides.length - 1, target));
    if (next === this.index) return;
    const direction = next > this.index ? 1 : -1;
    this.index = next;

    if (prefersReducedMotion()) {
      this.paint(direction);
      return;
    }

    this._animating = true;
    const node = this.contentEl;
    node.classList.remove('slide-in-left', 'slide-in-right');
    node.classList.add(direction > 0 ? 'slide-out-left' : 'slide-out-right');
    setTimeout(() => {
      this.paint(direction);
      node.classList.remove('slide-out-left', 'slide-out-right');
      node.classList.add(direction > 0 ? 'slide-in-right' : 'slide-in-left');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          node.classList.remove('slide-in-right', 'slide-in-left');
          this._animating = false;
        });
      });
    }, SWAP_MS);
  }

  /**
   * A demo slide runs its command against the live board. Closing the panel
   * here would skip every slide that follows - including "your task" - so the
   * dialog only steps aside when the demo really is the last thing to read.
   */
  async runDemo(command) {
    if (this._demoBusy) return;
    if (this.index === this.slides.length - 1) {
      this.modal.close({ type: 'command', command });
      return;
    }
    this._demoBusy = true;
    // Advance first: the reader carries on while the tree animates behind.
    this.go(1);
    try {
      await this.onCommand?.(command);
    } catch (err) {
      console.error('[lesson] demo command failed', err);
    }
    this._demoBusy = false;
    // The host puts focus back in the terminal when a command finishes and the
    // focus trap bounces it into the panel; land it somewhere worth being.
    if (this.modal.isOpen && !this.modal.isClosing) {
      this.nextBtn?.focus({ preventScroll: true });
    }
  }

  paint() {
    const slide = this.slides[this.index] || {};
    this.contentEl.textContent = '';
    this.contentEl.appendChild(this.buildSlide(slide));
    this.modal.bodyEl.scrollTop = 0;
    this.modal._syncScroll?.();

    const total = this.slides.length;
    const heading = slide.title || this.level.name || 'Lesson';
    this.modal.titleEl.textContent = heading;
    this.stepEl.textContent =
      total > 1
        ? `${this.level.sequenceName ? `${this.level.sequenceName} · ` : ''}Slide ${
            this.index + 1
          } of ${total}`
        : this.level.sequenceName || '';
    this.stepEl.hidden = !this.stepEl.textContent;

    this.backBtn.disabled = this.index === 0;
    const last = this.index === total - 1;
    const label = this.nextBtn.querySelector('.btn-label');
    if (label) label.textContent = last ? 'Start level' : 'Next';
    const glyph = this.nextBtn.querySelector('use');
    if (glyph) glyph.setAttribute('href', iconHref(last ? 'goal' : 'next'));
    this.nextBtn.classList.toggle('is-finish', last);

    this.syncDots();
  }

  buildSlide(slide) {
    const wrap = el('article', { class: 'lesson-slide' });

    const prose = el('div', { class: 'prose' });
    prose.innerHTML = renderMarkdown(slide.markdown || '');

    // The slide title is already the panel heading; drop a leading heading that
    // only repeats it so the slide does not open with the same words twice.
    const lead = prose.firstElementChild;
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    if (lead && /^H[1-3]$/.test(lead.tagName) && slide.title && same(lead.textContent, slide.title)) {
      lead.remove();
    }

    prose.querySelectorAll('pre').forEach((pre) => {
      pre.classList.add('has-copy');
      pre.appendChild(copyButton(pre));
    });
    prose.querySelectorAll('img').forEach((img) => {
      img.loading = 'lazy';
      img.decoding = 'async';
    });
    wrap.appendChild(prose);

    if (slide.type === 'demo' && slide.command) {
      const last = this.index === this.slides.length - 1;
      wrap.appendChild(
        el(
          'div',
          { class: 'lesson-demo' },
          el(
            'div',
            { class: 'lesson-demo-head' },
            icon('terminal'),
            el('span', {}, 'Run this command')
          ),
          el(
            'div',
            { class: 'lesson-cmd' },
            el('span', { class: 'lesson-cmd-mark', 'aria-hidden': 'true' }, '$'),
            el('code', {}, slide.command)
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary lesson-try',
              title: last
                ? 'Run this command and close the lesson'
                : 'Run this command and read on',
              onClick: () => this.runDemo(slide.command),
            },
            // "Run it" leads with a play glyph; "and read on" trails with the
            // arrow that says where reading goes next.
            last ? icon('play') : null,
            el('span', { class: 'btn-label' }, last ? 'Try it' : 'Try it and read on'),
            last ? null : icon('next')
          )
        )
      );
    }

    return wrap;
  }
}
