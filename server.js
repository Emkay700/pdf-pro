const express = require('express');
const multer = require('multer');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const users = [];
const conversionHistory = [];

function logJob(tool, details, userEmail = 'Guest') {
  conversionHistory.unshift({
    id: Date.now(),
    tool,
    details,
    user: userEmail,
    timestamp: new Date().toLocaleTimeString()
  });
}

app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!password) return res.status(400).json({ error: 'Password is required.' });
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Account already exists.' });

  const finalName = name ? name : email.split('@')[0];
  const newUser = { id: Date.now(), name: finalName, email, password };
  users.push(newUser);
  res.json({ user: { name: newUser.name, email: newUser.email } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ user: { name: user.name, email: user.email } });
});

app.get('/api/history', (req, res) => {
  res.json(conversionHistory.slice(0, 10));
});

app.post('/api/merge-pdf', upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files) return res.status(400).json({ error: 'Please upload PDF files.' });
    if (req.files.length < 2) {
      return res.status(400).json({ error: 'Please select at least 2 PDF files to merge.' });
    }
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdf = await PDFDocument.load(file.buffer);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => mergedPdf.addPage(p));
    }
    const pdfBytes = await mergedPdf.save();
    logJob('Merge PDF', `Merged ${req.files.length} files`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Merge failed: ' + err.message });
  }
});

app.post('/api/split-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const srcPdf = await PDFDocument.load(file.buffer);
    const total = srcPdf.getPageCount();
    const parsedStart = parseInt(req.body.startPage);
    const parsedEnd = parseInt(req.body.endPage);
    const start = Math.max(1, isNaN(parsedStart) ? 1 : parsedStart);
    const end = Math.min(total, isNaN(parsedEnd) ? total : parsedEnd);

    const newPdf = await PDFDocument.create();
    const indices = [];
    for (let i = start - 1; i < end; i++) indices.push(i);

    const pages = await newPdf.copyPages(srcPdf, indices);
    pages.forEach(p => newPdf.addPage(p));

    const pdfBytes = await newPdf.save();
    logJob('Split PDF', `Extracted pages ${start}-${end} of ${total}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="split.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Split failed: ' + err.message });
  }
});

app.post('/api/compress-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const pdfDoc = await PDFDocument.load(file.buffer);
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    logJob('Compress PDF', `Optimized ${file.originalname}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="compressed.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Compression failed: ' + err.message });
  }
});

app.post('/api/sign-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const pdfDoc = await PDFDocument.load(file.buffer);
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];
    const { width } = lastPage.getSize();

    if (req.body.signatureDataUrl && req.body.signatureDataUrl.startsWith('data:image/png;base64,')) {
      const base64Data = req.body.signatureDataUrl.replace(/^data:image\/png;base64,/, '');
      const pngImage = await pdfDoc.embedPng(Buffer.from(base64Data, 'base64'));
      lastPage.drawImage(pngImage, { x: width - 220, y: 50, width: 160, height: 60 });
    } else {
      const font = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
      const sigText = req.body.signerName ? req.body.signerName : 'Signed Electronically';
      lastPage.drawText(sigText, { x: width - 220, y: 65, size: 22, font, color: rgb(0.05, 0.1, 0.55) });
    }

    const pdfBytes = await pdfDoc.save();
    logJob('Sign PDF', `Signed ${file.originalname}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="signed.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Sign failed: ' + err.message });
  }
});

app.post('/api/delete-pages', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const srcPdf = await PDFDocument.load(file.buffer);
    const total = srcPdf.getPageCount();
    const rawPages = req.body.pagesToDelete ? req.body.pagesToDelete : '';
    const toRemove = rawPages
      .split(',')
      .map(n => parseInt(n.trim()) - 1)
      .filter(n => !isNaN(n) && n >= 0 && n < total);

    const keepIndices = [];
    for (let i = 0; i < total; i++) {
      if (!toRemove.includes(i)) keepIndices.push(i);
    }

    if (keepIndices.length === 0) {
      return res.status(400).json({ error: 'Cannot delete every page in the PDF.' });
    }

    const newPdf = await PDFDocument.create();
    const copied = await newPdf.copyPages(srcPdf, keepIndices);
    copied.forEach(p => newPdf.addPage(p));

    const pdfBytes = await newPdf.save();
    logJob('Organize PDF', `Removed ${toRemove.length} page(s)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="organized.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Delete pages failed: ' + err.message });
  }
});

app.post('/api/crop-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const parsedMargin = parseInt(req.body.cropMargin);
    const margin = Math.max(10, Math.min(150, isNaN(parsedMargin) ? 35 : parsedMargin));
    const pdfDoc = await PDFDocument.load(file.buffer);

    pdfDoc.getPages().forEach(page => {
      const { width, height } = page.getSize();
      if (width > margin * 2 && height > margin * 2) {
        page.setCropBox(margin, margin, width - margin * 2, height - margin * 2);
      }
    });

    const pdfBytes = await pdfDoc.save();
    logJob('Crop PDF', `Cropped ${margin}pt margin`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="cropped.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Crop failed: ' + err.message });
  }
});

app.post('/api/rotate-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const parsedAngle = parseInt(req.body.angle);
    const angle = isNaN(parsedAngle) ? 90 : parsedAngle;
    const pdfDoc = await PDFDocument.load(file.buffer);
    pdfDoc.getPages().forEach(page => {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + angle) % 360));
    });

    const pdfBytes = await pdfDoc.save();
    logJob('Rotate PDF', `Rotated pages by ${angle}°`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rotated.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Rotate failed: ' + err.message });
  }
});

app.post('/api/watermark-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const text = req.body.watermarkText ? req.body.watermarkText : 'CONFIDENTIAL';
    const pdfDoc = await PDFDocument.load(file.buffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    pdfDoc.getPages().forEach(page => {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: width / 5,
        y: height / 2,
        size: 46,
        font,
        color: rgb(0.85, 0.1, 0.15),
        opacity: 0.25,
        rotate: degrees(35)
      });
    });

    const pdfBytes = await pdfDoc.save();
    logJob('Watermark PDF', `Stamped "${text}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="watermarked.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Watermark failed: ' + err.message });
  }
});

app.post('/api/page-numbers', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const pdfDoc = await PDFDocument.load(file.buffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    pages.forEach((page, idx) => {
      const { width } = page.getSize();
      page.drawText(`Page ${idx + 1} of ${pages.length}`, {
        x: width / 2 - 35,
        y: 25,
        size: 10,
        font,
        color: rgb(0.35, 0.35, 0.35)
      });
    });

    const pdfBytes = await pdfDoc.save();
    logJob('Page Numbers', `Added numbers to ${pages.length} pages`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="numbered.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Numbering failed: ' + err.message });
  }
});

app.post('/api/page-size', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const targetSize = req.body.pageSize === 'LETTER' ? [612, 792] : [595.28, 841.89];
    const pdfDoc = await PDFDocument.load(file.buffer);
    pdfDoc.getPages().forEach(page => page.setSize(targetSize[0], targetSize[1]));

    const pdfBytes = await pdfDoc.save();
    const label = req.body.pageSize ? req.body.pageSize : 'A4';
    logJob('Change Page Size', `Resized to ${label}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resized.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Resize failed: ' + err.message });
  }
});

app.post('/api/images-to-pdf', upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files) return res.status(400).json({ error: 'Please upload an image.' });
    if (req.files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least 1 JPG or PNG image.' });
    }
    const pdfDoc = await PDFDocument.create();
    for (const file of req.files) {
      let image = null;
      if (file.mimetype.includes('jpeg')) {
        image = await pdfDoc.embedJpg(file.buffer);
      } else if (file.mimetype.includes('jpg')) {
        image = await pdfDoc.embedJpg(file.buffer);
      } else if (file.mimetype.includes('png')) {
        image = await pdfDoc.embedPng(file.buffer);
      } else continue;

      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    const pdfBytes = await pdfDoc.save();
    logJob('Image to PDF', `Converted ${req.files.length} image(s)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="images.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Image conversion failed: ' + err.message });
  }
});

app.post('/api/protect-pdf', upload.array('files', 1), async (req, res) => {
  try {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const owner = req.body.ownerName ? req.body.ownerName : 'Protected Document';
    const pdfDoc = await PDFDocument.load(file.buffer);
    pdfDoc.setAuthor(owner);
    pdfDoc.setProducer('PDF2Go Studio Security Engine');
    pdfDoc.setSubject(`Protected by ${owner}`);

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    pdfDoc.getPages().forEach(p => {
      p.drawText(`PROTECTED DOCUMENT • OWNER: ${owner.toUpperCase()}`, {
        x: 20,
        y: 12,
        size: 8,
        font,
        color: rgb(0.75, 0.1, 0.1)
      });
    });

    const pdfBytes = await pdfDoc.save();
    logJob('Protect PDF', `Applied ownership lock for ${owner}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="protected.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Protection failed: ' + err.message });
  }
});

app.post('/api/text-to-pdf', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!content) return res.status(400).json({ error: 'Please enter document text.' });

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const page = pdfDoc.addPage([595.28, 841.89]);
    const { height } = page.getSize();
    const docTitle = title ? title : 'Untitled Document';

    page.drawText(docTitle, { x: 50, y: height - 60, size: 20, font: bold, color: rgb(0.1, 0.1, 0.1) });

    let y = height - 100;
    for (const line of content.split('\n')) {
      if (y < 50) break;
      page.drawText(line.substring(0, 88), { x: 50, y, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
      y -= 18;
    }

    const pdfBytes = await pdfDoc.save();
    logJob('PDF Creator', `Created "${docTitle}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="created-document.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create PDF: ' + err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ PDF2Go Dark Studio running at http://localhost:${PORT}`);
});