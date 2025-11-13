const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync } = require('child_process');
const archiver = require('archiver');

const app = express();
const PORT = 5000; // pertahankan 4000 agar cocok dengan klien yang sudah ada

// Root direktori penyimpanan dalam proyek (rapi dalam repo)
const ROOT_DIR = path.resolve(__dirname, 'print-queue');
const SESSION_ROOT = path.join(ROOT_DIR, 'sessions');
const ZIP_DIR = path.join(ROOT_DIR, 'zips');

[ROOT_DIR, SESSION_ROOT, ZIP_DIR].forEach((p) => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Tunable settings (bisa override via env)
const GIF_MAX_WIDTH = Number(process.env.GIF_MAX_WIDTH) || 1200;   // px
const GIF_COLORS    = Number(process.env.GIF_COLORS)    || 160;    // 144–192 for "mid"
const GIF_DELAY     = Number(process.env.GIF_DELAY)     || 80;     // 1/100 s
const GIF_FUZZ      = process.env.GIF_FUZZ              || '2%';   // tolerance
const ZIP_ZLIB_LEVEL= Number(process.env.ZIP_ZLIB_LEVEL)|| 6;      // 1-9
// Tambahan:
const GIF_PROFILE = process.env.GIF_PROFILE || 'balanced';         // 'fast' | 'balanced' | 'quality'
const GIF_SYNC_DEFAULT = process.env.GIF_SYNC === '1';              // default: async

// Deteksi lokasi ImageMagick (magick/magick.exe)
function resolveMagickCmd() {
    const envPath = process.env.MAGICK_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;
    try {
        if (process.platform === 'win32') {
            const out = execSync('where magick', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            const first = out.split(/\r?\n/)[0];
            if (first && fs.existsSync(first)) return first;
        } else {
            const out = execSync('which magick', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (out) return out;
        }
    } catch {}
    if (process.platform === 'win32') {
        const progFiles = 'C:\\Program Files';
        try {
            const dirs = fs.readdirSync(progFiles).filter((d) => d.startsWith('ImageMagick'));
            for (const d of dirs) {
                const candidate = path.join(progFiles, d, 'magick.exe');
                if (fs.existsSync(candidate)) return candidate;
            }
        } catch {}
    }
    return null;
}
const MAGICK_CMD = resolveMagickCmd();
if (!MAGICK_CMD) {
    console.warn('[WARN] ImageMagick tidak ditemukan. Install atau set MAGICK_PATH ke magick.exe');
}

// Helper parsing sessionId dari nama file
function parseSessionIdFromName(name) {
    const m1 = /medphoto_ifest_s([^_]+)_p\d+/i.exec(name);
    if (m1) return m1[1];
    const m2 = /medphoto_ifest_final_([^\.]+)/i.exec(name);
    if (m2) return m2[1];
    return null;
}

// Konfigurasi Multer: simpan per sesi
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const original = file.originalname || '';
        const sid = parseSessionIdFromName(original) || `unknown-${Date.now()}`;
        if (!req._sessionId) req._sessionId = sid;
        const sessionDir = path.join(SESSION_ROOT, `s${sid}`);
        fs.mkdirSync(sessionDir, { recursive: true });
        cb(null, sessionDir);
    },
    filename: function (req, file, cb) {
        // Gunakan nama asli agar pola tetap konsisten
        cb(null, file.originalname || `file-${Date.now()}${path.extname(file.originalname || '')}`);
    },
});
const upload = multer({ storage });

// Static routes untuk download/preview
app.use('/files', express.static(SESSION_ROOT));
app.use('/zips', express.static(ZIP_DIR));

// Util promisy exec
function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout);
        });
    });
}

// Tambahkan builder perintah GIF agar bisa pilih profil
function buildGifCmd(inputsStr, outPath) {
  // Catatan: hilangkan -coalesce untuk kecepatan (umumnya aman untuk JPG tanpa transparansi).
  if (GIF_PROFILE === 'fast') {
    // Fokus kecepatan, ukuran tetap kecil
    return `"${MAGICK_CMD}" -delay ${GIF_DELAY} -loop 0 ${inputsStr} `
      + `-resize ${GIF_MAX_WIDTH}x -strip `
      + `-colors ${GIF_COLORS} -dither FloydSteinberg `
      + `-layers OptimizeFrame "${outPath}"`;
  }
  if (GIF_PROFILE === 'quality') {
    // Kualitas sedikit lebih baik (lebih berat)
    const colors = Math.max(GIF_COLORS, 160);
    return `"${MAGICK_CMD}" -delay ${GIF_DELAY} -loop 0 ${inputsStr} `
      + `-coalesce -resize ${GIF_MAX_WIDTH}x -strip `
      + `-colors ${colors} -dither FloydSteinberg -fuzz ${GIF_FUZZ} `
      + `-layers Optimize "${outPath}"`;
  }
  // balanced (default): kualitas "mid", halus, ukuran tetap kecil
  return `"${MAGICK_CMD}" -delay ${GIF_DELAY} -loop 0 ${inputsStr} `
    + `-filter Lanczos -resize ${GIF_MAX_WIDTH}x -strip `
    + `-colors ${GIF_COLORS} -dither FloydSteinberg -fuzz ${GIF_FUZZ} `
    + `-layers Optimize "${outPath}"`;
}

// Buat GIF dari 3 foto sumber
async function generateGifFromSourcePhotos(files, outDir) {
    if (!MAGICK_CMD) throw new Error('ImageMagick tidak tersedia. Install atau set MAGICK_PATH.');

    const t0 = Date.now();
    const enriched = files.map((f) => {
        const full = path.join(f.destination || outDir, f.filename);
        const m = /medphoto_ifest_s([^_]+)_p(\d+)/i.exec(f.filename);
        return {
            full,
            filename: f.filename,
            sessionId: m ? m[1] : null,
            p: m ? parseInt(m[2], 10) : Number.MAX_SAFE_INTEGER,
        };
    });
    enriched.sort((a, b) => a.p - b.p);
    const sessionId = enriched.find((e) => e.sessionId)?.sessionId || new Date().getTime();

    const outName = `medphoto_ifest_gif_s${sessionId}.gif`;
    const outPath = path.join(outDir, outName);

    const inputs = enriched.map((e) => `"${e.full}"`).join(' ');
    // gunakan profil
    const cmd = buildGifCmd(inputs, outPath);

    await execPromise(cmd);
    if (!fs.existsSync(outPath)) throw new Error('File GIF tidak ditemukan setelah proses.');

    const ms = Date.now() - t0;
    console.log(`🎞️ GIF selesai (${ms} ms): ${outName}`);
    return { filename: outName, fullPath: outPath, ms };
}

// Buat ZIP per sesi (isi: semua file dalam folder sesi, kecuali .zip)
async function createSessionZip(sessionDir, sessionId) {
    const zipName = `medphoto_ifest_s${sessionId}.zip`;
    const zipPath = path.join(ZIP_DIR, zipName);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const t0 = Date.now();
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        // Turunkan level kompresi untuk kecepatan
        const archive = archiver('zip', { zlib: { level: ZIP_ZLIB_LEVEL } });

        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);

        archive.pipe(output);

        const entries = fs.readdirSync(sessionDir);
        for (const name of entries) {
            if (name.toLowerCase().endsWith('.zip')) continue;
            const full = path.join(sessionDir, name);
            const stat = fs.statSync(full);
            if (stat.isFile()) {
                archive.file(full, { name });
            }
        }

        archive.finalize();
    });
    console.log(`🗜️  ZIP selesai (${Date.now() - t0} ms): ${zipName}`);
    return { filename: zipName, fullPath: zipPath };
}

// Helper hapus folder sesi
function safeRemoveDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
      else fs.rmdirSync(dir, { recursive: true }); // fallback Node lama
    }
  } catch (e) {
    console.error('Gagal menghapus folder sesi:', e.message);
  }
}

// Proses sesi: buat GIF (jika ada 3 sumber), ZIP, lalu hapus folder sesi
async function processSession(sessionDir, sessionId, sources) {
  const t0 = Date.now();
  try {
    if (Array.isArray(sources) && sources.length === 3) {
      await generateGifFromSourcePhotos(sources, sessionDir);
    }
    const zipInfo = await createSessionZip(sessionDir, sessionId);
    // Hapus semua file sesi (termasuk GIF & source)
    safeRemoveDir(sessionDir);
    console.log(`🧹 Bersih-bersih sesi s${sessionId} selesai (${Date.now() - t0} ms)`);
    return zipInfo;
  } catch (e) {
    console.error('Gagal memproses sesi:', e.message);
    throw e;
  }
}

// Endpoint kompatibel: terima via '/upload-photos' (field: finalImage, sourcePhotos) atau '/upload' (field: photostrip)
async function handleUpload(req, res) {
    console.log('📥 Menerima upload baru');
    const t0 = Date.now();

    const allFiles = [];
    if (Array.isArray(req.files)) allFiles.push(...req.files);
    else if (req.files) Object.values(req.files).forEach((arr) => allFiles.push(...arr));
    else if (req.file) allFiles.push(req.file);

    if (allFiles.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada file diterima.' });
    }

    const nameForSession = allFiles[0]?.originalname || allFiles[0]?.filename || '';
    const sessionId = parseSessionIdFromName(nameForSession) || (req._sessionId || `unknown-${Date.now()}`);
    const sessionDir = path.join(SESSION_ROOT, `s${sessionId}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // Ambil 3 foto sumber jika ada, untuk pembuatan GIF
    const sources = Array.isArray(req.files?.sourcePhotos) ? req.files.sourcePhotos : [];
    // Tunggu sampai ZIP selesai? (default async agar cepat)
    const waitZip = String(req.query?.waitZip || '').trim() === '1';

    if (waitZip) {
      try {
        const zipInfo = await processSession(sessionDir, sessionId, sources);
        return res.status(200).json({
          success: true,
          message: 'ZIP selesai dibuat.',
          sessionId,
          zip: { filename: zipInfo.filename, url: `/zips/${zipInfo.filename}`, ready: true },
          handledInMs: Date.now() - t0
        });
      } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
      }
    } else {
      // Jalankan di background agar respons cepat
      setImmediate(async () => {
        try { await processSession(sessionDir, sessionId, sources); }
        catch (e) { /* sudah dilog di processSession */ }
      });

      const zipName = `medphoto_ifest_s${sessionId}.zip`;
      return res.status(200).json({
        success: true,
        message: 'Upload diterima. ZIP akan dibuat di background, file sesi akan dihapus.',
        sessionId,
        zip: { filename: zipName, url: `/zips/${zipName}`, ready: false },
        handledInMs: Date.now() - t0
      });
    }
}

// Rute: kompatibel dengan klien lama dan baru
// - Baru: /upload-photos dengan field 'finalImage' dan 'sourcePhotos'
app.post('/upload-photos', upload.fields([
    { name: 'finalImage', maxCount: 1 },
    { name: 'sourcePhotos', maxCount: 3 },
]), handleUpload);

// - Lama: /upload dengan field 'photostrip'
app.post('/upload', upload.single('photostrip'), handleUpload);

app.listen(PORT, '0.0.0.0', () => {
    const networkInterfaces = os.networkInterfaces();
    const ips = [];
    Object.keys(networkInterfaces).forEach((name) => {
        networkInterfaces[name].forEach((net) => {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        });
    });

    console.log(`🖨️  Print Server berjalan dan siap menerima koneksi!`);
    console.log(`   - Lokal:       http://localhost:${PORT}`);
    ips.forEach((ip) => console.log(`   - Di Jaringan: http://${ip}:${PORT}`));
    console.log(`📂 Folder sesi:   ${SESSION_ROOT}`);
    console.log(`🗜️  Folder zip:    ${ZIP_DIR}`);
    if (!MAGICK_CMD) {
        console.log('⚠️  ImageMagick belum terdeteksi. Install via winget/choco atau set MAGICK_PATH ke magick.exe, lalu restart terminal.');
    } else {
        console.log(`✅ ImageMagick:    ${MAGICK_CMD}`);
    }
});