// popup.js
const $ = s => document.querySelector(s);

// ── Page navigation ──────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#page-${btn.dataset.page}`).classList.add('active');
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const d = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'apiModel']);
  if (d.apiUrl)   $('#apiUrl').value   = d.apiUrl;
  if (d.apiKey)   $('#apiKey').value   = d.apiKey;
  if (d.apiModel) $('#apiModel').value = d.apiModel;
  const ok = !!(d.apiUrl && d.apiKey && d.apiModel);
  const badge = $('#apiStatusBadge');
  if (ok) {
    badge.classList.add('configured');
    $('#apiStatusText').textContent = '已配置: ' + d.apiModel;
  } else {
    badge.classList.remove('configured');
    $('#apiStatusText').textContent = '未配置 API，请先设置';
  }
  return ok;
}

$('#saveSettingsBtn').addEventListener('click', async () => {
  const apiUrl  = $('#apiUrl').value.trim();
  const apiKey  = $('#apiKey').value.trim();
  const apiModel= $('#apiModel').value.trim();
  if (!apiUrl || !apiKey || !apiModel) { showToast('请填写完整配置', false); return; }

  // Warn about common URL mistakes
  if (!apiUrl.startsWith('http')) {
    showToast('API 地址须以 http:// 或 https:// 开头', false); return;
  }
  if (!apiUrl.includes('/')) {
    showToast('API 地址格式不正确，请参考下方示例', false); return;
  }

  await chrome.storage.sync.set({ apiUrl, apiKey, apiModel });
  await loadSettings();
  showToast('配置已保存 ✓');
});

function showToast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = ok ? 'var(--accent2)' : 'var(--red)';
  t.style.color       = ok ? 'var(--accent2)' : 'var(--red)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function setStatus(type, html) {
  const d = $('#statusDot');
  d.className = 'status-dot' + (type ? ' ' + type : '');
  $('#statusText').innerHTML = html;
}

function setLoading(on) {
  const btn = $('#analyzeBtn');
  btn.disabled = on;
  $('#analyzeBtnIcon').outerHTML = on
    ? '<div class="spinner" id="analyzeBtnIcon"></div>'
    : '<span id="analyzeBtnIcon">⚡</span>';
  $('#analyzeBtnText').textContent = on ? '分析中...' : '重新分析';
}

// ── Ensure content script is alive in this tab ───────────────────────────────
// This is the fix for "must refresh" bug.
// We inject the script programmatically if the tab doesn't respond to ping.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true; // already alive
  } catch (_) {
    // Not injected yet — inject now
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      // Brief wait for script to initialize
      await new Promise(r => setTimeout(r, 80));
      
      return true;
    } catch (e) {
      console.error('inject failed', e);
      return false;
    }
  }
}

// ── Main analyze ─────────────────────────────────────────────────────────────
$('#analyzeBtn').addEventListener('click', async () => {
  const ok = await loadSettings();
  if (!ok) {
    showToast('请先配置 API 设置', false);
    $('[data-page="settings"]').click();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus('loading', '正在检查脚本注入...');
  setLoading(true);

  // ① Ensure content script exists (fixes the refresh bug)
  const injected = await ensureContentScript(tab.id);
  if (!injected) {
    setStatus('error', '无法注入脚本，请检查页面权限');
    setLoading(false);
    showToast('页面不允许注入脚本', false);
    return;
  }

  // 等待脚本初始化
  await new Promise(r => setTimeout(r, 500));

  // 显示加载状态的侧边栏
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'showLoading' });
    console.log('成功发送 showLoading 消息');
  } catch (error) {
    console.error('发送 showLoading 消息失败:', error);
    showToast('无法显示侧边栏', false);
    // 即使失败也继续执行分析
  }
  
  // 关闭弹出窗口，让分析在后台执行
  setTimeout(() => {
    window.close();
  }, 500);

  // 提取文章内容
  let extractResult;
  try {
    [extractResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent
    });
  } catch (e) {
    setStatus('error', '提取失败: ' + e.message.slice(0, 40));
    setLoading(false);
    return;
  }

  const content = extractResult?.result;
  if (!content || content.text.length < 100) {
    setStatus('error', '未找到有效文章内容');
    setLoading(false);
    showToast('未检测到文章内容', false);
    return;
  }

  // 获取设置
  const settings = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'apiModel']);
  
  // 发送分析任务到 background script
  chrome.runtime.sendMessage({
    action: 'analyzeArticle',
    payload: {
      tabId: tab.id,
      settings: settings,
      content: content
    }
  }, (response) => {
    if (response && response.ok) {
      console.log('分析任务已发送到后台');
    } else {
      console.error('发送分析任务失败:', response?.error || '未知错误');
      setStatus('error', '发送分析任务失败');
      showToast('发送分析任务失败', false);
      setLoading(false);
    }
  });
  
  // 无论如何都设置 loading 状态为 false，因为分析将在后台执行
  setLoading(false);
});

// ── Popup result (compact, just density + copy) ───────────────────────────────
function renderPopupResult(data, charCount) {
  const area = $('#resultArea');

  area.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
      <span style="font-size:11px;color:var(--text-dim)">${charCount} 字</span>
    </div>
    <div class="action-row">
      <button class="action-btn" id="popCopy">⎘ 复制摘要</button>
      <button class="action-btn" id="popClose">✕ 关闭侧边栏</button>
    </div>
    <p style="font-size:11px;color:var(--text-dim);line-height:1.6;margin-top:4px">
      ✦ 摘要、目录、标注已显示在<strong style="color:var(--text)">文章页面右侧</strong>，可拖动侧边栏位置
    </p>
  `;

  $('#popCopy').addEventListener('click', () => {
    navigator.clipboard.writeText(data.summary || '').then(() => showToast('摘要已复制 ✓'));
  });

  $('#popClose').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'removeSidebar' });
    showToast('侧边栏已关闭');
  });
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Extract page content (runs in page context) ───────────────────────────────
function extractPageContent() {
  const selectors = [
    '#js_content', '.rich_media_content',
    '.Post-RichTextContainer', '.RichText',
    '.article-content', '.common-content',
    '.ArticleContent', '.article-body',
    'article', '[role="main"]',
    '.post-content', '.entry-content',
    '.content-area', '.main-content', 'main'
  ];
  let el = null;
  for (const s of selectors) {
    const found = document.querySelector(s);
    if (found && found.innerText.trim().length > 200) { el = found; break; }
  }
  if (!el) {
    let best = null, maxLen = 0;
    document.querySelectorAll('div,article,section').forEach(c => {
      if (c === document.body) return;
      const len = c.innerText.trim().length;
      if (len > maxLen && len < 100000) { maxLen = len; best = c; }
    });
    el = best;
  }
  if (!el) return null;

  // Standard headings
  const headings = [];
  el.querySelectorAll('h1,h2,h3,h4').forEach(h => {
    const text = h.innerText.trim();
    if (text && text.length < 100) headings.push({ level: parseInt(h.tagName[1]), text });
  });

  // If no standard headings, detect bold/large pseudo-headings
  if (headings.length === 0) {
    el.querySelectorAll('p, section > p').forEach(p => {
      const text = p.innerText.trim();
      if (!text || text.length > 80 || text.length < 2) return;
      const s = window.getComputedStyle(p);
      const bold = parseInt(s.fontWeight) >= 600;
      const large = parseFloat(s.fontSize) >= 16;
      const hasBold = p.querySelector('strong,b') &&
        p.querySelector('strong,b').innerText.trim() === text;
      if (bold || large || hasBold) headings.push({ level: 2, text });
    });
  }

  const fullText = el.innerText.trim();
  return {
    // Send up to 12000 chars to AI (covers most articles fully)
    text: fullText.slice(0, 12000),
    // Also send a second chunk if article is longer
    text2: fullText.length > 12000 ? fullText.slice(12000, 20000) : '',
    fullLength: fullText.length,
    headings
  };
}

// ── Call AI API ───────────────────────────────────────────────────────────────
async function callAI(settings, content) {
  if (!settings.apiUrl)   throw new Error('未填写 API 地址');
  if (!settings.apiKey)   throw new Error('未填写 API Key');
  if (!settings.apiModel) throw new Error('未填写模型名称');

  let apiUrl = settings.apiUrl.trim();
  if (/^https?:\/\/[^/]+\/?$/.test(apiUrl))  apiUrl = apiUrl.replace(/\/$/, '') + '/v1/chat/completions';
  if (/\/v1\/?$/.test(apiUrl))               apiUrl = apiUrl.replace(/\/v1\/?$/, '/v1/chat/completions');

  const doFetch = async (text, isSecondPass) => {
    const prompt = isSecondPass
      ? `请从文章后半部分继续提取标注，只返回JSON（不含其他文字）。

文章后半段：
${text}

格式：{"annotations":[{"type":"argument","text":"原文原句"},{"type":"fact","text":"原文原句"},{"type":"opinion","text":"原文原句"}],"terms":[{"term":"原文词语","explanation":"20字内"}]}

要求：text必须是此段原文原句，只输出JSON。`
      : `你是专业文章分析助手，只返回JSON，不含其他文字或代码块。

你需要对以下文章内容进行结构化摘要、目录提炼、重点标注与术语解释。严格按照指定JSON格式输出，只返回JSON，不添加任何多余文字、注释或说明。
文章内容：

${text}  // 待处理的文章原文占位符，替换为实际文章内容

输出格式：

{

  "summary": "150字以内摘要",  // 全文精炼摘要，控制在150字内，概括核心内容
  "toc": [  // 文章目录，按自然逻辑拆分4~8个章节

    {

      "title": "简短章节标题（10字以内，概括这部分讲什么）",  // AI提炼语义标题，不照搬原文，≤10字
      "desc": "一句话说明这部分的核心内容（20字以内）",  // 章节核心，一句话≤20字
      "anchor": "该部分开头的原文片段（10-20个字，必须是原文中连续出现的文字，用于定位跳转）"  // 原文连续片段，10-20字，用于定位跳转

    }
  ],
  "annotations": [  // 重点内容标注，按类型摘抄原文，不可修改
    {"type": "argument", "text": "原文原句"},  // argument：核心论点、分论点类原句
    {"type": "fact", "text": "原文原句"},  // fact：事实、数据、案例类原句
    {"type": "opinion", "text": "原文原句"}  // opinion：观点、评价类原句
  ],
  "terms": [{"term": "原文词语", "explanation": "20字内"}]  // 核心术语，原文词语+20字内简明解释
}
// 约束规则：1.toc需4-8个章节，title为语义概括，anchor必为原文片段；2.annotations需一字不差复制原文；3.仅输出合法JSON，无多余内容`;

    let res;
    try {
      // 添加超时处理
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
      
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey.trim() },
        body: JSON.stringify({
          model: settings.apiModel.trim(),
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
    } catch(e) {
      if (e.name === 'AbortError')
        throw new Error('API 请求超时，请检查网络连接或 API 服务状态');
      if (e.message.includes('Failed to fetch'))
        throw new Error('网络请求失败\n① API 地址是否正确\n② 是否需要代理');
      throw new Error('请求异常: ' + e.message);
    }

    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch(_) {}
      let hint = ''; try { hint = JSON.parse(body)?.error?.message || ''; } catch(_) { hint = body.slice(0, 200); }
      const codes = {
        400:'请求格式错误，模型名称可能有误', 401:'API Key 无效或过期',
        403:'Key 无权访问此模型', 404:'API 地址或模型不存在（URL 须含 /chat/completions）',
        429:'请求频率超限，稍后重试', 500:'API 服务器内部错误', 503:'API 暂时不可用'
      };
      throw new Error((codes[res.status] || 'HTTP ' + res.status) + (hint ? '\n' + hint.slice(0, 120) : ''));
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
    if (!raw) throw new Error('API 返回内容为空');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 返回格式非 JSON，请重试');
    return JSON.parse(m[0]);
  };

  // First pass: main analysis on text chunk 1
  const result = await doFetch(content.text, false);
  result.annotations = result.annotations || [];
  result.terms       = result.terms       || [];

  // Second pass: extract extra annotations from article tail (non-fatal)
  if (content.text2 && content.text2.length > 100) {
    try {
      const r2 = await doFetch(content.text2, true);
      if (r2.annotations) result.annotations.push(...r2.annotations);
      if (r2.terms)       result.terms.push(...r2.terms);
    } catch(e) { console.warn('[AI Reader] 2nd pass skipped:', e.message); }
  }

  return result;
}


// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();

// ── Settings extras (test + presets) ─────────────────────────────────────────
function showErrorDetail(msg) {
  const box = document.getElementById('errorDetail');
  if (!box) return;
  if (msg) { box.textContent = msg; box.style.display = 'block'; }
  else box.style.display = 'none';
}

const testBtn = document.getElementById('testApiBtn');
if (testBtn) {
  testBtn.addEventListener('click', async () => {
    const apiUrl  = $('#apiUrl').value.trim();
    const apiKey  = $('#apiKey').value.trim();
    const apiModel= $('#apiModel').value.trim();
    if (!apiUrl || !apiKey || !apiModel) { showToast('请先填写配置', false); return; }
    testBtn.textContent = '测试中…'; testBtn.disabled = true;
    showErrorDetail('');
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: apiModel, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
      });
      if (res.ok) {
        showToast('连接成功 ✓');
      } else {
        let body = '';
        try { body = await res.text(); } catch(_){}
        let hint = '';
        try { hint = JSON.parse(body)?.error?.message || ''; } catch(_){ hint = body.slice(0, 300); }
        const statusHints = {
          400: '请求格式错误，模型名称可能不支持',
          401: 'API Key 无效或已过期',
          403: 'API Key 无权访问该模型',
          404: 'API 地址不存在，请检查 URL 是否完整（须含 /chat/completions）',
          429: '请求太频繁，稍后再试',
        };
        const msg = (statusHints[res.status] || 'HTTP ' + res.status) + (hint ? '\n\n' + hint : '');
        showToast('连接失败: ' + res.status, false);
        showErrorDetail(msg);
      }
    } catch(e) {
      showToast('网络错误', false);
      showErrorDetail('网络请求失败: ' + e.message + '\n\n可能原因：\n· URL 填写错误\n· 需要代理访问');
    }
    testBtn.textContent = '测试'; testBtn.disabled = false;
  });
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $('#apiUrl').value   = btn.dataset.url;
    $('#apiModel').value = btn.dataset.model;
    showErrorDetail('');
    showToast('已填入 ' + btn.textContent + ' 配置，请填写 API Key');
  });
});
