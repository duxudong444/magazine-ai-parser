import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { v4 as uuidv4 } from 'uuid';
import { PDFParse } from 'pdf-parse';

const app = express();
const PORT = Number(process.env.PORT || 3000);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

type JobStatus = 'pending' | 'processing' | 'completed' | 'error';

interface Job {
  id: string;
  status: JobStatus;
  progress: string;
  result?: string;
  error?: string;
}

const jobs = new Map<string, Job>();
const clients = new Map<string, express.Response[]>();

function updateJob(jobId: string, update: Partial<Job>) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, update);
    const jobClients = clients.get(jobId) || [];
    
    // Do not send the full result in SSE to avoid large payload issues
    const ssePayload = { ...job };
    delete ssePayload.result;
    
    jobClients.forEach(res => {
      res.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
    });
  }
}

async function extractPages(buffer: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.pages.map((p: any) => p.text);
}

async function processJob(jobId: string, fileBuffer: Buffer) {
  try {
    updateJob(jobId, { status: 'processing', progress: '正在读取 PDF 文件...' });
    const pagesText = await extractPages(fileBuffer);
    
    console.log(`Extracted ${pagesText.length} pages. Total text length: ${pagesText.join('').length}`);
    if (pagesText.join('').trim().length === 0) {
      throw new Error('PDF 文件中没有提取到任何文本，可能是扫描版 PDF。请使用包含可选中文本的 PDF。');
    }
    
    updateJob(jobId, { status: 'completed', progress: 'PDF 解析完成', result: JSON.stringify(pagesText) });
  } catch (error: any) {
    console.error(`Error processing job ${jobId}:`, error);
    updateJob(jobId, { status: 'error', error: error.message });
  }
}

const chunksMap = new Map<string, Buffer[]>();

app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No chunk uploaded' });
    return;
  }

  const { uploadId, chunkIndex, totalChunks } = req.body;
  
  if (!uploadId || chunkIndex === undefined || !totalChunks) {
    res.status(400).json({ error: 'Missing chunk metadata' });
    return;
  }

  if (!chunksMap.has(uploadId)) {
    chunksMap.set(uploadId, []);
  }
  
  const chunks = chunksMap.get(uploadId)!;
  chunks[parseInt(chunkIndex)] = req.file.buffer;

  // Check if all chunks are received
  if (chunks.filter(Boolean).length === parseInt(totalChunks)) {
    const fileBuffer = Buffer.concat(chunks);
    chunksMap.delete(uploadId);

    const jobId = uuidv4();
    jobs.set(jobId, { id: jobId, status: 'pending', progress: '等待处理...' });
    
    // Start processing asynchronously
    processJob(jobId, fileBuffer);
    
    res.json({ jobId });
  } else {
    res.json({ success: true, received: parseInt(chunkIndex) });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const jobClients = clients.get(jobId) || [];
  jobClients.push(res);
  clients.set(jobId, jobClients);
  
  // Send current state immediately
  const ssePayload = { ...job };
  delete ssePayload.result;
  res.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
  
  req.on('close', () => {
    const updatedClients = (clients.get(jobId) || []).filter(c => c !== res);
    if (updatedClients.length > 0) {
      clients.set(jobId, updatedClients);
    } else {
      clients.delete(jobId);
    }
  });
});

app.get('/api/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ result: job.result || '' });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
