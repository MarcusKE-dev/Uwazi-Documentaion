const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

// Calculate the project root path (works both locally and on Vercel)
const PROJECT_ROOT = path.resolve(path.join(__dirname, '..'));
console.log(`🚀 PROJECT_ROOT: ${PROJECT_ROOT}`);

if (process.env.NODE_ENV !== 'production') {
    try {
        const dotenv = require('dotenv');
        const rootDir = path.join(__dirname, '..');
        for (const envPath of [
            path.join(rootDir, '.env'),
            path.join(rootDir, '.env.local'),
            path.join(rootDir, 'mpesa-donation-backend', '.env')
        ]) {
            dotenv.config({ path: envPath });
        }
    } catch (e) {
        console.log("Dotenv not loaded (running in production/cloud environment)");
    }
}

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS'));
    }
}));

app.use(express.json({ limit: '1mb' }));

console.log(`📁 __dirname: ${__dirname}`);
console.log(`📁 PROJECT_ROOT: ${PROJECT_ROOT}`);
console.log(`📁 NODE_ENV: ${process.env.NODE_ENV || 'production'}`);
console.log(`📁 index.html exists: ${fs.existsSync(path.join(PROJECT_ROOT, 'index.html'))}`);

// Serve static files from the project root (rest of the UWAZI site)
app.use(express.static(PROJECT_ROOT));

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://coping-jockey-portly.ngrok-free.dev/api/callback';

const SAFARICOM_BASE_URL = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// Bump this string any time you deploy a new version of this file, so you
// can confirm via GET /health that Vercel is actually running what you think
// it's running, instead of guessing from behavior.
const DEPLOYED_VERSION = 'v3-callback-diagnostics-2026-07-20';
console.log(`[boot] DEPLOYED_VERSION=${DEPLOYED_VERSION}`);
console.log(`[boot] CALLBACK_URL=${CALLBACK_URL}`);
console.log(`[boot] MPESA_ENV=${process.env.MPESA_ENV || 'sandbox (default)'}  SAFARICOM_BASE_URL=${SAFARICOM_BASE_URL}`);
if (!process.env.CALLBACK_URL) {
    console.warn('[boot] ⚠️  CALLBACK_URL env var is NOT set — falling back to the old ngrok default. Safaricom cannot reach that. Set CALLBACK_URL in Vercel to https://uwazi-doc.vercel.app/api/callback');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhone(phone) {
    if (typeof phone !== 'string') return null;
    const cleaned = phone.replace(/\s+/g, '').trim();
    if (!cleaned) return null;

    let normalized = cleaned;
    if (normalized.startsWith('+')) normalized = normalized.slice(1);
    if (normalized.startsWith('0')) normalized = `254${normalized.slice(1)}`;

    if (!/^254(7|1)\d{8}$/.test(normalized)) return null;
    return normalized;
}

function validateDonationPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid request body.' };
    }

    const phone = normalizePhone(payload.phone);
    const amountValue = Number(payload.amount);

    if (!phone) {
        return { ok: false, error: 'Please enter a valid M-Pesa phone number.' };
    }

    if (!Number.isFinite(amountValue) || amountValue < 1 || !Number.isInteger(amountValue)) {
        return { ok: false, error: 'Please enter a whole number amount greater than zero.' };
    }

    return { ok: true, phone, amount: amountValue };
}

function getFriendlyErrorMessage(error) {
    const message = String(error?.response?.data?.errorMessage || error?.response?.data?.error || error?.message || error || '');
    const text = message.toLowerCase();

    if (text.includes('failed to generate access token') || text.includes('temporarily busy') || text.includes('busy')) {
        return 'M-Pesa is temporarily busy. Please wait a moment and try again.';
    }
    if (text.includes('incorrect pin') || text.includes('wrong pin')) {
        return 'Incorrect M-Pesa PIN. Please try again.';
    }
    if (text.includes('cancel') || text.includes('user cancelled') || text.includes('user canceled')) {
        return 'Payment was cancelled. No charge was made.';
    }
    if (text.includes('mmi') || text.includes('connection problem') || text.includes('timeout') || text.includes('timed out') || text.includes('expired')) {
        return 'The payment request timed out or the connection was interrupted. Please try again.';
    }
    return message || 'M-Pesa request failed. Please try again.';
}

function normalizeResultCode(value) {
    if (value === null || value === undefined || value === '') return '';
    return String(value).trim().replace(/[^0-9]/g, '');
}

// ---------------------------------------------------------------------------
// SHARED STORAGE (Upstash Redis) — required on Vercel. Every request can
// land on a different, isolated serverless instance, so in-memory state
// never survives between requests. Redis is the shared source of truth.
// Falls back to an in-memory Map only for local `node api/index.js` testing.
// ---------------------------------------------------------------------------
let redis = null;
try {
    const { Redis } = require('@upstash/redis');
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
        redis = new Redis({ url, token });
        console.log('[storage] Using Upstash Redis for shared state.');
    } else {
        console.warn('[storage] KV_REST_API_URL / KV_REST_API_TOKEN not set — using in-memory store. This WILL NOT WORK correctly on Vercel.');
    }
} catch (e) {
    console.warn('[storage] @upstash/redis not installed — using in-memory store. Run `npm install @upstash/redis` before relying on this in production.');
}

const memoryStore = new Map();

async function setTransaction(checkoutRequestId, data) {
    if (!checkoutRequestId) return;
    const record = { ...data, updatedAt: Date.now() };
    if (redis) {
        await redis.set(`txn:${checkoutRequestId}`, JSON.stringify(record), { ex: 3600 });
    } else {
        memoryStore.set(checkoutRequestId, record);
    }
}

async function getTransaction(checkoutRequestId) {
    if (redis) {
        const raw = await redis.get(`txn:${checkoutRequestId}`);
        if (!raw) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    return memoryStore.get(checkoutRequestId) || null;
}

function classifyStkStatus(queryResult) {
    const resultCode = normalizeResultCode(queryResult.ResultCode || queryResult.ResponseCode);
    const resultDesc = String(queryResult.ResultDesc || queryResult.ResponseDescription || '').toLowerCase();

    const isSuccess = resultCode === '0' || resultDesc.includes('success') || resultDesc.includes('processed') || resultDesc.includes('accepted') || resultDesc.includes('completed') || resultDesc.includes('paid') || resultDesc.includes('received');
    const isCancelled = resultDesc.includes('cancel') || (resultDesc.includes('pin') && resultDesc.includes('incorrect')) || resultDesc.includes('incorrect pin') || resultDesc.includes('wrong pin');
    const isBusy = resultDesc.includes('system is busy') || resultDesc.includes('busy') || resultDesc.includes('try again in few minutes') || resultDesc.includes('try again later');
    const isPending = !isSuccess && !isCancelled && (
        resultCode === '1032' ||
        resultCode === '2001' ||
        resultCode === '1001' ||
        resultDesc.includes('pending') ||
        resultDesc.includes('processing') ||
        resultDesc.includes('being processed') ||
        resultDesc.includes('timeout') ||
        resultDesc.includes('timed out') ||
        resultDesc.includes('mmi') ||
        resultDesc.includes('connection problem') ||
        isBusy
    );

    if (isSuccess) {
        const items = queryResult.CallbackMetadata?.Item || [];
        const receiptNumber = items.find((item) => item.Name === 'MpesaReceiptNumber')?.Value;
        const amount = items.find((item) => item.Name === 'Amount')?.Value;
        console.log(`✅ PAYMENT SUCCESS: Receipt ${receiptNumber}, Amount ${amount}`);
        return {
            status: 'success',
            message: 'Donation received. Thank you!',
            userMessage: queryResult.ResultDesc || 'Donation received. Thank you!',
            receiptNumber,
            amount
        };
    }

    if (isCancelled) {
        console.log(`❌ PAYMENT CANCELLED by user: ${resultDesc}`);
        const msg = getFriendlyErrorMessage(queryResult.ResultDesc || 'Payment was cancelled.');
        return { status: 'failed', message: msg, userMessage: msg };
    }

    if (isPending) {
        return {
            status: 'pending',
            message: 'Payment is still being processed. Please wait.',
            userMessage: 'Waiting for you to complete the payment on your phone.'
        };
    }

    console.log(`❌ PAYMENT FAILED: ${resultDesc}`);
    const msg = getFriendlyErrorMessage(queryResult.ResultDesc || 'Payment failed.');
    return { status: 'failed', message: msg, userMessage: msg };
}

// ---------------------------------------------------------------------------
// ACCESS TOKEN — cached in Redis. A plain module-level variable resets on
// every cold start on Vercel, which meant a fresh token (and a step closer
// to Safaricom's rate limit / 403) on almost every request.
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    const requiredEnv = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET'];
    const missingEnv = requiredEnv.filter((key) => !process.env[key]);

    if (missingEnv.length) {
        throw new Error(`Missing MPesa environment variables: ${missingEnv.join(', ')}`);
    }

    if (redis) {
        const cached = await redis.get('mpesa:access_token');
        if (cached) return cached;
    } else if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const secret = process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(secret).toString('base64');

    const response = await axios.get(
        `${SAFARICOM_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );

    const token = response.data.access_token;
    const expiresInSec = Number(response.data.expires_in) || 3599;

    if (redis) {
        await redis.set('mpesa:access_token', token, { ex: expiresInSec - 60 });
    } else {
        cachedToken = token;
        tokenExpiresAt = Date.now() + (expiresInSec - 60) * 1000;
    }

    return token;
}

async function queryStkStatus(checkoutRequestId, accessToken) {
    const date = new Date();
    const timestamp = date.getFullYear() +
        ("0" + (date.getMonth() + 1)).slice(-2) +
        ("0" + date.getDate()).slice(-2) +
        ("0" + date.getHours()).slice(-2) +
        ("0" + date.getMinutes()).slice(-2) +
        ("0" + date.getSeconds()).slice(-2);

    const password = Buffer.from(
        process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const payload = {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
    };

    const response = await axios.post(
        `${SAFARICOM_BASE_URL}/mpesa/stkpush/v1/query`,
        payload,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data;
}

async function initiateStkPush(stkPayload, token) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            console.log(`🔄 STK Push attempt ${attempt + 1}/${MAX_RETRIES + 1}...`);
            const response = await axios.post(
                `${SAFARICOM_BASE_URL}/mpesa/stkpush/v1/processrequest`,
                stkPayload,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
            );
            console.log(`✅ STK Push successful on attempt ${attempt + 1}`);
            return response;
        } catch (error) {
            const message = String(error?.response?.data?.errorMessage || error?.response?.data?.error || error?.message || '');
            const statusCode = error?.response?.status;

            const shouldRetry = attempt < MAX_RETRIES && (
                !error.response ||
                statusCode === 502 || statusCode === 503 || statusCode === 504 ||
                message.toLowerCase().includes('busy') ||
                message.toLowerCase().includes('timeout') ||
                message.toLowerCase().includes('temporarily') ||
                message.toLowerCase().includes('connection')
            );

            if (!shouldRetry) {
                console.error(`❌ STK Push failed on attempt ${attempt + 1}. Not retrying:`, message);
                throw error;
            }

            const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`⚠️ STK Push attempt ${attempt + 1} failed: ${message}. Retrying in ${delayMs}ms...`);
            await sleep(delayMs);
        }
    }
}

// --- OAUTH MIDDLEWARE ---
async function generateToken(req, res, next) {
    try {
        req.token = await getAccessToken();
        next();
    } catch (error) {
        console.error("Token Generation Error:", error.response ? error.response.data : error.message);
        const isConfigError = error.message.includes('Missing MPesa environment variables');

        if (isConfigError) {
            return res.status(500).json({
                error: "Server configuration error",
                details: "M-Pesa credentials are not configured. Please check Vercel environment variables.",
                message: error.message
            });
        }

        res.status(500).json({
            error: "Failed to generate access token",
            details: error.response ? error.response.data : error.message
        });
    }
}

// --- DEBUG ENDPOINT --- (remove before fully going live)
app.get('/api/debug/:checkoutRequestId', async (req, res) => {
    const record = await getTransaction(req.params.checkoutRequestId);
    res.json({
        checkoutRequestId: req.params.checkoutRequestId,
        found: Boolean(record),
        record: record || null,
        storageBackend: redis ? 'redis' : 'in-memory (local-dev fallback)'
    });
});

// --- INITIATE STK PUSH ENDPOINT ---
app.post('/api/donate', generateToken, async (req, res) => {
    console.log(`[donate] Incoming request: phone=${req.body?.phone}, amount=${req.body?.amount}`);

    const validation = validateDonationPayload(req.body);
    if (!validation.ok) {
        return res.status(400).json({ success: false, error: validation.error, code: 'INVALID_REQUEST' });
    }

    const { phone, amount } = validation;

    const date = new Date();
    const timestamp = date.getFullYear() +
        ("0" + (date.getMonth() + 1)).slice(-2) +
        ("0" + date.getDate()).slice(-2) +
        ("0" + date.getHours()).slice(-2) +
        ("0" + date.getMinutes()).slice(-2) +
        ("0" + date.getSeconds()).slice(-2);

    const password = Buffer.from(
        process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const stkPayload = {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: "Uwazi Donation",
        TransactionDesc: "Payment via Web Form"
    };

    try {
        const response = await initiateStkPush(stkPayload, req.token);
        const checkoutRequestId = response.data.CheckoutRequestID;

        await setTransaction(checkoutRequestId, {
            status: 'pending',
            userMessage: 'Waiting for you to enter your M-Pesa PIN.'
        });

        console.log(`📱 STK Push initiated: ${checkoutRequestId} for phone ${phone}, amount ${amount}`);
        console.log(`📱 CallBackURL sent to Safaricom for this push: ${stkPayload.CallBackURL}`);

        res.status(200).json({
            ...response.data,
            success: true,
            status: 'pending',
            checkoutRequestId,
            ResponseCode: response.data.ResponseCode || '0'
        });
    } catch (error) {
        console.error("❌ STK Push Error:", error.response ? error.response.data : error.message);
        const errorMessage = getFriendlyErrorMessage(error);
        res.status(502).json({
            success: false,
            error: errorMessage,
            message: errorMessage,
            code: 'STK_PUSH_FAILED'
        });
    }
});

// --- PAYMENT STATUS CHECKER ---
app.get('/api/payment-status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;
    const stored = await getTransaction(checkoutRequestId);

    if (stored && (stored.status === 'success' || stored.status === 'failed')) {
        console.log(`[status] ${checkoutRequestId} resolved from callback store: ${stored.status}`);
        return res.json(stored);
    }

    console.log(`[status] ${checkoutRequestId} — no terminal callback yet, falling back to Safaricom query...`);

    try {
        const accessToken = await getAccessToken();
        const queryResult = await queryStkStatus(checkoutRequestId, accessToken);
        console.log(`[status] ${checkoutRequestId} — raw Safaricom query result:`, JSON.stringify(queryResult));

        const outcome = classifyStkStatus(queryResult);
        console.log(`[status] ${checkoutRequestId} — classified as: ${outcome.status}`);

        if (outcome.status !== 'pending') {
            await setTransaction(checkoutRequestId, outcome);
        }

        return res.json(outcome);
    } catch (error) {
        const data = error.response ? error.response.data : null;
        const errorCode = data?.errorCode || '';
        const errorMessage = String(data?.errorMessage || error.message || '');
        console.log(`[status] ${checkoutRequestId} — query threw. errorCode=${errorCode} message=${errorMessage}`);

        if (errorCode === '500.001.1001' || /processed|pending/i.test(errorMessage)) {
            return res.json({ status: 'pending', userMessage: 'Waiting for you to complete the payment on your phone.' });
        }

        console.error('[status] Payment query error (not a recognized "still pending" case):', data || error.message);
        return res.json(stored || { status: 'pending', userMessage: 'Still checking...' });
    }
});

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        deployedVersion: DEPLOYED_VERSION,
        storageBackend: redis ? 'redis' : 'in-memory (local-dev fallback)',
        callbackUrlConfigured: Boolean(process.env.CALLBACK_URL),
        callbackUrl: CALLBACK_URL,
        mpesaEnv: process.env.MPESA_ENV || 'sandbox (default)',
        safaricomBaseUrl: SAFARICOM_BASE_URL
    });
});

// --- CALLBACK WEBHOOK ROUTER ---
app.post('/api/callback', async (req, res) => {
    const callbackData = req.body;
    console.log("=== Incoming M-Pesa Transaction Webhook Callback ===");
    console.log(JSON.stringify(callbackData, null, 2));

    try {
        const stkCallback = callbackData?.Body?.stkCallback;
        if (!stkCallback) {
            console.warn('[callback] POST to /api/callback did not contain Body.stkCallback — nothing stored.');
        } else {
            const checkoutRequestId = stkCallback.CheckoutRequestID;
            const resultCode = Number(stkCallback.ResultCode);
            console.log(`[callback] checkoutRequestId=${checkoutRequestId} resultCode=${resultCode} resultDesc=${stkCallback.ResultDesc}`);

            if (resultCode === 0) {
                const items = stkCallback.CallbackMetadata?.Item || [];
                await setTransaction(checkoutRequestId, {
                    status: 'success',
                    message: 'Donation received. Thank you!',
                    userMessage: 'Donation received. Thank you!',
                    receiptNumber: items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value,
                    amount: items.find((i) => i.Name === 'Amount')?.Value
                });
                console.log(`[callback] Stored SUCCESS for ${checkoutRequestId}`);
            } else {
                const msg = getFriendlyErrorMessage(stkCallback.ResultDesc);
                await setTransaction(checkoutRequestId, { status: 'failed', message: msg, userMessage: msg });
                console.log(`[callback] Stored FAILED for ${checkoutRequestId}`);
            }
        }
    } catch (e) {
        console.error('[callback] Parse error:', e);
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// --- SPA FALLBACK: SERVE INDEX.HTML FOR CLIENT-SIDE ROUTING ---
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
        return next();
    }

    const lastSegment = req.path.split('/').pop();
    if (lastSegment && lastSegment.includes('.')) {
        return next();
    }

    const indexPath = path.join(PROJECT_ROOT, 'index.html');
    console.log(`📄 Serving SPA fallback for: ${req.path}`);
    res.sendFile(indexPath, (err) => {
        if (err) {
            console.error(`❌ Error serving index.html from ${indexPath}: ${err.message}`);
            res.status(500).json({ error: 'Error serving page', path: req.path });
        }
    });
});

// --- GLOBAL 404 HANDLER ---
app.use((req, res) => {
    const filePath = path.join(PROJECT_ROOT, req.path);
    const fileExists = fs.existsSync(filePath);
    console.log(`❌ 404: ${req.method} ${req.path}`);
    console.log(`   Looking in: ${filePath}`);
    console.log(`   File exists: ${fileExists}`);

    res.status(404).json({
        error: 'Not found',
        path: req.path,
        method: req.method
    });
});

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
        error: "Internal server error",
        message: err.message,
        path: req.path,
        method: req.method
    });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Secure M-Pesa Backend Server listening on port ${PORT}`));
}

module.exports = app;