// content.js — injected into the page
(function () {
  'use strict';

  if (window.__aiReaderCleanup) {
    try { window.__aiReaderCleanup(); } catch(_) {}
  }

  let sidebarEl = null;
  let headingEls = [];
  let annotationsVisible = true;
  let currentMode = 'enhanced';
  let termTooltipEl = null;
  let termTooltipBound = false;
  let termTooltipHandlers = null;

  // ── Message bus ───────────────────────────────────────────────────────────────
  function onMessage(msg, _sender, sendResponse) {
    try {
      switch (msg.action) {
        case 'ping':
          sendResponse({ ok: true }); return true;
        case 'showLoading':
          showLoadingSidebar();
          break;
        case 'annotate':
          applyAnnotations(
            msg.annotations || [], msg.terms    || [],
            msg.summary     || '', msg.toc     || []
          );
          break;
        case 'setMode':           setMode(msg.mode);              break;
        case 'toggleAnnotations': toggleAnnotations(msg.visible); break;
        case 'scrollToTop':       window.scrollTo({top:0,behavior:'smooth'}); break;
        case 'scrollToHeading':   scrollToHeading(msg.index);     break;
        case 'removeSidebar':     removeSidebar();                break;
      }
    } catch(e) { console.error('[AI Reader]', e); }
    sendResponse({ ok: true });
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.__aiReaderCleanup = () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    if (window.__aiReaderScrollSpy) {
      window.removeEventListener('scroll', window.__aiReaderScrollSpy);
      window.__aiReaderScrollSpy = null;
    }
    removeSidebar();
    cleanupTermTooltip();
    clearAnnotations();
  };
  window.__aiReaderInjected = true;

  // ── Article root ──────────────────────────────────────────────────────────────
  function getArticleRoot() {
    const selectors = [
      '#js_content', '.rich_media_content',
      '.Post-RichTextContainer', '.RichText',
      '.article-content', '.common-content',
      '.ArticleContent', '.article-body',
      'article', '[role="main"]',
      '.post-content', '.entry-content',
      '.content-area', '.main-content', 'main'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 200) return el;
    }
    let best = null, maxLen = 0;
    document.querySelectorAll('div,article,section').forEach(el => {
      if (el === document.body) return;
      const len = el.innerText.trim().length;
      if (len > maxLen && len < 100000 && el.children.length < 300) { maxLen = len; best = el; }
    });
    return best;
  }

  // ── Smart heading extraction ──────────────────────────────────────────────────
  // Handles platforms that use <p><strong>, <p style="font-weight">, section dividers etc.
  function extractHeadingsFromDOM(root) {
    const results = [];

    // 1. Standard h1-h4 tags
    root.querySelectorAll('h1,h2,h3,h4').forEach(el => {
      const text = el.innerText.trim();
      if (text && text.length < 100) {
        results.push({ el, level: parseInt(el.tagName[1]), text });
      }
    });

    // 2. If no standard headings, detect pseudo-headings
    if (results.length === 0) {
      // Check <p><strong>, <section><p>, bold paragraphs
      root.querySelectorAll('p, section > p, .content-item').forEach(el => {
        const text = el.innerText.trim();
        if (!text || text.length > 80 || text.length < 2) return;

        const style = window.getComputedStyle(el);
        const isBold = style.fontWeight >= 600 || style.fontWeight === 'bold' || style.fontWeight === 'bolder';
        const hasBoldChild = el.querySelector('strong, b') &&
          el.querySelector('strong, b').innerText.trim() === text;
        const isLargerFont = parseFloat(style.fontSize) >= 16;

        if (isBold || hasBoldChild || isLargerFont) {
          // Exclude if it's just emphasis inside a paragraph
          if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'p') return;
          results.push({ el, level: 2, text });
        }
      });

      // WeChat: section headings often have specific class patterns
      root.querySelectorAll('[class*="title"],[class*="heading"],[class*="section-title"]').forEach(el => {
        const text = el.innerText.trim();
        if (text && text.length < 80 && !results.find(r => r.text === text)) {
          results.push({ el, level: 2, text });
        }
      });
    }

    // Sort by DOM order
    results.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    return results;
  }

  // ── Text map helpers ──────────────────────────────────────────────────────────
  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const tag = n.parentElement && n.parentElement.tagName.toLowerCase();
        if (['script','style','noscript','iframe'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.classList.contains('ai-reader-annotation'))
          return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n; while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function buildTextMap(nodes) {
    const map = []; let off = 0;
    for (const n of nodes) {
      map.push({ node: n, start: off, end: off + n.nodeValue.length });
      off += n.nodeValue.length;
    }
    return map;
  }

  // ── Highlight [absStart, absEnd) across text nodes ────────────────────────────
  function highlightRange(textMap, absStart, absEnd, className, extraAttrs) {
    for (let i = 0; i < textMap.length; i++) {
      const e = textMap[i];
      if (e._isSpan) continue;
      if (e.end <= absStart || e.start >= absEnd) continue;

      const { node, start, end } = e;
      const lS = Math.max(0, absStart - start);
      const lE = Math.min(node.nodeValue.length, absEnd - start);
      if (lS >= lE) continue;

      const txt = node.nodeValue;
      const before = txt.slice(0, lS);
      const match  = txt.slice(lS, lE);
      const after  = txt.slice(lE);

      const span = document.createElement('span');
      span.className = 'ai-reader-annotation ' + className;
      span.textContent = match;
      if (extraAttrs) Object.keys(extraAttrs).forEach(k => span.setAttribute(k, extraAttrs[k]));

      const p = node.parentNode; if (!p) continue;
      const bn = document.createTextNode(before);
      const an = document.createTextNode(after);
      p.insertBefore(bn, node); p.insertBefore(span, node); p.insertBefore(an, node); p.removeChild(node);

      const spanChild = span.firstChild || span;
      textMap.splice(i, 1,
        { node: bn,        start,                                    end: start + before.length },
        { node: spanChild, start: start + before.length,             end: start + before.length + match.length, _isSpan: true },
        { node: an,        start: start + before.length + match.length, end }
      );
      i += 2;
    }
  }

  // ── Multi-strategy snippet matching ──────────────────────────────────────────
  // fullText is the ENTIRE article text (not sliced), so all annotations can match
  function findBestMatch(fullText, snippet, fullTextIndex) {
    if (!snippet || snippet.length < 4) return null;

    // 预处理 snippet：移除引号，标准化空格
    let processedSnippet = snippet
      .replace(/["'“”‘’]/g, '') // 移除各种引号
      .replace(/[\u00a0\u200b\u3000\r\n]+/g, ' ') // 标准化空格
      .replace(/\s+/g, ' ') // 合并多个空格
      .trim();

    if (processedSnippet.length < 4) return null;

    // 1. Exact match with processed snippet
    let idx = fullText.indexOf(processedSnippet);
    if (idx !== -1) return [idx, idx + processedSnippet.length];

    // 2. Exact comparable match with normalized mapping (prefer full sentence span)
    if (fullTextIndex) {
      const exactComparable = findComparableMatch(fullTextIndex, processedSnippet, 0, false);
      if (exactComparable) return [exactComparable.start, exactComparable.end];
    }

    // 3. Strip whitespace variants (normalize \u00a0, \n, \r, multiple spaces)
    const norm = s => s.replace(/[\u00a0\u200b\u3000\r\n]+/g, '').replace(/\s+/g, '');
    const normFull    = norm(fullText);
    const normSnippet = norm(processedSnippet);
    if (normSnippet.length >= 4) {
      idx = normFull.indexOf(normSnippet);
      if (idx !== -1) {
        // Map normalized index back to raw index (approximate)
        // Walk raw text counting non-space chars until we reach the normalized offset
        let rawIdx = 0, normCount = 0;
        while (rawIdx < fullText.length && normCount < idx) {
          if (!/[\u00a0\u200b\u3000\r\n\s]/.test(fullText[rawIdx])) normCount++;
          rawIdx++;
        }
        const rawEnd = Math.min(rawIdx + processedSnippet.length * 1.2, fullText.length);
        return [rawIdx, rawEnd];
      }
    }

    // 4. Match by first 20 CJK characters
    const cjkChars = processedSnippet.match(/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]+/g);
    if (cjkChars) {
      const allCjk = cjkChars.join('');
      if (allCjk.length >= 6) {
        const probe = allCjk.slice(0, 20);
        idx = fullText.indexOf(probe);
        if (idx !== -1) return [idx, Math.min(idx + processedSnippet.length, fullText.length)];
      }
    }

    // 5. First 25 characters (latin / mixed)
    const head25 = processedSnippet.replace(/^\s+/, '').slice(0, 25);
    if (head25.length >= 4) {
      idx = fullText.indexOf(head25);
      if (idx !== -1) return [idx, Math.min(idx + processedSnippet.length, fullText.length)];
    }

    // 6. Try with shorter snippet (first 15 characters)
    const head15 = processedSnippet.slice(0, 15);
    if (head15.length >= 4) {
      idx = fullText.indexOf(head15);
      if (idx !== -1) return [idx, Math.min(idx + processedSnippet.length, fullText.length)];
    }

    return null;
  }

  function collapseText(text) {
    return String(text || '')
      .replace(/[\u00a0\u200b\u3000\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeComparableText(text) {
    return collapseText(text)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/["'“”‘’`´]/g, '')
      .replace(/[‐‑‒–—―﹘﹣－]/g, '-')
      .replace(/[，。！？；：、,.!?:;~…·•]/g, '')
      .replace(/[()（）\[\]{}<>《》〈〉「」『』【】]/g, '')
      .replace(/[\s\-_\/\\|]+/g, '');
  }

  function buildComparableIndex(rawText) {
    const rawIndexByNormIndex = [];
    let normalized = '';

    for (let rawIndex = 0; rawIndex < rawText.length; rawIndex++) {
      const normalizedChunk = normalizeComparableText(rawText[rawIndex]);
      if (!normalizedChunk) continue;
      for (const ch of normalizedChunk) {
        normalized += ch;
        rawIndexByNormIndex.push(rawIndex);
      }
    }

    return { normalized, rawIndexByNormIndex };
  }

  function lowerBound(arr, target) {
    let left = 0;
    let right = arr.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (arr[mid] < target) left = mid + 1;
      else right = mid;
    }
    return left;
  }

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
  }

  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const gram = a.slice(i, i + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }

    let matches = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const gram = b.slice(i, i + 2);
      const count = grams.get(gram) || 0;
      if (count > 0) {
        grams.set(gram, count - 1);
        matches++;
      }
    }

    return (2 * matches) / ((a.length - 1) + (b.length - 1));
  }

  function findComparableMatch(fullTextIndex, snippet, minRawIndex = 0, allowShortProbe = true) {
    const normalizedSnippet = normalizeComparableText(snippet);
    if (normalizedSnippet.length < 4) return null;

    const startNormIndex = lowerBound(fullTextIndex.rawIndexByNormIndex, minRawIndex);
    const probes = allowShortProbe
      ? Array.from(new Set([
          normalizedSnippet,
          normalizedSnippet.slice(0, Math.min(24, normalizedSnippet.length)),
          normalizedSnippet.slice(0, Math.min(18, normalizedSnippet.length)),
          normalizedSnippet.slice(0, Math.min(12, normalizedSnippet.length)),
          normalizedSnippet.slice(0, Math.min(8, normalizedSnippet.length))
        ].filter(probe => probe.length >= 4)))
      : [normalizedSnippet];

    for (const probe of probes) {
      const normIndex = fullTextIndex.normalized.indexOf(probe, startNormIndex);
      if (normIndex === -1) continue;

      const rawStart = fullTextIndex.rawIndexByNormIndex[normIndex];
      const targetNormLen = allowShortProbe ? probe.length : normalizedSnippet.length;
      const rawEndIndex = Math.min(
        normIndex + targetNormLen - 1,
        fullTextIndex.rawIndexByNormIndex.length - 1
      );

      return {
        start: rawStart,
        end: fullTextIndex.rawIndexByNormIndex[rawEndIndex] + 1,
        confidence: targetNormLen === normalizedSnippet.length ? 125 : 80 + Math.round((targetNormLen / normalizedSnippet.length) * 20)
      };
    }

    return null;
  }

  function isBlockLikeElement(el) {
    if (!el || el === document.body) return false;
    try {
      const display = window.getComputedStyle(el).display;
      return ['block', 'flex', 'grid', 'list-item', 'table'].includes(display);
    } catch (_) {
      return false;
    }
  }

  function isUsefulTextBlock(el, root) {
    if (!el || el === root || el.closest('#ai-reader-sidebar')) return false;

    const text = collapseText(el.innerText);
    if (text.length < 6 || text.length > 400) return false;
    if (!isBlockLikeElement(el)) return false;

    const tag = el.tagName.toLowerCase();
    if (['article', 'main'].includes(tag) && text.length > 160) return false;

    const meaningfulBlockChildren = Array.from(el.children).filter(child => {
      if (!isBlockLikeElement(child)) return false;
      return collapseText(child.innerText).length >= 6;
    });

    if (!/^h[1-6]$/.test(tag) && meaningfulBlockChildren.length > 2) {
      return false;
    }

    return true;
  }

  function findNearestTextBlock(node, root) {
    let el = node.parentElement;
    while (el && el !== root) {
      if (isUsefulTextBlock(el, root)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function buildTocCandidates(root, textNodes, textMap) {
    const nodeStartMap = new Map();
    textMap.forEach(entry => {
      if (!entry._isSpan) nodeStartMap.set(entry.node, entry.start);
    });

    const candidatesByElement = new Map();

    textNodes.forEach(node => {
      const el = findNearestTextBlock(node, root);
      if (!el || candidatesByElement.has(el)) return;

      const start = nodeStartMap.get(node);
      if (typeof start !== 'number') return;

      const text = collapseText(el.innerText);
      if (!text) return;

      candidatesByElement.set(el, {
        el,
        start,
        text,
        normalizedText: normalizeComparableText(text),
        normalizedPrefix: normalizeComparableText(text.slice(0, 120))
      });
    });

    extractHeadingsFromDOM(root).forEach(({ el, text }) => {
      if (candidatesByElement.has(el)) return;

      const firstTextNode = collectTextNodes(el)[0];
      const start = firstTextNode ? nodeStartMap.get(firstTextNode) : null;
      if (typeof start !== 'number') return;

      const cleanText = collapseText(text);
      candidatesByElement.set(el, {
        el,
        start,
        text: cleanText,
        normalizedText: normalizeComparableText(cleanText),
        normalizedPrefix: normalizeComparableText(cleanText)
      });
    });

    return Array.from(candidatesByElement.values()).sort((a, b) => a.start - b.start);
  }

  function scoreTocCandidate(entry, candidate, minStart) {
    const anchor = normalizeComparableText(entry.anchor || '');
    if (anchor.length < 4 || !candidate.normalizedText) return -Infinity;

    const prefix = candidate.normalizedPrefix || candidate.normalizedText.slice(0, Math.max(anchor.length + 16, 24));
    let score = 0;

    const prefixIndex = prefix.indexOf(anchor);
    const fullIndex = candidate.normalizedText.indexOf(anchor);

    if (prefixIndex === 0) score += 150;
    else if (prefixIndex > 0) score += 120 - Math.min(prefixIndex, 40);
    else if (fullIndex !== -1) score += 90 - Math.min(fullIndex, 40);

    score += Math.min(commonPrefixLength(prefix, anchor) * 6, 72);
    score += diceCoefficient(anchor, prefix.slice(0, Math.max(anchor.length + 10, 24))) * 65;

    const titleNorm = normalizeComparableText(entry.title || '');
    const descNorm = normalizeComparableText(entry.desc || '');
    if (titleNorm.length >= 2) score += diceCoefficient(titleNorm, candidate.normalizedText.slice(0, 48)) * 20;
    if (descNorm.length >= 4) score += diceCoefficient(descNorm, candidate.normalizedText.slice(0, 80)) * 12;

    if (minStart > 0) {
      if (candidate.start + 30 < minStart) score -= 35;
      else if (candidate.start < minStart + 240) score += 8;
    }

    return score;
  }

  function findBestTocCandidate(entry, candidates, minStart) {
    let best = null;
    candidates.forEach(candidate => {
      const score = scoreTocCandidate(entry, candidate, minStart);
      if (!best || score > best.score) {
        best = { ...candidate, score };
      }
    });
    return best && best.score >= 60 ? best : null;
  }

  function selectBestOrderedCandidate(entry, candidates, minStart, maxStartHint) {
    const SEARCH_AHEAD = 18000;
    const strictWindow = candidates.filter(c => c.start >= minStart && c.start <= maxStartHint);
    const looseForward = candidates.filter(c => c.start >= minStart && c.start <= minStart + SEARCH_AHEAD);
    const backwardsNear = candidates.filter(c => c.start < minStart && c.start >= Math.max(0, minStart - 900));
    const pools = [strictWindow, looseForward, backwardsNear, candidates];

    for (let poolIdx = 0; poolIdx < pools.length; poolIdx++) {
      const pool = pools[poolIdx];
      if (!pool.length) continue;

      let best = null;
      pool.forEach(candidate => {
        let score = scoreTocCandidate(entry, candidate, minStart);
        if (!Number.isFinite(score)) return;

        // Prefer section order: later anchors should generally map to later blocks.
        if (candidate.start < minStart) {
          score -= poolIdx <= 2 ? 80 : 45;
        } else {
          score += 10;
        }

        // Prefer candidates close to the expected forward window.
        const distance = Math.abs(candidate.start - minStart);
        score -= Math.min(distance / 450, 24);

        if (!best || score > best.score) best = { ...candidate, score };
      });

      if (best && best.score >= (poolIdx <= 1 ? 68 : 62)) return best;
    }

    return null;
  }

  function getTocProbeText(entry) {
    const probes = [
      entry && entry.anchor,
      entry && entry.title,
      [entry && entry.title, entry && entry.desc].filter(Boolean).join(' '),
      entry && entry.desc
    ];
    return probes.find(text => normalizeComparableText(text).length >= 4) || '';
  }

  // ── Apply annotations ─────────────────────────────────────────────────────────
  function applyAnnotations(annotations, terms, summary, toc) {
    const root = getArticleRoot();
    if (!root) { 
      console.warn('[AI Reader] No article root'); 
      // 即使找不到文章根元素，也显示侧边栏
      renderSidebar(summary, toc, []);
      return; 
    }

    clearAnnotations();

    const textNodes = collectTextNodes(root);
    if (!textNodes.length) {
      // 即使没有文本节点，也显示侧边栏
      renderSidebar(summary, toc, []);
      return;
    }

    const textMap  = buildTextMap(textNodes);
    // Full concatenated text — no slicing, so every annotation can match
    const fullText = textNodes.map(n => n.nodeValue).join('');
    const fullTextIndex = buildComparableIndex(fullText);
    // Resolve TOC anchors before we mutate DOM with highlights.
    const tocAnchors = resolveTocAnchors(toc, root, fullTextIndex, textNodes, textMap);

    console.info('[AI Reader] Full text length:', fullText.length);

    const clsMap = {
      argument: 'ai-annotation-argument',
      fact:     'ai-annotation-fact',
      opinion:  'ai-annotation-opinion'
    };

    let matched = 0, total = 0;
    annotations.forEach(ann => {
      if (!ann.text || ann.text.length < 4) return;
      const cls = clsMap[ann.type]; if (!cls) return;
      total++;
      const r = findBestMatch(fullText, ann.text.trim(), fullTextIndex);
      if (!r) { console.debug('[AI Reader] No match:', ann.text.slice(0, 40)); return; }
      highlightRange(textMap, r[0], r[1], cls, null);
      matched++;
    });

    const used = new Set();
    terms.forEach(t => {
      if (!t.term || used.has(t.term)) return;
      const idx = fullText.indexOf(t.term); if (idx === -1) return;
      highlightRange(textMap, idx, idx + t.term.length, 'ai-annotation-term',
        { 'data-explanation': t.explanation || '' });
      used.add(t.term);
    });
    ensureTermTooltip();

    renderSidebar(summary, toc, tocAnchors);

    console.info('[AI Reader] Annotations:', matched + '/' + total,
      '| TOC entries:', toc.length, '(', tocAnchors.filter(Boolean).length, 'resolved)');
  }

  // ── Resolve TOC anchor strings → DOM nodes ────────────────────────────────────
  function resolveTocAnchors(toc, root, fullTextIndex, textNodes, textMap) {
    const candidates = buildTocCandidates(root, textNodes, textMap);
    let lastResolvedStart = 0;
    let unresolvedStreak = 0;
    const totalTextLen = textNodes.reduce((sum, n) => sum + n.nodeValue.length, 0);

    return toc.map((entry, idx) => {
      const probeText = getTocProbeText(entry);
      if (!probeText) {
        unresolvedStreak++;
        return null;
      }

      const expectedStep = toc.length > 1 ? Math.floor(totalTextLen / toc.length) : 0;
      const adaptiveWindow = Math.max(
        lastResolvedStart + 700,
        Math.min(totalTextLen, lastResolvedStart + expectedStep * (unresolvedStreak + 2))
      );

      const directMatch = findComparableMatch(fullTextIndex, probeText, Math.max(0, lastResolvedStart - 40));
      const candidateMatch = selectBestOrderedCandidate(entry, candidates, lastResolvedStart, adaptiveWindow);

      const preferCandidate = candidateMatch && (!directMatch || candidateMatch.score >= directMatch.confidence + 8);
      if (preferCandidate) {
        lastResolvedStart = candidateMatch.start;
        unresolvedStreak = 0;
        return candidateMatch.el;
      }

      if (directMatch) {
        const directElem = findElementByPosition(directMatch.start, textNodes, root);
        if (directElem) {
          // Avoid severe backward jumps when sequence is already established.
          if (directMatch.start + 900 >= lastResolvedStart || idx <= 1) {
            lastResolvedStart = Math.max(lastResolvedStart, directMatch.start);
            unresolvedStreak = 0;
            return directElem;
          }
        }
      }

      // Fallback: title-only matching against local candidates, slightly stricter threshold.
      const titleEntry = { ...entry, anchor: entry.title || '' };
      const titleMatch = selectBestOrderedCandidate(titleEntry, candidates, lastResolvedStart, adaptiveWindow);
      if (titleMatch && titleMatch.score >= 72) {
        lastResolvedStart = titleMatch.start;
        unresolvedStreak = 0;
        return titleMatch.el;
      }

      unresolvedStreak++;
      return null;
    });
  }
  
  // 辅助函数：根据位置找到对应的 DOM 元素
  function findElementByPosition(position, textNodes, root) {
    let cumLen = 0;
    for (const node of textNodes) {
      const len = node.nodeValue.length;
      if (cumLen + len > position) {
        const preferred = root ? findNearestTextBlock(node, root) : null;
        if (preferred) return preferred;

        let el = node.parentElement;
        let fallbackEl = node.parentElement;

        while (el && el !== document.body) {
          if (isBlockLikeElement(el)) return el;
          fallbackEl = el;
          el = el.parentElement;
        }
        return fallbackEl || node.parentElement;
      }
      cumLen += len;
    }
    return null;
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────────
  function captureSidebarLayout(el) {
    if (!el || el.id !== 'ai-reader-sidebar') return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function applySidebarLayout(el, layout) {
    if (!el || !layout) return;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = `${layout.left}px`;
    el.style.top = `${layout.top}px`;
    el.style.width = `${layout.width}px`;
    el.style.height = `${layout.height}px`;
    adjustFontSize(el, layout.width);
  }

  function removeSidebar() {
    if (sidebarEl) { sidebarEl.remove(); sidebarEl = null; }
  }

  function showLoadingSidebar() {
    console.log('showLoadingSidebar 被调用');
    removeSidebar();
    
    sidebarEl = document.createElement('div');
    sidebarEl.id = 'ai-reader-sidebar';
    console.log('创建了侧边栏元素');
    console.log('侧边栏 HTML:', sidebarEl.innerHTML);
    sidebarEl.innerHTML = `
      <div class="ai-sb-header">
        <div class="ai-sb-logo">✦ ReadAI</div>
        <div class="ai-sb-header-actions">
          <div class="ai-sb-mode-switch">
            <button class="ai-sb-mode-btn active" data-mode="enhanced" disabled>增强</button>
            <button class="ai-sb-mode-btn" data-mode="original" disabled>原文</button>
          </div>
          <button class="ai-sb-close" title="关闭" disabled style="opacity: 0.5; cursor: not-allowed;">✕</button>
        </div>
      </div>
      <div class="ai-sb-body">
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">目录</div>
          <div class="ai-sb-toc-intro">AI 正在分析文章内容...</div>
          <div class="ai-sb-toc-list">
            <div style="display: flex; justify-content: center; align-items: center; padding: 40px 0;">
              <div style="width: 30px; height: 30px; border: 3px solid #dee2e6; border-top-color: #7c6af7; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            </div>
          </div>
        </div>
        <div class="ai-sb-divider"></div>
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">摘要</div>
          <p class="ai-sb-summary-text">分析中...</p>
        </div>
        <div class="ai-sb-divider"></div>
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">图例</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(245,200,66,0.55);border:1.5px solid #f5c842"></span>核心论点</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(82,201,122,0.45);border:1.5px solid #52c97a"></span>数据 / 事实</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(181,123,238,0.45);border:1.5px solid #b57bee"></span>观点</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:transparent;border:2px dashed #5599ff"></span>专业术语（悬停查看解释）</div>
          <div class="ai-sb-divider"></div>
        </div>
      </div>
      <div class="ai-sb-resize-handle"></div>
      <div class="ai-sb-drag-hint">⠿ 拖动</div>
    `;
    
    document.body.appendChild(sidebarEl);
    
    // 绑定基本事件，但禁用所有交互
    const sb = sidebarEl;
    
    // 禁用关闭按钮
    sb.querySelector('.ai-sb-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    
    // 禁用模式切换按钮
    sb.querySelectorAll('.ai-sb-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });
    
    // 顶部和底部都可拖动
    bindDragHandle(sb, sb.querySelector('.ai-sb-header'));
    bindDragHandle(sb, sb.querySelector('.ai-sb-drag-hint'));
    
    // 仍然允许调整大小
    makeResizable(sb, sb.querySelector('.ai-sb-resize-handle'));
    console.log('侧边栏已添加到页面');
  }

  function escHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderSidebar(summary, toc, tocAnchors) {
    const preservedLayout = captureSidebarLayout(sidebarEl);
    removeSidebar();

    // Build semantic TOC html — each entry has a number badge, title, and desc
    const tocHtml = (toc && toc.length)
      ? toc.map((entry, i) => {
          const resolved = !!(tocAnchors && tocAnchors[i]);
          return `
          <div class="ai-sb-toc-item ${resolved ? '' : 'ai-sb-toc-unresolved'}" data-idx="${i}" title="${resolved ? '点击跳转' : '无法定位此章节'}">
            <div class="ai-sb-toc-badge">${i + 1}</div>
            <div class="ai-sb-toc-body">
              <div class="ai-sb-toc-title">${escHtml(entry.title || '')}</div>
              ${entry.desc ? `<div class="ai-sb-toc-desc">${escHtml(entry.desc)}</div>` : ''}
            </div>
            ${resolved ? '<div class="ai-sb-toc-arrow">›</div>' : ''}
          </div>`;
        }).join('')
      : '<div class="ai-sb-empty">AI 目录生成中…</div>';

    sidebarEl = document.createElement('div');
    sidebarEl.id = 'ai-reader-sidebar';
    sidebarEl.innerHTML = `
      <div class="ai-sb-header">
        <div class="ai-sb-logo">✦ ReadAI</div>
        <div class="ai-sb-header-actions">
          <div class="ai-sb-mode-switch">
            <button class="ai-sb-mode-btn active" data-mode="enhanced">增强</button>
            <button class="ai-sb-mode-btn" data-mode="original">原文</button>
          </div>
          <button class="ai-sb-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="ai-sb-body">
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">摘要</div>
          <p class="ai-sb-summary-text">${escHtml(summary) || '暂无摘要'}</p>
        </div>
        <div class="ai-sb-divider"></div>
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">目录</div>
          <div class="ai-sb-toc-intro">AI 提炼的内容地图，点击跳转对应区域</div>
          <div class="ai-sb-toc-list">${tocHtml}</div>
        </div>
        <div class="ai-sb-divider"></div>
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">图例</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(245,200,66,0.55);border:1.5px solid #f5c842"></span>核心论点</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(82,201,122,0.45);border:1.5px solid #52c97a"></span>数据 / 事实</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:rgba(181,123,238,0.45);border:1.5px solid #b57bee"></span>观点</div>
          <div class="ai-sb-legend-item"><span class="ai-sb-dot" style="background:transparent;border:2px dashed #5599ff"></span>专业术语（悬停查看解释）</div>
          <div class="ai-sb-divider"></div>
        </div>
      </div>
      <div class="ai-sb-resize-handle"></div>
      <div class="ai-sb-drag-hint">⠿ 拖动</div>
    `;

    document.body.appendChild(sidebarEl);
    if (preservedLayout) applySidebarLayout(sidebarEl, preservedLayout);
    bindSidebarEvents(sidebarEl, tocAnchors);
  }

  function bindSidebarEvents(sb, tocAnchors) {
    // Close
    sb.querySelector('.ai-sb-close').addEventListener('click', removeSidebar);

    // TOC click → scroll to resolved anchor element
    sb.querySelectorAll('.ai-sb-toc-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.idx);
        const el = tocAnchors && tocAnchors[idx];
        if (!el) return;
        // Highlight the target briefly
        el.style.transition = 'background 0.3s';
        el.style.background = 'rgba(124,106,247,0.15)';
        setTimeout(() => { el.style.background = ''; }, 1200);
        const top = Math.max(0, window.scrollY + el.getBoundingClientRect().top - 90);
        window.scrollTo({ top, behavior: 'smooth' });
        // Mark active in sidebar
        sb.querySelectorAll('.ai-sb-toc-item').forEach(i => i.classList.remove('ai-sb-toc-active'));
        item.classList.add('ai-sb-toc-active');
      });
    });

    // Mode toggle
    sb.querySelectorAll('.ai-sb-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sb.querySelectorAll('.ai-sb-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setMode(btn.dataset.mode);
      });
    });

    // Drag (top + bottom hint area)
    bindDragHandle(sb, sb.querySelector('.ai-sb-header'));
    bindDragHandle(sb, sb.querySelector('.ai-sb-drag-hint'));

    // Resize
    makeResizable(sb, sb.querySelector('.ai-sb-resize-handle'));

    // Scroll spy: highlight current TOC item as user scrolls
    if (tocAnchors && tocAnchors.some(Boolean)) {
      setupScrollSpy(sb, tocAnchors);
    }
  }

  function makeResizable(el, _handle) {
    const MIN_WIDTH = 200;
    const MAX_WIDTH = 520;
    const MIN_HEIGHT = 300;
    const EDGE = 16;

    const getCornerAtPoint = (rect, clientX, clientY) => {
      const nearLeft = Math.abs(clientX - rect.left) <= EDGE;
      const nearRight = Math.abs(clientX - rect.right) <= EDGE;
      const nearTop = Math.abs(clientY - rect.top) <= EDGE;
      const nearBottom = Math.abs(clientY - rect.bottom) <= EDGE;
      if (nearLeft && nearTop) return 'top-left';
      if (nearRight && nearTop) return 'top-right';
      if (nearLeft && nearBottom) return 'bottom-left';
      if (nearRight && nearBottom) return 'bottom-right';
      return null;
    };

    const cursorByCorner = {
      'top-left': 'nwse-resize',
      'bottom-right': 'nwse-resize',
      'top-right': 'nesw-resize',
      'bottom-left': 'nesw-resize'
    };

    el.addEventListener('mousemove', e => {
      const rect = el.getBoundingClientRect();
      const corner = getCornerAtPoint(rect, e.clientX, e.clientY);
      if (corner) el.style.cursor = cursorByCorner[corner];
      else if (!e.buttons) el.style.cursor = '';
    });

    el.addEventListener('mouseleave', () => {
      if (!document.body.classList.contains('ai-reader-resizing')) el.style.cursor = '';
    });

    el.addEventListener('mousedown', e => {
      if (!e.target.closest('#ai-reader-sidebar')) return;
      const rect = el.getBoundingClientRect();
      const corner = getCornerAtPoint(rect, e.clientX, e.clientY);
      if (!corner) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = rect.width;
      const startHeight = rect.height;
      const startLeft = rect.left;
      const startTop = rect.top;
      const maxLeft = window.innerWidth - MIN_WIDTH;
      const maxTop = window.innerHeight - MIN_HEIGHT;

      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = `${startLeft}px`;
      el.style.top = `${startTop}px`;
      el.style.transition = 'none';
      document.body.classList.add('ai-reader-resizing');

      const onMove = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let width = startWidth;
        let height = startHeight;
        let left = startLeft;
        let top = startTop;

        if (corner.includes('left')) {
          width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth - dx));
          left = startLeft + (startWidth - width);
        } else {
          width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + dx));
        }

        if (corner.includes('top')) {
          height = Math.max(MIN_HEIGHT, startHeight - dy);
          top = startTop + (startHeight - height);
        } else {
          height = Math.max(MIN_HEIGHT, startHeight + dy);
        }

        left = Math.max(0, Math.min(maxLeft, left));
        top = Math.max(0, Math.min(maxTop, top));
        const maxHeightByViewport = Math.max(MIN_HEIGHT, window.innerHeight - top);
        height = Math.min(height, maxHeightByViewport);

        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        adjustFontSize(el, width);
      };

      const onUp = () => {
        el.style.transition = '';
        el.style.cursor = '';
        document.body.classList.remove('ai-reader-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function adjustFontSize(el, width) {
    // 根据宽度调整字体大小
    const baseSize = 16;
    const minSize = 14;
    const maxSize = 18;
    const newSize = Math.max(minSize, Math.min(maxSize, baseSize + (width - 280) / 40));
    
    el.style.fontSize = newSize + 'px';
    
    // 调整各个元素的字体大小
    const sections = el.querySelectorAll('.ai-sb-section-title');
    sections.forEach(section => {
      section.style.fontSize = (newSize * 1.1) + 'px';
    });
    
    const tocItems = el.querySelectorAll('.ai-sb-toc-title');
    tocItems.forEach(item => {
      item.style.fontSize = (newSize * 0.95) + 'px';
    });
    
    const tocDescs = el.querySelectorAll('.ai-sb-toc-desc');
    tocDescs.forEach(desc => {
      desc.style.fontSize = (newSize * 0.85) + 'px';
    });
    
    const summary = el.querySelector('.ai-sb-summary-text');
    if (summary) {
      summary.style.fontSize = (newSize * 0.95) + 'px';
    }
    
    const legendItems = el.querySelectorAll('.ai-sb-legend-item');
    legendItems.forEach(item => {
      item.style.fontSize = (newSize * 0.9) + 'px';
    });
    
    const hints = el.querySelectorAll('.ai-sb-hint');
    hints.forEach(hint => {
      hint.style.fontSize = (newSize * 0.8) + 'px';
    });
  }

  // ── Scroll spy ────────────────────────────────────────────────────────────────
  function setupScrollSpy(sb, tocAnchors) {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const mid = window.innerHeight * 0.4;
        let activeIdx = -1;
        tocAnchors.forEach((el, i) => {
          if (!el) return;
          const rect = el.getBoundingClientRect();
          if (rect.top <= mid) activeIdx = i;
        });
        sb.querySelectorAll('.ai-sb-toc-item').forEach((item, i) => {
          item.classList.toggle('ai-sb-toc-active', i === activeIdx);
        });
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Store cleanup ref
    window.__aiReaderScrollSpy = onScroll;
  }

  function makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button, .ai-sb-tabs')) return;
      startX = e.clientX; startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = startLeft + 'px'; el.style.top = startTop + 'px';
      el.style.transition = 'none';
      const move = ev => {
        el.style.left = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + ev.clientX - startX)) + 'px';
        el.style.top  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + ev.clientY - startY)) + 'px';
      };
      const up = () => {
        el.style.transition = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  function bindDragHandle(el, handle) {
    if (!handle) return;
    makeDraggable(el, handle);
    handle.style.cursor = 'grab';
  }



  // ── Misc ──────────────────────────────────────────────────────────────────────
  function clearAnnotations() {
    Array.from(document.querySelectorAll('.ai-reader-annotation')).reverse().forEach(span => {
      const p = span.parentNode; if (!p) return;
      p.replaceChild(document.createTextNode(span.textContent), span);
      p.normalize();
    });
  }

  function setMode(mode) {
    currentMode = mode;
    toggleAnnotations(mode === 'enhanced' ? true : false);
  }

  function toggleAnnotations(visible) {
    annotationsVisible = visible;
    document.querySelectorAll('.ai-reader-annotation').forEach(el => {
      el.style.background   = visible ? '' : 'transparent';
      el.style.borderBottom = visible ? '' : 'none';
    });
  }

  function scrollToHeading(index) {
    const el = headingEls[index];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function ensureTermTooltip() {
    if (!termTooltipEl) {
      termTooltipEl = document.createElement('div');
      termTooltipEl.id = 'ai-reader-term-tooltip';
      document.documentElement.appendChild(termTooltipEl);
    }
    if (termTooltipBound) return;

    const show = (target, evt) => {
      const explanation = target && target.getAttribute('data-explanation');
      if (!explanation || !termTooltipEl) return;
      termTooltipEl.textContent = explanation;
      termTooltipEl.classList.add('visible');
      positionTermTooltip(evt);
    };

    const hide = () => {
      if (termTooltipEl) termTooltipEl.classList.remove('visible');
    };

    const onMouseOver = (evt) => {
      const target = evt.target && evt.target.closest && evt.target.closest('.ai-annotation-term');
      if (!target) return;
      show(target, evt);
    };

    const onMouseMove = (evt) => {
      if (!termTooltipEl || !termTooltipEl.classList.contains('visible')) return;
      positionTermTooltip(evt);
    };

    const onMouseOut = (evt) => {
      const from = evt.target && evt.target.closest && evt.target.closest('.ai-annotation-term');
      if (!from) return;
      const to = evt.relatedTarget && evt.relatedTarget.closest && evt.relatedTarget.closest('.ai-annotation-term');
      if (to === from) return;
      hide();
    };

    const onScroll = () => hide();
    const onResize = () => hide();

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    termTooltipHandlers = { onMouseOver, onMouseMove, onMouseOut, onScroll, onResize };
    termTooltipBound = true;
  }

  function positionTermTooltip(evt) {
    if (!termTooltipEl) return;
    const margin = 12;
    const tooltipRect = termTooltipEl.getBoundingClientRect();
    let left = evt.clientX - tooltipRect.width / 2;
    let top = evt.clientY - tooltipRect.height - 14;

    if (left < margin) left = margin;
    if (left + tooltipRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tooltipRect.width - margin;
    }
    if (top < margin) top = evt.clientY + 14;
    if (top + tooltipRect.height > window.innerHeight - margin) {
      top = window.innerHeight - tooltipRect.height - margin;
    }

    termTooltipEl.style.left = `${left}px`;
    termTooltipEl.style.top = `${top}px`;
  }

  function cleanupTermTooltip() {
    if (termTooltipHandlers) {
      document.removeEventListener('mouseover', termTooltipHandlers.onMouseOver, true);
      document.removeEventListener('mousemove', termTooltipHandlers.onMouseMove, true);
      document.removeEventListener('mouseout', termTooltipHandlers.onMouseOut, true);
      document.removeEventListener('scroll', termTooltipHandlers.onScroll, true);
      window.removeEventListener('resize', termTooltipHandlers.onResize);
      termTooltipHandlers = null;
    }
    if (termTooltipEl && termTooltipEl.parentNode) {
      termTooltipEl.parentNode.removeChild(termTooltipEl);
    }
    termTooltipEl = null;
    termTooltipBound = false;
  }

  // 测试函数：当脚本加载时显示一个测试侧边栏
  function testSidebar() {
    console.log('测试侧边栏函数被调用');
    const testSidebarEl = document.createElement('div');
    testSidebarEl.id = 'ai-reader-sidebar';
    testSidebarEl.innerHTML = `
      <div class="ai-sb-header">
        <div class="ai-sb-logo">✦ ReadAI</div>
        <button class="ai-sb-close" title="关闭">✕</button>
      </div>
      <div class="ai-sb-body">
        <div class="ai-sb-section">
          <div class="ai-sb-section-title">测试</div>
          <div class="ai-sb-toc-intro">脚本加载成功！</div>
          <div class="ai-sb-toc-list">
            <div style="padding: 20px; text-align: center;">
              侧边栏测试成功
            </div>
          </div>
        </div>
      </div>
      <div class="ai-sb-resize-handle"></div>
      <div class="ai-sb-drag-hint">⠿ 拖动</div>
    `;
    
    document.body.appendChild(testSidebarEl);
    console.log('测试侧边栏已添加到页面');
    
    // 绑定关闭按钮
    testSidebarEl.querySelector('.ai-sb-close').addEventListener('click', () => {
      testSidebarEl.remove();
    });
  }

  // 仅在开发模式下运行测试
  // testSidebar();

})();
