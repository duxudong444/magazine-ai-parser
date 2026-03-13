import React, { useState, useEffect } from 'react';
import { UploadCloud, FileText, CheckCircle, AlertCircle, Loader2, Download, Settings, X, Eye } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const DEFAULT_PROMPT = `你是一个专业的英语杂志翻译和解析助手。请对以下文章进行深度解析。
要求：
1. 提取文章的核心观点和主要内容摘要（中文）。
2. 逐段或按逻辑块进行中英对照翻译。
3. 提取文章中的核心词汇、短语，并给出解释和例句。
4. 分析文章的写作结构和亮点。
请使用 Markdown 格式输出。`;

const ENV_PROVIDER = import.meta.env.VITE_AI_PROVIDER as 'gemini' | 'deepseek' | undefined;
const ENV_GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const ENV_GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-3-flash-preview';
const ENV_DEEPSEEK_KEY = import.meta.env.VITE_DEEPSEEK_API_KEY || '';
const ENV_DEEPSEEK_MODEL = import.meta.env.VITE_DEEPSEEK_MODEL || 'deepseek-chat';
const ENV_GLOBAL_PROMPT = import.meta.env.VITE_GLOBAL_PROMPT || DEFAULT_PROMPT;
const TOC_CANDIDATE_PAGES = 6;
const TOC_PAGE_CHAR_LIMIT = 2500;
const ARTICLE_FAST_CHAR_LIMIT = 16000;
const ARTICLE_STANDARD_CHAR_LIMIT = 32000;

function clipText(text: string, limit: number) {
  const normalized = text.replace(/\u0000/g, '').trim();
  if (normalized.length <= limit) return normalized;

  const head = Math.floor(limit * 0.65);
  const tail = limit - head;
  return `${normalized.slice(0, head)}\n\n...[中间内容已省略以提升处理速度]...\n\n${normalized.slice(-tail)}`;
}

function pickLikelyTocPages(pages: string[]) {
  const keywordRegex = /\b(contents|table of contents|in this issue)\b|目录|本期|栏目/i;
  const candidates = pages
    .slice(0, 12)
    .map((text, index) => ({ index, text }))
    .filter(page => keywordRegex.test(page.text));

  const selected = (candidates.length > 0 ? candidates : pages.slice(0, TOC_CANDIDATE_PAGES).map((text, index) => ({ index, text })))
    .slice(0, TOC_CANDIDATE_PAGES);

  return selected
    .map(({ text, index }) => `--- PAGE ${index + 1} ---\n${clipText(text, TOC_PAGE_CHAR_LIMIT)}`)
    .join('\n');
}

interface JobState {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: string;
  result?: string;
  error?: string;
}

interface Article {
  id: number;
  title_en: string;
  title_zh: string;
  subtitle_en?: string;
  subtitle_zh?: string;
  start_page: number;
  end_page: number;
  status: 'idle' | 'parsing' | 'completed' | 'error';
  content?: string;
  error?: string;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<JobState | null>(null);
  
  // Settings
  const [provider, setProvider] = useState<'gemini' | 'deepseek'>(ENV_PROVIDER || 'gemini');
  const [apiKey, setApiKey] = useState(ENV_GEMINI_KEY);
  const [model, setModel] = useState(ENV_GEMINI_MODEL);
  const [deepseekApiKey, setDeepseekApiKey] = useState(ENV_DEEPSEEK_KEY);
  const [deepseekModel, setDeepseekModel] = useState(ENV_DEEPSEEK_MODEL);
  const [globalPrompt, setGlobalPrompt] = useState(ENV_GLOBAL_PROMPT);
  const [fastMode, setFastMode] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  // PDF Data
  const [pdfPages, setPdfPages] = useState<string[] | null>(null);
  const [toc, setToc] = useState<Article[]>([]);
  const [selectedArticles, setSelectedArticles] = useState<Set<number>>(new Set());
  const [viewingArticle, setViewingArticle] = useState<Article | null>(null);

  // Load settings from localStorage
  useEffect(() => {
    const savedProvider = localStorage.getItem('ai_provider') as 'gemini' | 'deepseek';
    if (savedProvider) setProvider(savedProvider);

    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) setApiKey(savedKey);
    
    const savedModel = localStorage.getItem('gemini_model');
    // Fix invalid model that might have been saved previously
    if (savedModel === 'gemini-3.1-flash-preview') {
      setModel('gemini-3-flash-preview');
      localStorage.setItem('gemini_model', 'gemini-3-flash-preview');
    } else if (savedModel) {
      setModel(savedModel);
    }

    const savedDsKey = localStorage.getItem('deepseek_api_key');
    if (savedDsKey) setDeepseekApiKey(savedDsKey);

    const savedDsModel = localStorage.getItem('deepseek_model');
    if (savedDsModel) setDeepseekModel(savedDsModel);
    
    const savedPrompt = localStorage.getItem('global_prompt');
    if (savedPrompt) setGlobalPrompt(savedPrompt);

    const savedFastMode = localStorage.getItem('fast_mode');
    if (savedFastMode !== null) setFastMode(savedFastMode === 'true');
  }, []);

  const saveSettings = () => {
    localStorage.setItem('ai_provider', provider);
    localStorage.setItem('gemini_api_key', apiKey);
    localStorage.setItem('gemini_model', model);
    localStorage.setItem('deepseek_api_key', deepseekApiKey);
    localStorage.setItem('deepseek_model', deepseekModel);
    localStorage.setItem('global_prompt', globalPrompt);
    localStorage.setItem('fast_mode', String(fastMode));
    setShowSettings(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      if (selectedFile.type !== 'application/pdf') {
        alert('请上传 PDF 文件');
        return;
      }
      if (selectedFile.size > 100 * 1024 * 1024) {
        alert('文件大小不能超过 100MB');
        return;
      }
      setFile(selectedFile);
      resetState();
    }
  };

  const resetState = () => {
    setJobId(null);
    setJobState(null);
    setPdfPages(null);
    setToc([]);
    setSelectedArticles(new Set());
  };

  const startUpload = async () => {
    if (!file) return;
    if (provider === 'gemini' && !apiKey) {
      alert('请先在设置中配置您的 Gemini API Key');
      setShowSettings(true);
      return;
    }
    if (provider === 'deepseek' && !deepseekApiKey) {
      alert('请先在设置中配置您的 DeepSeek API Key');
      setShowSettings(true);
      return;
    }
    
    resetState();
    setJobState({ id: 'uploading', status: 'pending', progress: '正在分块上传文件至服务器，请稍候...' });

    const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB chunks to avoid proxy limits
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const uploadId = Math.random().toString(36).substring(2) + Date.now().toString(36);

    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', i.toString());
        formData.append('totalChunks', totalChunks.toString());

        setJobState({ id: 'uploading', status: 'pending', progress: `正在上传文件... (${Math.round(((i + 1) / totalChunks) * 100)}%)` });

        const response = await fetch('/api/upload-chunk', {
          method: 'POST',
          body: formData,
        });
        
        const responseText = await response.text();
        
        if (!response.ok) {
          let errorMessage = '上传失败';
          try {
            const errorJson = JSON.parse(responseText);
            errorMessage = errorJson.error || errorMessage;
          } catch (e) {}
          throw new Error(errorMessage);
        }

        if (i === totalChunks - 1) {
          const data = JSON.parse(responseText);
          setJobId(data.jobId);
        }
      }
    } catch (error: any) {
      setJobState({ id: 'error', status: 'error', progress: '', error: error.message });
    }
  };

  // Poll for backend PDF parsing job
  useEffect(() => {
    if (!jobId) return;

    const eventSource = new EventSource(`/api/status/${jobId}`);
    
    eventSource.onmessage = async (event) => {
      const data: JobState = JSON.parse(event.data);
      
      if (data.status === 'completed') {
        eventSource.close();
        try {
          const res = await fetch(`/api/result/${jobId}`);
          if (!res.ok) throw new Error('Failed to fetch result');
          const resultData = await res.json();
          const pages: string[] = JSON.parse(resultData.result);
          setPdfPages(pages);
          setJobState(null); // Clear backend job state
          extractTOCFromPages(pages);
        } catch (e) {
          setJobState({ ...data, status: 'error', error: '获取 PDF 文本失败' });
        }
      } else if (data.status === 'error') {
        eventSource.close();
        setJobState(data);
      } else {
        setJobState(data);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setJobState(prev => prev ? { ...prev, status: 'error', error: '连接断开' } : null);
    };

    return () => eventSource.close();
  }, [jobId]);

  const extractTOCFromPages = async (pages: string[]) => {
    setJobState({ id: 'extracting_toc', status: 'processing', progress: '正在使用 AI 提取目录（极速模式会优先扫描疑似目录页）...' });
    try {
      const text = pickLikelyTocPages(pages);
      
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 180000);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('提取目录超时 (180秒)。可能是由于 API 速率限制，请稍后重试或更换模型。')), 180000);
      });

      let responseText = '';

      if (provider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey });
        const response = await Promise.race([
          ai.models.generateContent({
            model: model,
            contents: `Extract the table of contents from the following magazine pages. Return a JSON array of objects with keys 'title_en' (English title), 'title_zh' (Chinese translated title), 'subtitle_en' (English subtitle, optional), 'subtitle_zh' (Chinese translated subtitle, optional), 'start_page' (number), 'end_page' (number). 
IMPORTANT RULES:
1. Do NOT use section names or column headers (栏目标题) as article titles. You MUST extract the actual specific article titles (文章标题).
2. If an article has a subtitle (副标题), extract it into 'subtitle_en' and 'subtitle_zh'.
3. If end_page is unknown, estimate it or use start_page. 
4. Only include actual articles, skip ads.
5. Prefer speed. Use only the visible evidence in the supplied pages; do not infer extra articles.\n\n${text}`,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title_en: { type: Type.STRING },
                    title_zh: { type: Type.STRING },
                    subtitle_en: { type: Type.STRING },
                    subtitle_zh: { type: Type.STRING },
                    start_page: { type: Type.INTEGER },
                    end_page: { type: Type.INTEGER }
                  },
                  required: ['title_en', 'title_zh', 'start_page', 'end_page']
                }
              }
            }
          }),
          timeoutPromise
        ]);
        clearTimeout(timeoutId);
        responseText = response.text || '[]';
      } else {
        const response = await Promise.race([
          fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${deepseekApiKey}`
            },
            signal: abortController.signal,
            body: JSON.stringify({
              model: deepseekModel,
              messages: [
                { role: 'system', content: 'You are a helpful assistant that extracts table of contents from text. You must reply ONLY with a valid JSON array.' },
                { role: 'user', content: `Extract the table of contents from the following magazine pages. Return a JSON array of objects with keys 'title_en' (English title), 'title_zh' (Chinese translated title), 'subtitle_en' (English subtitle, optional), 'subtitle_zh' (Chinese translated subtitle, optional), 'start_page' (number), 'end_page' (number). 
IMPORTANT RULES:
1. Do NOT use section names or column headers (栏目标题) as article titles. You MUST extract the actual specific article titles (文章标题).
2. If an article has a subtitle (副标题), extract it into 'subtitle_en' and 'subtitle_zh'.
3. If end_page is unknown, estimate it or use start_page. 
4. Only include actual articles, skip ads.
5. Prefer speed. Use only the visible evidence in the supplied pages; do not infer extra articles.\n\n${text}` }
              ],
              response_format: { type: 'json_object' }
            })
          }),
          timeoutPromise
        ]);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error?.message || `DeepSeek API Error: ${response.status}`);
        }

        const data = await response.json();
        responseText = data.choices[0].message.content;
      }
      
      // Extract JSON array from response text (handles markdown blocks if any)
      let extractedToc = [];
      try {
        const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const jsonStr = match ? match[1] : responseText;
        const parsed = JSON.parse(jsonStr);
        // DeepSeek json_object might wrap the array in an object
        extractedToc = Array.isArray(parsed) ? parsed : (parsed.toc || parsed.data || []);
      } catch (e) {
        console.error("Failed to parse JSON:", responseText);
        extractedToc = [];
      }

      if (extractedToc.length === 0) {
        extractedToc = [{ title_en: 'Full Document', title_zh: '全文分析', start_page: 1, end_page: pages.length }];
      }
      
      extractedToc = extractedToc.sort((a: any, b: any) => a.start_page - b.start_page);
      for (let i = 0; i < extractedToc.length; i++) {
        if (!extractedToc[i].end_page || extractedToc[i].end_page < extractedToc[i].start_page) {
          extractedToc[i].end_page = (i < extractedToc.length - 1) ? Math.max(extractedToc[i].start_page, extractedToc[i+1].start_page - 1) : pages.length;
        }
        extractedToc[i].id = i;
        extractedToc[i].status = 'idle';
      }
      
      setToc(extractedToc);
      setJobState(null);
    } catch (error: any) {
      console.error("TOC extraction error:", error);
      const errorMessage = error instanceof Error ? error.message : (error?.message || String(error));
      setJobState({ id: 'error', status: 'error', progress: '', error: '提取目录失败: ' + errorMessage });
    }
  };

  const parseArticle = async (articleId: number) => {
    if (!pdfPages || (provider === 'gemini' && !apiKey) || (provider === 'deepseek' && !deepseekApiKey)) return;
    
    setToc(prev => prev.map(a => a.id === articleId ? { ...a, status: 'parsing', error: undefined } : a));
    
    const article = toc.find(a => a.id === articleId);
    if (!article) return;

    try {
      const startIdx = Math.max(0, article.start_page - 1);
      const endIdx = Math.min(pdfPages.length, article.end_page);
      const fullArticleText = pdfPages.slice(startIdx, endIdx).join('\n');
      const articleCharLimit = fastMode ? ARTICLE_FAST_CHAR_LIMIT : ARTICLE_STANDARD_CHAR_LIMIT;
      const articleText = clipText(fullArticleText, articleCharLimit);
      const promptPrefix = fastMode
        ? '请优先追求速度：允许基于可见文本做压缩总结，保留核心摘要、重点词汇和关键段落翻译即可。'
        : '请尽量完整分析。';

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 300000);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('请求超时 (300秒)。可能是由于 API 速率限制 (Rate Limit) 导致请求被挂起，或者模型处理时间过长。请稍后重试。')), 300000);
      });

      let responseText = '';

      if (provider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey });
        const response = await Promise.race([
          ai.models.generateContent({
            model: model,
            contents: `${promptPrefix}\n\n${globalPrompt}\n\nArticle Title: ${article.title_en}${article.subtitle_en ? `: ${article.subtitle_en}` : ''} (${article.title_zh}${article.subtitle_zh ? `：${article.subtitle_zh}` : ''})\n\nArticle Text:\n${articleText}`,
          }),
          timeoutPromise
        ]);
        clearTimeout(timeoutId);
        responseText = response.text || '';
      } else {
        const response = await Promise.race([
          fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${deepseekApiKey}`
            },
            signal: abortController.signal,
            body: JSON.stringify({
              model: deepseekModel,
              messages: [
                { role: 'system', content: `${promptPrefix}\n\n${globalPrompt}` },
                { role: 'user', content: `Article Title: ${article.title_en}${article.subtitle_en ? `: ${article.subtitle_en}` : ''} (${article.title_zh}${article.subtitle_zh ? `：${article.subtitle_zh}` : ''})\n\nArticle Text:\n${articleText}` }
              ]
            })
          }),
          timeoutPromise
        ]);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error?.message || `DeepSeek API Error: ${response.status}`);
        }

        const data = await response.json();
        responseText = data.choices[0].message.content;
      }

      setToc(prev => prev.map(a => a.id === articleId ? { ...a, status: 'completed', content: responseText } : a));
      
      // Automatically select successfully parsed articles
      setSelectedArticles(prev => {
        const next = new Set(prev);
        next.add(articleId);
        return next;
      });
    } catch (error: any) {
      console.error("Parse error:", error);
      const errorMessage = error instanceof Error ? error.message : (error?.message || String(error));
      setToc(prev => prev.map(a => a.id === articleId ? { ...a, status: 'error', error: errorMessage } : a));
    }
  };

  const toggleArticleSelection = (id: number) => {
    setSelectedArticles(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const exportMarkdown = () => {
    const selected = toc.filter(a => selectedArticles.has(a.id) && a.status === 'completed');
    if (selected.length === 0) {
      alert('请先选择至少一篇已解析完成的文章');
      return;
    }

    let md = '# 杂志解析报告\n\n## 已选文章目录\n\n';
    selected.forEach(a => {
      md += `- ${a.title_en}${a.subtitle_en ? `: ${a.subtitle_en}` : ''} (${a.title_zh}${a.subtitle_zh ? `：${a.subtitle_zh}` : ''})\n`;
    });
    md += '\n---\n\n';

    selected.forEach(a => {
      md += `## ${a.title_en}${a.subtitle_en ? `: ${a.subtitle_en}` : ''} (${a.title_zh}${a.subtitle_zh ? `：${a.subtitle_zh}` : ''})\n\n`;
      md += `${a.content}\n\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Magazine_Analysis_${new Date().getTime()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-6 h-6 text-indigo-600" />
            <h1 className="text-xl font-bold text-slate-800">Magazine AI Parser</h1>
          </div>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {showSettings && (
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-8">
            <h2 className="text-lg font-semibold mb-4">API 设置 (本地保存)</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">AI 提供商</label>
                <select 
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'gemini' | 'deepseek')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </div>

              {provider === 'gemini' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Gemini API Key</label>
                    <input 
                      type="password" 
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="AIzaSy..."
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">模型选择</label>
                    <select 
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                      <option value="gemini-3-flash-preview">Gemini 3 Flash (推荐，速度快)</option>
                      <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (适合复杂推理)</option>
                      <option value="gemini-flash-latest">Gemini Flash Latest</option>
                    </select>
                  </div>
                </>
              )}

              {provider === 'deepseek' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">DeepSeek API Key</label>
                    <input 
                      type="password" 
                      value={deepseekApiKey}
                      onChange={(e) => setDeepseekApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">模型选择</label>
                    <select 
                      value={deepseekModel}
                      onChange={(e) => setDeepseekModel(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                      <option value="deepseek-chat">DeepSeek Chat (V3) - 推荐</option>
                      <option value="deepseek-reasoner">DeepSeek Reasoner (R1)</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">全局解析提示词 (Prompt)</label>
                <textarea 
                  value={globalPrompt}
                  onChange={(e) => setGlobalPrompt(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y"
                />
              </div>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-slate-700">极速模式</div>
                  <div className="text-xs text-slate-500">默认开启。目录只扫描疑似目录页，文章解析会裁剪超长文本，速度明显更快。</div>
                </div>
                <input
                  type="checkbox"
                  checked={fastMode}
                  onChange={(e) => setFastMode(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
              </label>
              <button 
                onClick={saveSettings}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
              >
                保存设置
              </button>
            </div>
          </div>
        )}

        {!pdfPages && !jobState && (
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 text-center">
            <div className="max-w-md mx-auto">
              <UploadCloud className="w-12 h-12 text-indigo-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">上传英文杂志 PDF</h2>
              <p className="text-slate-500 mb-6">支持最大 100MB 的 PDF 文件。所有 AI 解析将在您的浏览器端完成，保障您的数据与 API Key 安全。</p>
              
              <input
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
                className="hidden"
                id="file-upload"
              />
              <label
                htmlFor="file-upload"
                className="inline-block px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium cursor-pointer hover:bg-indigo-700 transition-colors shadow-sm"
              >
                选择 PDF 文件
              </label>
              
              {file && (
                <div className="mt-6 p-4 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                  <span className="text-sm font-medium truncate max-w-[200px]">{file.name}</span>
                  <button 
                    onClick={startUpload}
                    className="px-4 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-200"
                  >
                    开始处理
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {jobState && (
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 text-center">
            {jobState.status === 'error' ? (
              <div className="text-red-500">
                <AlertCircle className="w-12 h-12 mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">处理出错</h3>
                <p className="text-sm">{jobState.error}</p>
                <button 
                  onClick={resetState}
                  className="mt-4 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                >
                  重新开始
                </button>
              </div>
            ) : (
              <div className="text-indigo-600">
                <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin" />
                <h3 className="text-lg font-semibold mb-2">{jobState.progress}</h3>
                <p className="text-sm text-slate-500">请勿关闭页面...</p>
              </div>
            )}
          </div>
        )}

        {toc.length > 0 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-slate-800">文章目录</h2>
              <button 
                onClick={exportMarkdown}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium shadow-sm"
              >
                <Download className="w-4 h-4" />
                导出已选文章
              </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="p-4 w-12 text-center">选择</th>
                    <th className="p-4 font-medium text-slate-600">文章标题</th>
                    <th className="p-4 font-medium text-slate-600 w-24 text-center">页码</th>
                    <th className="p-4 font-medium text-slate-600 w-32 text-center">状态</th>
                    <th className="p-4 font-medium text-slate-600 w-32 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {toc.map((article) => (
                    <tr key={article.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="p-4 text-center">
                        <input 
                          type="checkbox" 
                          checked={selectedArticles.has(article.id)}
                          onChange={() => toggleArticleSelection(article.id)}
                          disabled={article.status !== 'completed'}
                          className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="p-4">
                        <div className="font-medium text-slate-900">{article.title_en}</div>
                        {article.subtitle_en && <div className="text-sm text-slate-600 mt-0.5">{article.subtitle_en}</div>}
                        <div className="text-sm text-slate-500 mt-1">{article.title_zh}</div>
                        {article.subtitle_zh && <div className="text-xs text-slate-400 mt-0.5">{article.subtitle_zh}</div>}
                        {article.error && <div className="text-xs text-red-500 mt-1">{article.error}</div>}
                      </td>
                      <td className="p-4 text-center text-sm text-slate-500">
                        {article.start_page} - {article.end_page}
                      </td>
                      <td className="p-4 text-center">
                        {article.status === 'idle' && <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-800">未解析</span>}
                        {article.status === 'parsing' && <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"><Loader2 className="w-3 h-3 mr-1 animate-spin"/> 解析中</span>}
                        {article.status === 'completed' && <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800"><CheckCircle className="w-3 h-3 mr-1"/> 已完成</span>}
                        {article.status === 'error' && <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"><AlertCircle className="w-3 h-3 mr-1"/> 失败</span>}
                      </td>
                      <td className="p-4 text-center space-x-2">
                        {article.status === 'completed' && (
                          <button
                            onClick={() => setViewingArticle(article)}
                            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-100"
                          >
                            <Eye className="w-4 h-4" />
                            查看
                          </button>
                        )}
                        <button 
                          onClick={() => parseArticle(article.id)}
                          disabled={article.status === 'parsing'}
                          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                        >
                          {article.status === 'completed' || article.status === 'error' ? '重新解析' : '开始解析'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {viewingArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800 truncate pr-4">
                {viewingArticle.title_en}{viewingArticle.subtitle_en ? `: ${viewingArticle.subtitle_en}` : ''} <span className="text-slate-500 font-normal text-base">({viewingArticle.title_zh}{viewingArticle.subtitle_zh ? `：${viewingArticle.subtitle_zh}` : ''})</span>
              </h3>
              <button 
                onClick={() => setViewingArticle(null)}
                className="p-2 text-slate-500 hover:bg-slate-200 rounded-full transition-colors flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 prose prose-slate max-w-none prose-headings:text-indigo-900 prose-a:text-indigo-600">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {viewingArticle.content || ''}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
