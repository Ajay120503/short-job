const { createWorker, OEM } = require('tesseract.js');
const englishLanguage = require('@tesseract.js-data/eng');

const MAX_OCR_IMAGES = 5;
const MAX_OCR_TEXT_LENGTH = 5000;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 15000;

let workerPromise;
let recognitionQueue = Promise.resolve();

const cleanOcrText = (value = '') =>
  String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_OCR_TEXT_LENGTH);

const getWorker = async () => {
  if (!workerPromise) {
    workerPromise = createWorker(englishLanguage.code, OEM.LSTM_ONLY, {
      langPath: englishLanguage.langPath,
      gzip: englishLanguage.gzip,
      logger: () => {},
      errorHandler: (error) => console.error('OCR worker error:', error.message),
    }).catch((error) => {
      workerPromise = undefined;
      throw error;
    });
  }
  return workerPromise;
};

const enqueueRecognition = (task) => {
  const result = recognitionQueue.then(task, task);
  recognitionQueue = result.catch(() => {});
  return result;
};

const downloadImage = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('OCR source is not an image');
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new Error('OCR image exceeds the size limit');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REMOTE_IMAGE_BYTES) throw new Error('OCR image exceeds the size limit');
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeSource = async (source) => {
  if (Buffer.isBuffer(source)) return source;
  if (source?.buffer && Buffer.isBuffer(source.buffer)) {
    if (source.mimetype && !source.mimetype.startsWith('image/')) return null;
    return source.buffer;
  }
  if (typeof source === 'string' && /^https?:\/\//i.test(source)) return downloadImage(source);
  return null;
};

const emptyResult = (status = 'not_applicable') => ({
  ocrStatus: status,
  ocrText: '',
  ocrConfidence: null,
  ocrImageCount: 0,
  ocrProcessedAt: new Date(),
  ocrProcessingMs: 0,
});

const extractTextFromImages = async (sources = []) => {
  const candidates = (Array.isArray(sources) ? sources : [sources]).filter(Boolean).slice(0, MAX_OCR_IMAGES);
  if (!candidates.length) return emptyResult();

  const startedAt = Date.now();
  const extracted = [];
  const failures = [];

  try {
    await enqueueRecognition(async () => {
      const worker = await getWorker();
      for (const source of candidates) {
        try {
          const normalizedSource = await normalizeSource(source);
          if (!normalizedSource) continue;
          const { data } = await worker.recognize(normalizedSource);
          extracted.push({ text: cleanOcrText(data?.text), confidence: Number(data?.confidence) || 0 });
        } catch (error) {
          failures.push(error.message || 'OCR recognition failed');
        }
      }
    });
  } catch (error) {
    failures.push(error.message || 'OCR worker could not start');
  }

  const usable = extracted.filter((item) => item.text);
  const imageCount = extracted.length;
  const status = failures.length
    ? (imageCount ? 'partial' : 'failed')
    : (imageCount ? 'completed' : 'not_applicable');

  return {
    ocrStatus: status,
    ocrText: cleanOcrText(usable.map((item) => item.text).join('\n\n')),
    ocrConfidence: usable.length
      ? Math.round(usable.reduce((total, item) => total + item.confidence, 0) / usable.length)
      : null,
    ocrImageCount: imageCount,
    ocrProcessedAt: new Date(),
    ocrProcessingMs: Date.now() - startedAt,
    ...(failures.length ? { ocrError: failures[0].slice(0, 300) } : {}),
  };
};

const getCloudinaryVideoFrames = (url) => {
  if (!url || !url.includes('/video/upload/')) return [];
  return [0, 2].map((second) => {
    const transformed = url.replace('/upload/', `/upload/so_${second}/`);
    return transformed.replace(/\.[a-z0-9]+(?=\?|$)/i, '.jpg');
  });
};

const getContentImageSources = (content, type) => {
  if (type === 'post') return (content?.images || []).map((image) => image?.url || image).filter(Boolean);
  if (type === 'story' && content?.mediaType === 'video') return getCloudinaryVideoFrames(content?.image?.url);
  if (!content?.image?.url) return [];
  return [content.image.url];
};

module.exports = {
  extractTextFromImages,
  getContentImageSources,
};
