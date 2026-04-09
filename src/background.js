// background.js - Service Worker
// Popup 无法直接 fetch 跨域 API，统一通过 background 转发

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI 阅读增强器 已安装');
});

// 监听来自 popup 的 API 请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'callAPI') {
    handleAPICall(msg.payload)
      .then(result => sendResponse({ ok: true, data: result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // 保持消息通道开启，等待异步响应
  } else if (msg.action === 'analyzeArticle') {
    handleAnalyzeArticle(msg.payload)
      .then(result => sendResponse({ ok: true, data: result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // 保持消息通道开启，等待异步响应
  }
});

async function handleAPICall({ apiUrl, apiKey, apiModel, prompt }) {
  // 自动修正常见的 URL 错误
  let url = apiUrl.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  // 如果用户只填了域名，自动补全路径
  if (!url.includes('/chat/completions') && !url.includes('/messages')) {
    if (url.endsWith('/')) url = url.slice(0, -1);
    url = url + '/v1/chat/completions';
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  // Anthropic API 用不同的 header
  if (url.includes('anthropic.com')) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    delete headers['Authorization'];
  }

  const body = url.includes('anthropic.com')
    ? { model: apiModel, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }
    : { model: apiModel, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    let errText = '';
    try { errText = await response.text(); } catch (e) {}
    // 提供更友好的错误提示
    const hints = {
      401: '认证失败，请检查 API Key 是否正确',
      403: 'API Key 无权限，请确认账户状态',
      404: 'API 地址不存在，请检查请求 URL 格式',
      429: '请求太频繁，请稍后再试',
      500: 'API 服务器内部错误，请稍后重试',
    };
    const hint = hints[response.status] || errText.slice(0, 120);
    throw new Error(`${response.status}: ${hint}`);
  }

  const data = await response.json();

  // 兼容 OpenAI / Anthropic 响应格式
  const text = data.choices?.[0]?.message?.content
    || data.content?.[0]?.text
    || '';

  if (!text) throw new Error('API 返回内容为空，请检查模型名称是否正确');

  // 提取 JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 未返回标准 JSON，请重试');

  return JSON.parse(jsonMatch[0]);
}

async function handleAnalyzeArticle({ tabId, settings, content }) {
  console.log('开始分析文章:', tabId);
  
  // 构建第一个 prompt
  const firstPrompt = `你是专业文章分析助手，只返回JSON，不含其他文字或代码块。

文章内容：
${content.text}

输出格式：
{
  "summary": "150字以内摘要",  // 提炼全文核心主张与结论，控制在150字内，不罗列细节
  "toc": [  // 文章目录，按内容逻辑拆分4~8个章节
    {
      "title": "简短章节标题（≤10字，语义概括，勿照搬原文）",
      "desc": "该部分核心内容，一句话≤20字",
      "anchor": "该部分开头的连续原文片段（12-24字，保留原字原标点，不得改写）"  // 用于跳转定位，须能通过字符串搜索直接命中
    }
  ],
  "annotations": [  // 全面标注重点原句，覆盖所有关键信息——读者仅靠浏览标注即可掌握文章核心
    {"type": "argument", "text": "原文原句"},  // argument：支撑全文或段落核心观点的主要论点/论据句
    {"type": "fact", "text": "原文原句"},      // fact：含具体数字、案例或可验证陈述的事实/数据句
    {"type": "opinion", "text": "原文原句"}   // opinion：作者的主观判断、立场或价值倾向句
  ],
  "terms": [{"term": "原文词语", "explanation": "20字内简明解释"}]  // 专业术语或关键概念，仅提取读者可能不熟悉的词
}
// 约束规则：1.toc需4-8个章节，title为语义概括，anchor必须是该章节开头的连续原文且可通过字符串搜索命中；2.annotations中text须一字不差复制原文，确保所有重点内容均被标注，使标注串联后能完整呈现文章核心信息；3.仅输出合法JSON，无多余内容`;

  // 构建第二个 prompt（如果需要）
  let secondPrompt = '';
  if (content.text2 && content.text2.length > 100) {
    secondPrompt = `请从文章后半部分继续提取标注，只返回JSON（不含其他文字）。

文章后半段：
${content.text2}

格式：{"annotations":[{"type":"argument","text":"原文原句"},{"type":"fact","text":"原文原句"},{"type":"opinion","text":"原文原句"}],"terms":[{"term":"原文词语","explanation":"20字内"}]}

要求：text必须是此段原文原句，只输出JSON。`;
  }

  try {
    // 调用 AI API 分析第一段
    console.log('分析文章第一段');
    const firstResult = await handleAPICall({
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
      apiModel: settings.apiModel,
      prompt: firstPrompt
    });
    
    // 确保结果结构完整
    firstResult.annotations = firstResult.annotations || [];
    firstResult.terms = firstResult.terms || [];
    
    // 如果有第二段，分析第二段
    if (secondPrompt) {
      console.log('分析文章第二段');
      try {
        const secondResult = await handleAPICall({
          apiUrl: settings.apiUrl,
          apiKey: settings.apiKey,
          apiModel: settings.apiModel,
          prompt: secondPrompt
        });
        
        if (secondResult.annotations) {
          firstResult.annotations.push(...secondResult.annotations);
        }
        if (secondResult.terms) {
          firstResult.terms.push(...secondResult.terms);
        }
      } catch (e) {
        console.warn('第二段分析失败:', e.message);
        // 继续执行，不影响第一段的分析结果
      }
    }
    
    // 发送结果到 content script
    console.log('发送分析结果到 content script');
    await chrome.tabs.sendMessage(tabId, {
      action: 'annotate',
      annotations: firstResult.annotations || [],
      terms: firstResult.terms || [],
      summary: firstResult.summary || '',
      toc: firstResult.toc || []
    });
    
    console.log('分析完成');
    return firstResult;
  } catch (e) {
    console.error('分析文章失败:', e);
    throw e;
  }
}

