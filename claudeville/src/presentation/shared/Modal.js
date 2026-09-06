export class Modal {
    constructor() {
        this.overlay = document.getElementById('modalOverlay');
        this.box = this.overlay.querySelector('.modal');
        this.titleEl = document.getElementById('modalTitle');
        this.contentEl = document.getElementById('modalContent');
        this.closeBtn = document.getElementById('modalClose');

        this._onClose = () => this.close();
        this._onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            } else if (e.key === 'Tab') {
                this._trapFocus(e);
            }
        };
        this._onOverlayClick = (e) => {
            if (e.target === this.overlay) this.close();
        };
        this._destroyed = false;
        this._isOpen = false;
        this._requestVersion = 0;
        this._inertRecords = [];
        this._owner = null;
        // Element that had focus before the dialog opened; restored on close.
        this._previousFocus = null;

        this.closeBtn.addEventListener('click', this._onClose);
        this.overlay.addEventListener('click', this._onOverlayClick);
    }

    beginRequest() {
        if (this._destroyed) return null;
        return ++this._requestVersion;
    }

    isRequestCurrent(request) {
        return !this._destroyed && request !== null && request === this._requestVersion;
    }

    invalidateRequest(request = null) {
        if (request === null || request === this._requestVersion) {
            this._requestVersion++;
        }
    }

    open(title, contentHTML, { wide = false, request = null, owner = null } = {}) {
        if (this._destroyed) return false;
        const requestOwner = request ?? this.beginRequest();
        if (!this.isRequestCurrent(requestOwner)) return false;
        this.titleEl.textContent = title;
        this.contentEl.innerHTML = contentHTML;
        this.box.classList.toggle('modal--wide', wide);
        if (!this._isOpen) {
            this._previousFocus = document.activeElement;
            this._setBackgroundInert(true);
        }
        this._isOpen = true;
        this._owner = owner;
        this.overlay.setAttribute('aria-hidden', 'false');
        this.overlay.style.display = 'flex';
        document.addEventListener('keydown', this._onKeydown);
        // Move focus inside the dialog (role="dialog" + aria-modal in markup).
        this.closeBtn.focus();
        return true;
    }

    // Node-based companion to open(). Shared UI panels can keep their event
    // handlers and avoid converting trusted DOM into an HTML string.
    openContent(title, content, options = {}) {
        if (!this.open(title, '', options)) return false;
        this.contentEl.replaceChildren(content);
        return true;
    }

    isOpen(owner = null) {
        return this._isOpen && (owner === null || owner === this._owner);
    }

    close() {
        if (!this.overlay) return;
        this.invalidateRequest();
        const wasOpen = this._isOpen;
        this._isOpen = false;
        this._owner = null;
        this.overlay.style.display = 'none';
        this.overlay.setAttribute('aria-hidden', 'true');
        this.titleEl.textContent = '';
        this.contentEl.innerHTML = '';
        this.box.classList.remove('modal--wide');
        document.removeEventListener('keydown', this._onKeydown);
        this._setBackgroundInert(false);
        const previous = this._previousFocus;
        this._previousFocus = null;
        if (wasOpen && previous && previous.isConnected && typeof previous.focus === 'function') {
            previous.focus();
        }
    }

    _trapFocus(event) {
        if (!this._isOpen || !this.box) return;
        const focusable = [...this.box.querySelectorAll([
            'a[href]',
            'button:not([disabled])',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(','))].filter(node => node.getClientRects().length > 0);
        if (focusable.length === 0) {
            event.preventDefault();
            this.box.tabIndex = -1;
            this.box.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !this.box.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !this.box.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    }

    _setBackgroundInert(inert) {
        if (inert) {
            this._inertRecords = [...document.body.children]
                .filter(node => node !== this.overlay)
                .map(node => ({ node, wasInert: node.inert }));
            for (const { node } of this._inertRecords) node.inert = true;
            return;
        }
        for (const { node, wasInert } of this._inertRecords) {
            if (node.isConnected) node.inert = wasInert;
        }
        this._inertRecords = [];
    }

    // Public lifecycle hook for callers that mount/unmount shared UI primitives.
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.close();
        this.closeBtn.removeEventListener('click', this._onClose);
        this.overlay.removeEventListener('click', this._onOverlayClick);
        this.overlay = null;
        this.box = null;
        this.titleEl = null;
        this.contentEl = null;
        this.closeBtn = null;
    }
}
