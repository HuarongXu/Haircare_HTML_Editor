const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const PptxGenJS = require('pptxgenjs');
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
    if (dragMode && selected) return; // In drag mode, don't re-select on click
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

  // --- Drag-and-drop positioning ---
  var dragMode = false;
  var dragging = false;
  var dragStartX = 0, dragStartY = 0;
  var dragOrigTransform = '';
  var dragOrigX = 0, dragOrigY = 0;

  // Find a meaningful draggable ancestor — skip tiny inline elements
  function getDraggable(el) {
    // Walk up to find a block-level or positioned element worth dragging
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var display = window.getComputedStyle(cur).display;
      var isBlock = display === 'block' || display === 'flex' || display === 'grid' ||
                    display === 'inline-block' || display === 'list-item';
      // Stop at elements that have meaningful size (not tiny inline spans)
      if (isBlock && cur.getBoundingClientRect().width > 40) return cur;
      // Also stop at elements with an ID or class (likely intentional layout elements)
      if (cur.id || (cur.className && typeof cur.className === 'string' && cur.className.trim())) {
        var r = cur.getBoundingClientRect();
        if (r.width > 30 && r.height > 20) return cur;
      }
      cur = cur.parentElement;
    }
    return el; // fallback to original
  }

  function parseDragTranslate(el) {
    var t = el.style.transform || '';
    var re = /translate\(([^,]+),\s*([^)]+)\)/;
    var m = t.match(re);
    if (m) return { x: parseFloat(m[1]) || 0, y: parseFloat(m[2]) || 0, rest: t.replace(re, '').trim() };
    return { x: 0, y: 0, rest: t === 'none' ? '' : t };
  }

  function applyDragTransform(el, x, y, rest) {
    var tr = 'translate(' + x + 'px, ' + y + 'px)';
    if (rest && rest.trim()) tr += ' ' + rest.trim();
    // Use !important to override the editor CSS that sets transform:none!important on [data-anim]
    el.style.setProperty('transform', tr, 'important');
  }

  document.addEventListener('mousedown', function(e) {
    if (!dragMode || !selected) return;
    if (e.target.id === '__editor_overlay__' || e.target.id === '__editor_label__') return;
    if (selected.contentEditable === 'true') return;
    // Ensure we drag a meaningful block element, not a tiny inline span
    var dragTarget = getDraggable(selected);
    if (dragTarget !== selected) {
      selected = dragTarget;
      selectEl(dragTarget);
    }
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    var parsed = parseDragTranslate(selected);
    dragOrigX = parsed.x;
    dragOrigY = parsed.y;
    dragOrigTransform = parsed.rest;
    saveUndoSnapshot();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging || !selected) return;
    var dx = e.clientX - dragStartX;
    var dy = e.clientY - dragStartY;
    applyDragTransform(selected, dragOrigX + dx, dragOrigY + dy, dragOrigTransform);
    // Update overlay position
    var r = selected.getBoundingClientRect();
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    label.style.left = r.left + 'px';
    label.style.top = Math.max(0, r.top - 20) + 'px';
  });

  document.addEventListener('mouseup', function(e) {
    if (!dragging) return;
    dragging = false;
    if (selected) {
      var parsed = parseDragTranslate(selected);
      if (parsed.x === dragOrigX && parsed.y === dragOrigY) {
        // No actual move — remove the snapshot
        undoStack.pop();
        reportUndoStatus();
      } else {
        window.parent.postMessage({ type: 'content-changed' }, '*');
      }
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
      // Clean up dynamically generated DOM elements that original JS will recreate
      // 1. Nav dots — original scripts re-create them via slides.forEach
      var navClone = clone.querySelector('#nav');
      if (navClone) navClone.innerHTML = '';
      // 2. Overview panel — original scripts re-create it dynamically
      clone.querySelectorAll('#overview').forEach(function(el) { el.remove(); });
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

    // TOGGLE BOLD
    if (d.type === 'toggle-bold') {
      if (!selected) return;
      saveUndoSnapshot();
      var cw = window.getComputedStyle(selected).fontWeight;
      var isBold = cw === 'bold' || cw === '700' || cw === '800' || cw === '900' || parseInt(cw) >= 700;
      selected.style.fontWeight = isBold ? 'normal' : 'bold';
      window.parent.postMessage({ type: 'content-changed' }, '*');
    }

    // TOGGLE DRAG MODE
    if (d.type === 'toggle-drag') {
      dragMode = !dragMode;
      document.body.style.cursor = dragMode ? 'move' : '';
      window.parent.postMessage({ type: 'drag-mode-changed', on: dragMode }, '*');
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
  // Only override opacity and transition — do NOT override transform as it breaks drag positioning
  // and causes visual inconsistency between editor and direct HTML open
  const editorCSS = `<style id="__visual_editor_style__">[data-anim],[data-anim="left"],[data-anim="right"],[data-anim="line"],[data-anim="step"]{opacity:1!important;transition:none!important;}</style>`;
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
    let dir = req.query.dir || __dirname;
    let resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      resolved = __dirname;
      dir = __dirname;
    }
    const items = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== '.venv')
      .map(d => ({ name: d.name, isDir: d.isDirectory(), path: path.join(resolved, d.name) }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    res.json({ dir: resolved, parent: path.dirname(resolved), items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Export helpers ---
async function launchAndLoad(resolved) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-web-security'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const fileUrl = 'file:///' + resolved.replace(/\\/g, '/');
  await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  // Force all animated elements visible
  await page.evaluate(() => {
    document.querySelectorAll('[data-anim]').forEach(el => {
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('transition', 'none', 'important');
    });
    // Hide any nav/overview UI the page itself creates
    document.querySelectorAll('#nav, #overview, .nav-dots').forEach(el => el.style.display = 'none');
  });
  await new Promise(r => setTimeout(r, 500));
  return { browser, page };
}

async function screenshotAllSlides(page) {
  const slideInfo = await page.evaluate(() => {
    let slides = document.querySelectorAll('.slide, section.slide');
    if (!slides.length) slides = document.querySelectorAll('section');
    const deck = document.getElementById('deck');
    const hasDeck = !!(deck && (window.getComputedStyle(deck).display === 'flex' || deck.style.transform));
    return { count: slides.length, hasDeck };
  });

  const screenshots = [];

  if (slideInfo.count > 1) {
    for (let i = 0; i < slideInfo.count; i++) {
      await page.evaluate((idx, isDeck) => {
        let slides = document.querySelectorAll('.slide, section.slide');
        if (!slides.length) slides = document.querySelectorAll('section');
        if (isDeck) {
          // Deck-based (flex + translateX): keep all slides in flow, just scroll
          const deck = document.getElementById('deck');
          deck.style.transition = 'none';
          deck.style.setProperty('transform', `translateX(-${idx * 100}vw)`, 'important');
          // Ensure all slides visible for proper flex layout
          slides.forEach(s => {
            s.style.setProperty('opacity', '1', 'important');
            s.style.visibility = 'visible';
          });
        } else {
          // Non-deck: show/hide
          slides.forEach((s, j) => {
            s.style.display = j === idx ? '' : 'none';
            if (j === idx) s.style.visibility = 'visible';
          });
        }
        // Force animations on current slide
        const current = slides[idx];
        if (current) {
          current.querySelectorAll('[data-anim]').forEach(el => {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('transition', 'none', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
          });
        }
      }, i, slideInfo.hasDeck);
      await new Promise(r => setTimeout(r, 500));
      const img = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
      screenshots.push(img);
    }
  } else {
    const img = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    screenshots.push(img);
  }
  return screenshots;
}

// Export to PDF (screenshot-based for reliability)
app.post('/api/export-pdf', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const safeName = encodeURIComponent(path.basename(resolved, '.html'));
  let browser;
  try {
    ({ browser, page } = await launchAndLoad(resolved));
    const screenshots = await screenshotAllSlides(page);

    // Build an HTML page with all screenshots as full-page images, then print to PDF
    const imagesHtml = screenshots.map((buf, i) => {
      const b64 = buf.toString('base64');
      const pageBreak = i < screenshots.length - 1 ? 'page-break-after:always;' : '';
      return `<div style="width:1920px;height:1080px;${pageBreak}"><img src="data:image/png;base64,${b64}" style="width:100%;height:100%;display:block;"></div>`;
    }).join('\n');

    const pdfPage = await browser.newPage();
    await pdfPage.setContent(`<!DOCTYPE html><html><head><style>*{margin:0;padding:0;}body{width:1920px;}</style></head><body>${imagesHtml}</body></html>`, { waitUntil: 'load' });

    const pdfBuffer = await pdfPage.pdf({
      width: '1920px',
      height: '1080px',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename*=UTF-8''${safeName}.pdf` });
    res.send(Buffer.from(pdfBuffer));
  } catch (e) {
    console.error('[export-pdf] Error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Export to PPTX (screenshot-based)
app.post('/api/export-pptx', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' });
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

  const safeName = encodeURIComponent(path.basename(resolved, '.html'));
  let browser, page;
  try {
    ({ browser, page } = await launchAndLoad(resolved));
    const screenshots = await screenshotAllSlides(page);

    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Visual HTML Editor';
    pptx.title = path.basename(resolved, '.html');

    for (const imgBuf of screenshots) {
      const slide = pptx.addSlide();
      slide.addImage({ data: `image/png;base64,${imgBuf.toString('base64')}`, x: 0, y: 0, w: '100%', h: '100%' });
    }

    const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': `attachment; filename*=UTF-8''${safeName}.pptx` });
    res.send(pptxBuffer);
  } catch (e) {
    console.error('[export-pptx] Error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
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
