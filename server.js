const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '5iles Office & Media Converter' });
});

// ── Office → PDF ──────────────────────────────────────────────────────────────
app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const outputDir = '/tmp/outputs/';
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const allowed = ['.pptx', '.ppt', '.xlsx', '.xls', '.docx', '.doc'];
  if (!allowed.includes(ext)) { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'Unsupported file type.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const command = `libreoffice --headless -env:UserInstallation=file:///tmp/lo_profile_${Date.now()}_${Math.random().toString(36).slice(2)} --convert-to pdf --outdir ${outputDir} "${renamedPath}"`;
  exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(renamedPath); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });
    const baseName = path.basename(renamedPath, ext);
    const outputPath = path.join(outputDir, baseName + '.pdf');
    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Output PDF not found' });
    const outputFileName = path.basename(originalName, ext) + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);
    fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
  });
});

// ── Video → MP3 ───────────────────────────────────────────────────────────────
app.post('/video-to-mp3', upload.single('file'), (req, res) => {
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
app.post('/convert-audio', upload.single('file'), (req, res) => {
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
app.post('/extract-audio', upload.single('file'), (req, res) => {
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
app.post('/compress-video', upload.single('file'), (req, res) => {
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
app.post('/pdf-to-word', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const outputDir = '/tmp/outputs/';
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const command = `libreoffice --headless -env:UserInstallation=file:///tmp/lo_profile_${Date.now()}_${Math.random().toString(36).slice(2)} --infilter="writer_pdf_import" --convert-to docx --outdir ${outputDir} "${renamedPath}"`;
  exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
    console.log(`[pdf-to-word] file=${originalName} stdout=${stdout} stderr=${stderr} error=${error}`);
    try { fs.unlinkSync(renamedPath); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });
    const baseName = path.basename(renamedPath, ext);
    const outputPath = path.join(outputDir, baseName + '.docx');
    const checkAndServe = (attemptsLeft) => {
      if (fs.existsSync(outputPath)) {
        const outputFileName = path.basename(originalName, ext) + '.docx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
        const fileStream = fs.createReadStream(outputPath);
        fileStream.pipe(res);
        fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
      } else if (attemptsLeft > 0) {
        setTimeout(() => checkAndServe(attemptsLeft - 1), 1000);
      } else {
        console.log(`[pdf-to-word] output never appeared at ${outputPath}`);
        res.status(500).json({ error: 'Output Word file not found', details: stderr || 'No error output; LibreOffice may have exited without producing a file (possible memory limit on large/complex PDFs).' });
      }
    };
    checkAndServe(5); // retry for up to 5 seconds in case of filesystem write delay

  });
});

// ── PDF → Excel ───────────────────────────────────────────────────────────────
// Note: quality depends on the PDF's structure. LibreOffice does a reasonable
// job on PDFs with clear tabular layout, but won't match dedicated table-
// extraction services on complex multi-column or scanned documents.
app.post('/pdf-to-excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  const outputDir = '/tmp/outputs/';
  if (ext !== '.pdf') { fs.unlinkSync(inputPath); return res.status(400).json({ error: 'File must be a PDF.' }); }
  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const command = `libreoffice --headless -env:UserInstallation=file:///tmp/lo_profile_${Date.now()}_${Math.random().toString(36).slice(2)} --convert-to xlsx --outdir ${outputDir} "${renamedPath}"`;
  exec(command, { timeout: 180000 }, (error, stdout, stderr) => {
    console.log(`[pdf-to-excel] file=${originalName} stdout=${stdout} stderr=${stderr} error=${error}`);
    try { fs.unlinkSync(renamedPath); } catch (e) {}
    if (error) return res.status(500).json({ error: 'Conversion failed', details: stderr });
    const baseName = path.basename(renamedPath, ext);
    const outputPath = path.join(outputDir, baseName + '.xlsx');
    const checkAndServe = (attemptsLeft) => {
      if (fs.existsSync(outputPath)) {
        const outputFileName = path.basename(originalName, ext) + '.xlsx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
        const fileStream = fs.createReadStream(outputPath);
        fileStream.pipe(res);
        fileStream.on('close', () => { try { fs.unlinkSync(outputPath); } catch (e) {} });
      } else if (attemptsLeft > 0) {
        setTimeout(() => checkAndServe(attemptsLeft - 1), 1000);
      } else {
        console.log(`[pdf-to-excel] output never appeared at ${outputPath}`);
        res.status(500).json({ error: 'Output Excel file not found', details: stderr || 'No error output; LibreOffice may have exited without producing a file (possible memory limit on large/complex PDFs).' });
      }
    };
    checkAndServe(5);
  });
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
app.listen(PORT, () => { console.log(`5iles converter running on port ${PORT}`); });
