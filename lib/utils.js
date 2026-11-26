/**
 * utils.js - Shared utility functions for Prompt Manager
 */

const PMUtils = {
  /**
   * Generate a unique ID
   */
  genId() {
    return 'pm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  },

  /**
   * Format timestamp to readable date string
   */
  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Extract {{variable}} placeholders from text
   */
  extractVariables(text) {
    if (!text) return [];
    const regex = /\{\{(\w+)\}\}/g;
    const vars = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!vars.includes(match[1])) {
        vars.push(match[1]);
      }
    }
    return vars;
  },

  /**
   * Replace {{variable}} placeholders with provided values
   */
  replaceVariables(text, values) {
    if (!text) return '';
    return text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return values[name] !== undefined && values[name] !== '' ? values[name] : match;
    });
  },

  /**
   * Debounce function
   */
  debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Copy text to clipboard
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        document.body.removeChild(ta);
        return false;
      }
    }
  },

  /**
   * Sanitize filename (remove invalid characters)
   */
  sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'untitled';
  },

  /**
   * Show a toast notification
   */
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `pm-toast pm-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      padding: 12px 20px; border-radius: 8px; font-size: 14px;
      color: #fff; background: ${type === 'error' ? '#e53935' : type === 'success' ? '#43a047' : '#1976d2'};
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0;
      transition: opacity 0.3s ease; max-width: 360px;
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  },
};

// Make available in both extension and content script contexts
if (typeof window !== 'undefined') {
  window.PMUtils = PMUtils;
}
