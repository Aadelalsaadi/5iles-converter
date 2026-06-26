const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const CloudConvert = require('cloudconvert');
const { Readable } = require('stream');

const app = express();
const uploadDocs = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50 * 1024 * 1024 } });  // 50MB — documents
const uploadMedia = multer({ dest: '/tmp/uploads/', limits: { fileSize: 150 * 1024 * 1024 } }); // 150MB — audio/video (ffmpeg)
const upload = uploadDocs; // kept as an alias so any remaining references default to the safer limit

// ── CloudConvert (used for document conversions: Office<->PDF, PDF->Word/Excel) ──
// Replaces self-hosted LibreOffice for these formats. CloudConvert handles its own
// job queuing and scaling on their end, so no local concurrency lock is needed the
// way it was for self-hosted LibreOffice.
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

async function convertWithCloudConvert(localFilePath, originalFileName, outputFormat) {
  if (!process.env.CLOUDCONVERT_API_KEY) {
    throw new Error('Conversion service is not configured (missing API key).');
  }
  let job = await cloudConvert.jobs.create({
    tasks: {
      'upload-file': { operation: 'import/upload' },
      'convert-file': { operation: 'convert', input: 'upload-file', output_format: outputFormat },
      'export-file': { operation: 'export/url', input: 'convert-file' }
    }
  });

  const uploadTask = job.tasks.find(t => t.name === 'upload-file');
  const inputStream = fs.createReadStream(localFilePath);
  await cloudConvert.tasks.upload(uploadTask, inputStream, originalFileName);

  job = await cloudConvert.jobs.wait(job.id);

  if (job.status === 'error') {
    const failedTask = job.tasks.find(t => t.status === 'error');
    throw new Error(failedTask?.message || 'Conversion failed.');
  }

  const exportedFiles = cloudConvert.jobs.getExportUrls(job);
  if (!exportedFiles || exportedFiles.length === 0) {
    throw new Error('No output file was produced.');
  }
  return exportedFiles[0]; // { url, filename, ... }
}

// Downloads the CloudConvert result and streams it through our own response,
// so the browser only ever talks to our domain — never redirected to a
// third-party URL.
async function streamCloudConvertResult(fileInfo, res, contentType, downloadFileName) {
  const ccResponse = await fetch(fileInfo.url);
  if (!ccResponse.ok) throw new Error('Failed to retrieve converted file.');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);
  Readable.fromWeb(ccResponse.body).pipe(res);
}
// Optimizes/compresses a PDF using CloudConvert's "optimize" operation.
// CloudConvert doesn't take a 0-100 quality number — it uses named profiles.
// We map our UI's slider (10-90) into 3 of them: web (light), archive (balanced),
// max (strongest). This is an approximation, not a continuous scale.
async function optimizeWithCloudConvert(localFilePath, originalFileName, profile) {
  if (!process.env.CLOUDCONVERT_API_KEY) {
    throw new Error('Conversion service is not configured (missing API key).');
  }
  let job = await cloudConvert.jobs.create({
    tasks: {
      'upload-file': { operation: 'import/upload' },
      'optimize-file': { operation: 'optimize', input: 'upload-file', input_format: 'pdf', profile: profile },
      'export-file': { operation: 'export/url', input: 'optimize-file' }
    }
  });

  const uploadTask = job.tasks.find(t => t.name === 'upload-file');
  const inputStream = fs.createReadStream(localFilePath);
  await cloudConvert.tasks.upload(uploadTask, inputStream, originalFileName);

  job = await cloudConvert.jobs.wait(job.id);

  if (job.status === 'error') {
    const failedTask = job.tasks.find(t => t.status === 'error');
    throw new Error(failedTask?.message || 'Compression failed.');
  }

  const exportedFiles = cloudConvert.jobs.getExportUrls(job);
  if (!exportedFiles || exportedFiles.length === 0) {
    throw new Error('No output file was produced.');
  }
  return exportedFiles[0];
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '5iles Office & Media Converter' });
});

// ── Office → PDF ──────────────────────────────────────────────────────────────
app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const allowed = ['.pptx', '.ppt', '.xlsx', '.xls', '.docx', '.doc'];
  if (!allowed.includes(ext)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported file type.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  try {
    const fileInfo = await convertWithCloudConvert(renamedPath, originalName, 'pdf');
    const outputFileName = path.basename(originalName, ext) + '.pdf';
    await streamCloudConvertResult(fileInfo, res, 'application/pdf', outputFileName);
  } catch (err) {
    console.error('[convert] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed', details: err.message });
  } finally {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
  }
});

// ── Video → MP3 ───────────────────────────────────────────────────────────────
app.post('/video-to-mp3', uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v'];
  if (!allowed.includes(ext)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported video format.' }); }
  const renamedInput = inputPath + ext;
  fs.renameSync(inputPath, renamedInput);
  const outputPath = renamedInput + '.mp3';
  const command = `ffmpeg -i "${renamedInput}" -vn -acodec libmp3lame -q:a 2 "${outputPath}" -y`;
  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedInput); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Output MP3 not found' });
    const outputFileName = path.basename(originalName, ext) + '.mp3';
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
  });
});

// ── Audio Converter ───────────────────────────────────────────────────────────
app.post('/convert-audio', uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const inputExt = path.extname(originalName).toLowerCase();
  const outputFormat = (req.query.format || 'mp3').toLowerCase();
  const allowedInput = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.opus'];
  const allowedOutput = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
  if (!allowedInput.includes(inputExt)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported audio format.' }); }
  if (!allowedOutput.includes(outputFormat)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported output format.' }); }
  const renamedInput = inputPath + inputExt;
  fs.renameSync(inputPath, renamedInput);
  const outputPath = renamedInput + '.' + outputFormat;
  let audioOptions = '';
  if (outputFormat === 'mp3') audioOptions = '-acodec libmp3lame -q:a 2';
  else if (outputFormat === 'wav') audioOptions = '-acodec pcm_s16le';
  else if (outputFormat === 'ogg') audioOptions = '-acodec libvorbis -q:a 4';
  else if (outputFormat === 'flac') audioOptions = '-acodec flac';
  else if (outputFormat === 'aac') audioOptions = '-acodec aac -b:a 192k';
  const command = `ffmpeg -i "${renamedInput}" ${audioOptions} "${outputPath}" -y`;
  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedInput); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Output file not found' });
    const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
    const outputFileName = path.basename(originalName, inputExt) + '.' + outputFormat;
    res.setHeader('Content-Type', mimeTypes[outputFormat] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
  });
});

// ── Extract Audio from Video ──────────────────────────────────────────────────
app.post('/extract-audio', uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const inputExt = path.extname(originalName).toLowerCase();
  const outputFormat = (req.query.format || 'mp3').toLowerCase();
  const allowedInput = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg'];
  const allowedOutput = ['mp3', 'wav', 'ogg', 'aac'];
  if (!allowedInput.includes(inputExt)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported video format.' }); }
  if (!allowedOutput.includes(outputFormat)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported output format.' }); }
  const renamedInput = inputPath + inputExt;
  fs.renameSync(inputPath, renamedInput);
  const outputPath = renamedInput + '.' + outputFormat;
  let audioOptions = '';
  if (outputFormat === 'mp3') audioOptions = '-vn -acodec libmp3lame -q:a 2';
  else if (outputFormat === 'wav') audioOptions = '-vn -acodec pcm_s16le';
  else if (outputFormat === 'ogg') audioOptions = '-vn -acodec libvorbis -q:a 4';
  else if (outputFormat === 'aac') audioOptions = '-vn -acodec aac -b:a 192k';
  const command = `ffmpeg -i "${renamedInput}" ${audioOptions} "${outputPath}" -y`;
  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedInput); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Extraction failed', details: stderr });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Output file not found' });
    const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac' };
    const outputFileName = path.basename(originalName, inputExt) + '.' + outputFormat;
    res.setHeader('Content-Type', mimeTypes[outputFormat] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
  });
});

// ── Compress Video ────────────────────────────────────────────────────────────
app.post('/compress-video', uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const quality = (req.query.quality || 'medium').toLowerCase();
  const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.m4v'];
  if (!allowed.includes(ext)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported video format.' }); }
  const renamedInput = inputPath + ext;
  fs.renameSync(inputPath, renamedInput);
  const outputPath = renamedInput + '_compressed.mp4';

  // CRF: lower = better quality, larger file. 18=high, 28=medium, 35=low
  const crfMap = { high: '23', medium: '28', low: '35' };
  const crf = crfMap[quality] || '28';

  // Scale down resolution for low quality
  const scaleFilter = quality === 'low' ? '-vf scale=iw/2:ih/2' : '';

  const command = `ffmpeg -i "${renamedInput}" -vcodec libx264 -crf ${crf} ${scaleFilter} -acodec aac -b:a 128k -movflags +faststart "${outputPath}" -y`;

  exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedInput); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Compression failed', details: stderr });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Output file not found' });

    const outputFileName = path.basename(originalName, ext) + '_compressed.mp4';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
  });
});

// ── PDF → Word ────────────────────────────────────────────────────────────────
app.post('/pdf-to-word', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  try {
    const fileInfo = await convertWithCloudConvert(renamedPath, originalName, 'docx');
    const outputFileName = path.basename(originalName, ext) + '.docx';
    await streamCloudConvertResult(fileInfo, res, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', outputFileName);
  } catch (err) {
    console.error('[pdf-to-word] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed', details: err.message });
  } finally {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
  }
});

// ── PDF → Excel ───────────────────────────────────────────────────────────────
app.post('/pdf-to-excel', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  try {
    const fileInfo = await convertWithCloudConvert(renamedPath, originalName, 'xlsx');
    const outputFileName = path.basename(originalName, ext) + '.xlsx';
    await streamCloudConvertResult(fileInfo, res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', outputFileName);
  } catch (err) {
    console.error('[pdf-to-excel] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed', details: err.message });
  } finally {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
  }
});

// ── Compress PDF ──────────────────────────────────────────────────────────────
app.post('/compress-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const level = parseInt(req.body.level, 10) || 60;
  const profile = level <= 40 ? 'web' : level <= 70 ? 'archive' : 'max';
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  try {
    const fileInfo = await optimizeWithCloudConvert(renamedPath, originalName, profile);
    const outputFileName = path.basename(originalName, ext) + '_compressed.pdf';
    await streamCloudConvertResult(fileInfo, res, 'application/pdf', outputFileName);
  } catch (err) {
    console.error('[compress-pdf] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Compression failed', details: err.message });
  } finally {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
  }
});

// ── PDF → JPG ─────────────────────────────────────────────────────────────────
// Renders each page as a JPG. Single-page PDFs return the JPG directly;
// multi-page PDFs return a ZIP containing one JPG per page.
app.post('/pdf-to-jpg', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  const baseName = path.basename(renamedPath, ext);
  const outPrefix = `/tmp/outputs/${baseName}_page`;
  if (!fs.existsSync('/tmp/outputs/')) fs.mkdirSync('/tmp/outputs/', { recursive: true });

  const command = `pdftoppm -jpeg -r 150 "${renamedPath}" "${outPrefix}"`;
  exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });

    const dirFiles = fs.readdirSync('/tmp/outputs/').filter(f => f.startsWith(baseName + '_page'));
    if (dirFiles.length === 0) return res.status(500).json({ error: 'No output pages found' });

    const cleanup = () => dirFiles.forEach(f => { try { fs.unlinkSync('/tmp/outputs/' + f); } catch (e) {} });

    if (dirFiles.length === 1) {
      const outputFileName = path.basename(originalName, ext) + '.jpg';
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
      const fileStream = fs.createReadStream('/tmp/outputs/' + dirFiles[0]);
      fileStream.pipe(res);
      fileStream.on('close', cleanup);
    } else {
      const zipName = path.basename(originalName, ext) + '_pages.zip';
      const zipPath = `/tmp/outputs/${baseName}_pages.zip`;
      const zipCommand = `cd /tmp/outputs/ && zip -j "${zipPath}" ${dirFiles.map(f => `"${f}"`).join(' ')}`;
      exec(zipCommand, { timeout: 30000 }, (zipError) => {
        if (zipError) { cleanup(); return res.status(500).json({ error: 'Zipping failed' }); }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
        const fileStream = fs.createReadStream(zipPath);
        fileStream.pipe(res);
        fileStream.on('close', () => { cleanup(); try { fs.unlinkSync(zipPath); } catch (e) {} });
      });
    }
  });
});

const PORT = process.env.PORT || 3000;

// Catch multer errors (e.g. file too large) and respond cleanly instead of crashing
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum supported size is 50MB.' });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
  next();
});

app.listen(PORT, () => { console.log(`5iles converter running on port ${PORT}`); });
