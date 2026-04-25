// Main server entry (CommonJS)
const path = require('path');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('./config/db');
const mongoose = require('mongoose');
const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY;
const axios = require('axios');
const BASE_URL  = 'https://www.googleapis.com/youtube/v3';
const cors = require('cors');
const ffmpeg = require('ffmpeg-static');
const { spawn, execFileSync } = require('child_process');

// Middleware
app.use(express.json());
app.use(cors({ exposedHeaders: ['Content-Disposition'] }));

const log = (level, message, meta = {}) => {
    const entry = {
        time: new Date().toISOString(),
        level,
        message,
        ...meta
    };
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
};

app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        log('info', 'http', {
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Number(durationMs.toFixed(1)),
            ip: req.ip
        });
    });
    next();
});

const sanitizeFilename = (value) => {
    if (!value) return 'audio';
    return String(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'audio';
};

const sanitizeAsciiFallback = (value) => {
    const cleaned = sanitizeFilename(value)
        // Drop non-ASCII entirely for header safety.
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

    // Avoid empty filenames after stripping.
    return cleaned || 'download';
};

const encodeRFC5987ValueChars = (value) =>
    encodeURIComponent(String(value))
        // RFC 5987 allows a limited set of attr-chars; also escape these.
        .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const escapeQuotedString = (value) => String(value).replace(/["\\]/g, '\\$&');

const setAttachmentHeader = (res, filenameUtf8) => {
    const fallback = sanitizeAsciiFallback(filenameUtf8);
    const encoded = encodeRFC5987ValueChars(filenameUtf8);
    // Ensure header value itself is ASCII-only; use RFC 5987 for UTF-8 names.
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${escapeQuotedString(fallback)}"; filename*=UTF-8''${encoded}`
    );
};

const isDebugEnabled = (req) =>
    String(req?.query?.debug || '') === '1' || process.env.NODE_ENV !== 'production';

const trimForLog = (value, maxLen = 4000) => {
    if (!value) return '';
    const text = String(value).trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}\n...trimmed (${text.length - maxLen} chars)`;
};

const guessYtDlpHint = (stderr) => {
    const text = String(stderr || '');
    if (
        text.includes('nodename nor servname provided') ||
        text.includes('Temporary failure in name resolution') ||
        text.includes('Name or service not known')
    ) {
        return 'Server cannot resolve youtube.com (DNS/Internet issue). Check your machine network/DNS/firewall.';
    }
    if (text.includes('HTTP Error 429') || text.toLowerCase().includes('too many requests')) {
        return 'YouTube rate-limited this server (429). Try again later or use cookies/proxy.';
    }
    if (text.includes('Sign in to confirm') || text.toLowerCase().includes('login') || text.toLowerCase().includes('cookies')) {
        return 'This video may require login/consent. Add cookies support (yt-dlp --cookies ...) or try another video.';
    }
    return null;
};

const sendDownloadError = (req, res, payload, { status = 500 } = {}) => {
    if (res.headersSent) {
        res.destroy(new Error(payload?.error || 'Download failed'));
        return;
    }
    const debug = isDebugEnabled(req);
    const responseBody = { error: payload?.error || 'Download failed' };
    if (payload?.hint) responseBody.hint = payload.hint;
    if (debug && payload?.details) responseBody.details = payload.details;
    res.status(status).json(responseBody);
};

const getPython310Plus = (() => {
    let cached = null;
    return () => {
        if (cached !== null) return cached;

        const candidates = [
            process.env.YTDLP_PYTHON,
            'python3.12',
            'python3.11',
            'python3.10',
            'python3'
        ].filter(Boolean);

        for (const bin of [...new Set(candidates)]) {
            try {
                const version = execFileSync(
                    bin,
                    ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
                    { encoding: 'utf8' }
                ).trim();
                const [major, minor] = version.split('.').map((v) => Number(v));
                if (major > 3 || (major === 3 && minor >= 10)) {
                    cached = bin;
                    return cached;
                }
            } catch {
                // ignore missing binaries
            }
        }

        cached = undefined;
        return cached;
    };
})();

const getBundledYtDlpPath = () =>
    path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

app.get('/api/trending', async (req, res) => {
    try {
        const pageToken = req.query.pageToken || null;
        const response = await axios.get(`${BASE_URL}/videos`, {
            params: {
                part: 'snippet,contentDetails,statistics',
                chart: 'mostPopular',
                // Remove regionCode to get global trending content
                maxResults: 20,
                pageToken: pageToken,
                key: API_KEY
            }
        });
        res.json({
            items: response.data.items,
            nextPageToken: response.data.nextPageToken || null
        });
    } catch (error) {
        res.status(500).json(error.response.data);
    }
});

app.get('/api/search', async (req, res) => {
    const { q, pageToken } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/search`, {
            params: {
                part: 'snippet',
                q: q,
                maxResults: 20,
                type: 'video',
                order: 'relevance', // Prioritize most relevant results
                pageToken: pageToken || null,
                key: API_KEY
            }
        });
        res.json({
            items: response.data.items,
            nextPageToken: response.data.nextPageToken || null
        });
      } catch (error) {
        log('error', 'youtube_search_error', { error: error.message });
        
        if (error.response) {
            // 1. Google responded with an error (e.g., 403 Quota Exceeded, 400 Bad Request)
            log('error', 'youtube_search_api_error', { status: error.response.status, data: error.response.data });
            res.status(error.response.status).json(error.response.data);
        } else if (error.request) {
            // 2. Request was sent but NO response received (Network issues)
            log('error', 'youtube_search_no_response');
            res.status(500).json({ error: "No response from YouTube Server" });
        } else {
            // 3. Something happened setting up the request
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/channels', async (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 50);

    if (!ids.length) {
        return res.status(400).json({ error: 'No channel IDs provided' });
    }

    try {
        const response = await axios.get(`${BASE_URL}/channels`, {
            params: {
                part: 'snippet',
                id: ids.join(','),
                key: API_KEY
            }
        });

        const thumbnails = {};
        for (const channel of response.data.items || []) {
            thumbnails[channel.id] =
                channel.snippet?.thumbnails?.default?.url ||
                channel.snippet?.thumbnails?.medium?.url ||
                channel.snippet?.thumbnails?.high?.url || '';
        }

        res.json({ thumbnails });
    } catch (error) {
        log('error', 'youtube_channel_error', { error: error.message });
        if (error.response) return res.status(error.response.status).json(error.response.data);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/video/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    try {
        const response = await axios.get(`${BASE_URL}/videos`, {
            params: {
                part: 'snippet,contentDetails,statistics',
                id: videoId,
                key: API_KEY
            }
        });

        const item = response.data?.items?.[0];
        if (!item) return res.status(404).json({ error: 'Video not found' });
        return res.json(item);
    } catch (error) {
        log('error', 'video_details_error', { error: error.message });
        if (error.response) return res.status(error.response.status).json(error.response.data);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/download-video/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const pythonBin = getPython310Plus();
    if (!pythonBin) {
        return res.status(500).json({
            error: 'Python 3.10+ is required for yt-dlp. Install Python 3.10+ and ensure it is on PATH, or set YTDLP_PYTHON to a Python 3.10+ binary (e.g. python3.11).'
        });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const ytDlpPath = getBundledYtDlpPath();
    const title = sanitizeFilename(req.query.title || videoId);

    const allowedHeights = [144, 240, 360, 480, 720, 1080, 1440, 2160];
    const requestedHeight = Number.parseInt(String(req.query.quality || ''), 10);
    const maxHeight = allowedHeights.includes(requestedHeight) ? requestedHeight : 1080;
    const format = `best[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=${maxHeight}]/best[ext=mp4][height<=${maxHeight}]/best[height<=${maxHeight}]`;

    res.setHeader('Content-Type', 'video/mp4');
    setAttachmentHeader(res, `${title}.mp4`);
    res.setHeader('Cache-Control', 'no-store');

    const startedAt = process.hrtime.bigint();
    log('info', 'video_download_start', { videoId, maxHeight, format });

    const debug = isDebugEnabled(req);
    const ytdlp = spawn(
        pythonBin,
        [
            ytDlpPath,
            url,
            '-f',
            format,
            '-o',
            '-',
            '--no-playlist',
            '--no-progress',
            ...(debug ? ['--verbose'] : ['--no-warnings', '--quiet'])
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let ytdlpErr = '';
    ytdlp.stderr?.on('data', (chunk) => {
        ytdlpErr += chunk.toString('utf8');
    });

    const cleanup = () => {
        if (!ytdlp.killed) ytdlp.kill('SIGKILL');
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);

    ytdlp.stdout.pipe(res);

    const onStreamError = (err) => {
        const stderr = trimForLog(ytdlpErr);
        log('error', 'video_download_error', { videoId, error: err?.message || String(err), stderr });
        cleanup();
        sendDownloadError(
            req,
            res,
            {
                error: 'Failed to download video',
                hint: guessYtDlpHint(stderr),
                details: { ytdlpStderr: stderr }
            },
            { status: 500 }
        );
    };

    ytdlp.on('error', onStreamError);
    ytdlp.stdout?.on('error', onStreamError);

    ytdlp.on('close', (code, signal) => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (signal) {
            log('warn', 'video_download_killed', { videoId, signal, durationMs: Number(durationMs.toFixed(1)) });
            return;
        }
        if (code !== 0) {
            const stderr = trimForLog(ytdlpErr);
            log('error', 'video_download_failed', {
                videoId,
                code,
                durationMs: Number(durationMs.toFixed(1)),
                stderr
            });
            onStreamError(new Error(`yt-dlp exited with code ${code}`));
            return;
        }
        log('info', 'video_download_complete', { videoId, durationMs: Number(durationMs.toFixed(1)) });
    });
});

// Download MP3 route
app.get('/api/download/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }
    if (!ffmpeg) {
        return res.status(500).json({ error: 'ffmpeg binary not available on this platform' });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    try {
        const pythonBin = getPython310Plus();
        if (!pythonBin) {
            return res.status(500).json({
                error: 'Python 3.10+ is required for yt-dlp. Install Python 3.10+ and ensure it is on PATH, or set YTDLP_PYTHON to a Python 3.10+ binary (e.g. python3.11).'
            });
        }

        const title = sanitizeFilename(req.query.title || videoId);
        const ytDlpPath = getBundledYtDlpPath();
        
        res.setHeader('Content-Type', 'audio/mpeg');
        setAttachmentHeader(res, `${title}.mp3`);
        res.setHeader('Cache-Control', 'no-store');

        const debug = isDebugEnabled(req);
        const ytdlp = spawn(
            pythonBin,
            [
                ytDlpPath,
                url,
                '-f',
                'bestaudio/best',
                '-o',
                '-',
                '--no-playlist',
                '--no-progress',
                ...(debug ? ['--verbose'] : ['--no-warnings', '--quiet'])
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const ffmpegProc = spawn(
            ffmpeg,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-i',
                'pipe:0',
                '-vn',
                '-acodec',
                'libmp3lame',
                '-b:a',
                '192k',
                '-f',
                'mp3',
                'pipe:1'
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const cleanup = () => {
            if (!ytdlp.killed) ytdlp.kill('SIGKILL');
            if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
        };

        res.on('close', cleanup);
        res.on('finish', cleanup);

        ytdlp.stdout.pipe(ffmpegProc.stdin);
        ffmpegProc.stdout.pipe(res);

        let ytdlpErr = '';
        let ffmpegErr = '';
        ytdlp.stderr?.on('data', (chunk) => {
            ytdlpErr += chunk.toString('utf8');
        });
        ffmpegProc.stderr?.on('data', (chunk) => {
            ffmpegErr += chunk.toString('utf8');
        });

        const onStreamError = (err) => {
            const ytdlpStderr = trimForLog(ytdlpErr);
            const ffmpegStderr = trimForLog(ffmpegErr);
            const hint = guessYtDlpHint(ytdlpStderr);
            log('error', 'audio_download_error', {
                videoId,
                error: err?.message || String(err),
                ytdlpStderr,
                ffmpegStderr
            });
            cleanup();
            sendDownloadError(req, res, {
                error: 'Failed to download audio',
                hint,
                details: { ytdlpStderr, ffmpegStderr }
            });
        };

        ytdlp.on('error', onStreamError);
        ffmpegProc.on('error', onStreamError);
        ytdlp.stdout?.on('error', onStreamError);
        ffmpegProc.stdout.on('error', onStreamError);
        ytdlp.on('close', (code, signal) => {
            if (signal) return;
            if (code !== 0) onStreamError(new Error(`yt-dlp exited with code ${code}`));
        });
        ffmpegProc.on('close', (code, signal) => {
            if (signal) return;
            if (code !== 0) onStreamError(new Error(`ffmpeg exited with code ${code}`));
        });

    } catch (error) {
        log('error', 'audio_download_exception', { videoId, error: error?.message || String(error) });
        res.status(500).json({ error: 'Failed to download audio' });
    }
});

// Root route
app.get('/', (req, res) => res.send('Server is running!'));

// Start server
const server = app.listen(port, host, () => log('info', 'server_started', { url: `http://${host}:${port}` }));
server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
        log('error', 'server_port_in_use', { port });
        process.exit(1);
    }
    log('error', 'server_error', { error: err?.message || String(err), code: err?.code });
    process.exit(1);
});

let isShuttingDown = false;
const shutdown = async (signal, { exit = true } = {}) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'server_shutting_down', { signal });

    await new Promise((resolve) => server.close(resolve));
    try {
        await mongoose.connection.close();
    } catch {
        // ignore
    }

    if (exit) process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGUSR2', async () => {
    // nodemon uses SIGUSR2 for restarts; close server + DB first.
    await shutdown('SIGUSR2', { exit: false });
    process.kill(process.pid, 'SIGUSR2');
});
