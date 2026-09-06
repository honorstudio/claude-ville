import { eventBus } from '../domain/events/DomainEvent.js';

export class ModeManager {
    constructor() {
        this.currentMode = 'character';

        this.characterEl = document.getElementById('characterMode');
        this.dashboardEl = document.getElementById('dashboardMode');
        this.btnCharacter = document.getElementById('btnModeCharacter');
        this.btnDashboard = document.getElementById('btnModeDashboard');
        this._destroyed = false;
        this._onCharacterClick = () => this.switchMode('character');
        this._onDashboardClick = () => this.switchMode('dashboard');

        this._bindButtons();
        this._applyMode('character');
    }

    switchMode(mode) {
        if (this._destroyed || mode === this.currentMode) return;
        this.currentMode = mode;
        this._applyMode(mode);
        eventBus.emit('mode:changed', mode);
    }

    _applyMode(mode) {
        let shownEl = null;
        if (mode === 'character') {
            if (this.characterEl) this.characterEl.style.display = '';
            if (this.dashboardEl) this.dashboardEl.style.display = 'none';
            this.btnCharacter?.classList.add('topbar__mode-btn--active');
            this.btnDashboard?.classList.remove('topbar__mode-btn--active');
            shownEl = this.characterEl;
        } else {
            if (this.characterEl) this.characterEl.style.display = 'none';
            if (this.dashboardEl) this.dashboardEl.style.display = '';
            this.btnDashboard?.classList.add('topbar__mode-btn--active');
            this.btnCharacter?.classList.remove('topbar__mode-btn--active');
            shownEl = this.dashboardEl;
        }
        // 4.9 — fade the incoming container (CSS `cv-mode-fade-in`, 180ms).
        // Reduced motion: the CSS media query disables the animation, so this
        // stays an instant cut with no extra JS branching.
        if (shownEl) {
            shownEl.classList.remove('content__mode--enter');
            void shownEl.offsetWidth;
            shownEl.classList.add('content__mode--enter');
        }
    }

    getCurrentMode() {
        return this.currentMode;
    }

    _bindButtons() {
        this.btnCharacter?.addEventListener('click', this._onCharacterClick);
        this.btnDashboard?.addEventListener('click', this._onDashboardClick);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.btnCharacter?.removeEventListener('click', this._onCharacterClick);
        this.btnDashboard?.removeEventListener('click', this._onDashboardClick);
        this.characterEl = null;
        this.dashboardEl = null;
        this.btnCharacter = null;
        this.btnDashboard = null;
    }
}
