const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 9001;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Store original <script> blocks per file so we can restore them if save loses them
const originalScriptsMap = new Map();
const SCRIPT_RE = /<script\b(?![^>]*id\s*=\s*["']__visual_editor_script__)[^>]*>[\s\S]*?<\/script>/gi;

// Serve editor page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'visual-editor.html')));

// Serve any local file (for iframe src)
app.get('/preview', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing path');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found');

  let html = fs.readFileSync(resolved, 'utf-8');

  // Remember original <script> blocks (excluding editor script)
  const origScripts = html.match(SCRIPT_RE) || [];
  if (origScripts.length > 0) {
    originalScriptsMap.set(resolved, origScripts);
  }

  // Inject editing helper script before </body>
  const editScript = `
<script id="__visual_editor_script__">
(function() {
  var selected = null;
  var undoStack = [];
  var MAX_UNDO = 50;

  function getBodySnapshot() {
    var clone = document.body.cloneNode(true);
    var sc = clone.querySelector('#__visual_editor_script__');
    if (sc) sc.remove();
    var ov = clone.querySelector('#__editor_overlay__');
    if (ov) ov.remove();
    var lb = clone.querySelector('#__editor_label__');
    if (lb) lb.remove();
    clone.querySelectorAll('[contenteditable]').forEach(function(el) { el.removeAttribute('contenteditable'); });
    return clone.innerHTML;
  }

  function saveUndoSnapshot() {
    undoStack.push(getBodySnapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    reportUndoStatus();
  }

  function performUndo() {
    if (undoStack.length === 0) return;
    var snapshot = undoStack.pop();
    clearSelection();
    // Detach editor elements before replacing body content
    var edScript = document.getElementById('__visual_editor_script__');
    var edOverlay = document.getElementById('__editor_overlay__');
    var edLabel = document.getElementById('__editor_label__');
    if (edScript) edScript.parentNode.removeChild(edScript);
    if (edOverlay) edOverlay.parentNode.removeChild(edOverlay);
    if (edLabel) edLabel.parentNode.removeChild(edLabel);
    // Restore body content
    document.body.innerHTML = snapshot;
    // Re-attach editor elements (use closure refs which are same objects)
    document.body.appendChild(overlay);
    document.body.appendChild(label);
    if (edScript) document.body.appendChild(edScript);
    reportUndoStatus();
    reportSlideInfo();
    window.parent.postMessage({ type: 'content-changed' }, '*');
  }

  function reportUndoStatus() {
    window.parent.postMessage({ type: 'undo-status', count: undoStack.length }, '*');
  }

  // --- UI overlays ---
  var overlay = document.createElement('div');
  overlay.id = '__editor_overlay__';
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #6366f1;z-index:99999;display:none;transition:all 0.15s;';
  document.body.appendChild(overlay);

  var label = document.createElement('div');
  label.id = '__editor_label__';
  label.style.cssText = 'position:fixed;background:#6366f1;color:#fff;font:11px/1.4 monospace;padding:2px 6px;z-index:100000;display:none;border-radius:0 0 4px 0;';
  document.body.appendChild(label);

  // --- Slide detection ---
  function getSlides() {
    var s = document.querySelectorAll('.slide, section.slide');
    if (!s.length) s = document.querySelectorAll('section');
    return Array.from(s);
  }
  var currentSlideIndex = 0;

  function reportSlideInfo() {
    var slides = getSlides();
    if (slides.length > 1) {
      window.parent.postMessage({ type: 'slide-info', current: currentSlideIndex + 1, total: slides.length }, '*');
    }
  }
  var hasDeckNav = false;
  window.addEventListener('load', function() {
    setTimeout(reportSlideInfo, 300);
    // For transform-based decks: let the original JS handle navigation
    var deck = document.getElementById('deck');
    if (deck && window.getComputedStyle(deck).display === 'flex') {
      hasDeckNav = true;
      // Sync editor slide indicator when original JS navigates
      var observer = new MutationObserver(function() {
        var transform = deck.style.transform || '';
        var match = transform.match(/translateX\\(-?(\\d+)/);
        if (match) {
          currentSlideIndex = Math.round(parseInt(match[1]) / 100);
          reportSlideInfo();
        }
      });
      observer.observe(deck, { attributes: true, attributeFilter: ['style'] });
    }
  });

  function getComputedFontSize(el) {
    return window.getComputedStyle(el).fontSize;
  }

  // --- Select element ---
  function selectEl(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    if (el.id === '__editor_overlay__' || el.id === '__editor_label__') return;
    selected = el;
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    label.style.display = 'block';
    label.style.left = r.left + 'px';
    label.style.top = Math.max(0, r.top - 20) + 'px';
    label.textContent = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
    window.parent.postMessage({
      type: 'element-selected',
      tag: el.tagName,
      text: (el.textContent || '').substring(0, 100),
      classes: el.className || '',
      fontSize: getComputedFontSize(el)
    }, '*');
  }

  function clearSelection() {
    selected = null;
    overlay.style.display = 'none';
    label.style.display = 'none';
  }

  // --- Click to select ---
  document.addEventListener('click', function(e) {
    if (e.target.id === '__editor_overlay__' || e.target.id === '__editor_label__') return;
    if (e.target.tagName === 'A' || e.target.closest('a')) e.preventDefault();
    e.stopPropagation();
    selectEl(e.target);
  }, true);

  // --- Double-click to edit text ---
  document.addEventListener('dblclick', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) return;
    saveUndoSnapshot();
    selected.contentEditable = 'true';
    selected.focus();
    selected.style.outline = '2px dashed #f59e0b';
    var textBefore = selected.innerHTML;
    selected.addEventListener('blur', function handler() {
      selected.contentEditable = 'false';
      selected.style.outline = '';
      selected.removeEventListener('blur', handler);
      if (selected.innerHTML !== textBefore) {
        window.parent.postMessage({ type: 'content-changed' }, '*');
      } else {
        // No change — remove the snapshot we saved
        undoStack.pop();
        reportUndoStatus();
      }
    }, { once: true });
  }, true);

  // --- Delete key to remove ---
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Delete' && selected && selected.contentEditable !== 'true') {
      e.preventDefault();
      saveUndoSnapshot();
      selected.remove();
      clearSelection();
      window.parent.postMessage({ type: 'content-changed' }, '*');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      performUndo();
    }
  });

  // --- Update overlay on scroll ---
  window.addEventListener('scroll', function() {
    if (selected) selectEl(selected);
  }, true);

  // --- Message handler from parent editor ---
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || !d.type) return;

    // GET HTML for saving
    if (d.type === 'get-html') {
      clearSelection();
      var clone = document.documentElement.cloneNode(true);
      var sc = clone.querySelector('#__visual_editor_script__');
      if (sc) sc.remove();
      var es = clone.querySelector('#__visual_editor_style__');
      if (es) es.remove();
      var ov = clone.querySelector('#__editor_overlay__');
      if (ov) ov.remove();
      var lb = clone.querySelector('#__editor_label__');
      if (lb) lb.remove();
      clone.querySelectorAll('[contenteditable]').forEach(function(el) { el.removeAttribute('contenteditable'); });
      clone.querySelectorAll('.slide, section').forEach(function(el) {
        el.style.removeProperty('display');
        el.style.removeProperty('visibility');
        if (!el.getAttribute('style')) el.removeAttribute('style');
      });
      var deckClone = clone.querySelector('#deck');
      if (deckClone) {
        deckClone.style.removeProperty('transform');
        deckClone.style.removeProperty('transition');
        if (!deckClone.getAttribute('style')) deckClone.removeAttribute('style');
      }
      window.parent.postMessage({ type: 'html-content', html: '<!DOCTYPE html>\\n' + clone.outerHTML }, '*');
    }

    // SLIDE NAVIGATION
    if (d.type === 'slide-nav') {
      var slides = getSlides();
      if (slides.length <= 1) return;
      if (d.dir === 'next') currentSlideIndex = Math.min(currentSlideIndex + 1, slides.length - 1);
      else if (d.dir === 'prev') currentSlideIndex = Math.max(currentSlideIndex - 1, 0);
      if (hasDeckNav) {
        // Directly control deck transform, bypassing pipeline step logic
        var deck = document.getElementById('deck');
        deck.style.transform = 'translateX(-' + (currentSlideIndex * 100) + 'vw)';
        // Sync nav dots
        var navEl = document.getElementById('nav');
        if (navEl) {
          navEl.querySelectorAll('.dot').forEach(function(dot, i) {
            dot.classList.toggle('active', i === currentSlideIndex);
          });
        }
        // Sync original JS state and trigger animations
        window.__currentSlideIndex = currentSlideIndex;
        if (window.__playSlide) window.__playSlide(currentSlideIndex);
        // Update theme
        var el = slides[currentSlideIndex];
        if (el) {
          var isLight = el.classList.contains('light');
          document.body.classList.toggle('light-bg', isLight);
        }
      } else {
        slides.forEach(function(s, i) {
          s.style.display = (i === currentSlideIndex) ? '' : 'none';
          if (i === currentSlideIndex) s.style.visibility = 'visible';
        });
      }
      window.scrollTo(0, 0);
      reportSlideInfo();
    }

    // UNDO
    if (d.type === 'undo') {
      performUndo();
    }

    // FONT SIZE CHANGE
    if (d.type === 'change-font-size') {
      if (!selected) return;
      saveUndoSnapshot();
      var current = parseFloat(getComputedFontSize(selected));
      if (d.delta === 0) {
        selected.style.fontSize = '';
      } else {
        var step = current < 14 ? 1 : current < 24 ? 2 : 4;
        var newSize = Math.max(8, current + d.delta * step);
        selected.style.fontSize = newSize + 'px';
      }
      window.parent.postMessage({
        type: 'element-selected',
        tag: selected.tagName,
        text: (selected.textContent || '').substring(0, 100),
        classes: selected.className || '',
        fontSize: getComputedFontSize(selected)
      }, '*');
      window.parent.postMessage({ type: 'content-changed' }, '*');
    }

    // SLIDE REORDER
    if (d.type === 'slide-reorder') {
      var slides = getSlides();
      if (slides.length <= 1) return;
      saveUndoSnapshot();
      var idx = currentSlideIndex;
      var slide = slides[idx];
      if (d.dir === 'up' && idx > 0) {
        slide.parentNode.insertBefore(slide, slides[idx - 1]);
        currentSlideIndex = idx - 1;
      } else if (d.dir === 'down' && idx < slides.length - 1) {
        slides[idx + 1].parentNode.insertBefore(slides[idx + 1], slide);
        currentSlideIndex = idx + 1;
      } else {
        return;
      }
      if (hasDeckNav) {
        var deck = document.getElementById('deck');
        deck.style.transform = 'translateX(-' + (currentSlideIndex * 100) + 'vw)';
      } else {
        getSlides().forEach(function(s, i) {
          s.style.display = (i === currentSlideIndex) ? '' : 'none';
          if (i === currentSlideIndex) s.style.visibility = 'visible';
        });
      }
      window.scrollTo(0, 0);
      reportSlideInfo();
      window.parent.postMessage({ type: 'content-changed' }, '*');
    }
  });
})();
</script>`;

  html = html.replace(/<\/body>/i, editScript + '\n</body>');

  // Force all animated elements visible in editor (they default to opacity:0 waiting for JS animation)
  const editorCSS = `<style id="__visual_editor_style__">[data-anim],[data-anim="left"],[data-anim="right"],[data-anim="line"],[data-anim="step"]{opacity:1!important;transform:none!important;transition:none!important;}</style>`;
  html = html.replace(/<\/head>/i, editorCSS + '\n</head>');
  res.type('html').send(html);
});

// Save file
app.post('/api/save', (req, res) => {
  const { filePath, html } = req.body;
  if (!filePath || !html) return res.status(400).json({ error: 'Missing data' });
  const resolved = path.resolve(filePath);

  // Always strip all scripts from client HTML, then re-inject originals from when file was loaded.
  // Browser DOM serialization (cloneNode+outerHTML) is unreliable for <script> preservation.
  let finalHtml = html.replace(SCRIPT_RE, '');
  const origScripts = originalScriptsMap.get(resolved) || [];
  const restored = origScripts.length > 0;
  if (restored) {
    console.log(`[save] Re-injecting ${origScripts.length} original <script> block(s) for ${path.basename(resolved)}`);
    finalHtml = finalHtml.replace(/<\/body>/i, origScripts.join('\n') + '\n</body>');
  }

  if (fs.existsSync(resolved)) {
    fs.copyFileSync(resolved, resolved + '.bak');
  }
  fs.writeFileSync(resolved, finalHtml, 'utf-8');
  res.json({ success: true, scriptsRestored: restored });
});

// Browse directory
app.get('/api/browse', (req, res) => {
  try {
    const dir = req.query.dir || 'C:\\';
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    const items = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== '.venv')
      .map(d => ({ name: d.name, isDir: d.isDirectory(), path: path.join(resolved, d.name) }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    res.json({ dir: resolved, parent: path.dirname(resolved), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint: ' + req.method + ' ' + req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Visual HTML Editor: http://localhost:${PORT}\n`);
});
