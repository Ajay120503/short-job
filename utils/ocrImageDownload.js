const MAX_BYTES = 6 * 1024 * 1024;

const downloadImage = async (source) => {
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.username || url.password) {
    throw new Error('OCR requires a trusted Cloudinary image URL.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
      throw new Error('OCR image could not be downloaded.');
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('OCR image exceeds the size limit.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('OCR image exceeds the size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
};

module.exports = { downloadImage };
