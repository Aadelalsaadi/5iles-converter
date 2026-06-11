const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

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
  if (!allowed.includes(ext)) {
    fs.unlinkSync(inputPath);
    return res.status(400).json({ error: 'Unsupported file type.' });
  }

  const renamedPath = inputPath + ext;
  fs.renameSync(inputPath, renamedPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const command = `libreoffice --headless --convert-to pdf --outdir ${outputDir} "${renamedPath}"`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
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
  if (!allowed.includes(ext)) {
    fs.unlinkSync(inputPath);
    return res.status(400).json({ error: 'Unsupported video format.' });
  }

  // Rename with extension so FFmpeg can detect the format
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`5iles converter running on port ${PORT}`);
});
