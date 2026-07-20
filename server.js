const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

if (process.env.NODE_ENV !== 'production') {
    try {
        const dotenv = require('dotenv');
        for (const envPath of [
            path.join(__dirname, '.env'),
            path.join(__dirname, 'mpesa-donation-backend', '.env')
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

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://coping-jockey-portly.ngrok-free.dev/api/callback';

const SAFARICOM_BASE_URL = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

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
// SHARED STORAGE (Upstash Redis)
// Vercel runs this app as serverless functions. Every request can land on a
// DIFFERENT, isolated instance with its own memory — an in-memory Map (or
// module-level variable) does NOT persist between requests in production,
// even though it works fine when you run `node server.js` locally as one
// long-running process. Redis is the shared source of truth every instance
// can read and write.
//
// Set up once: Vercel dashboard -> Storage -> Create Database -> "Upstash
// for Redis" -> connect to this project. That injects KV_REST_API_URL and
// KV_REST_API_TOKEN automatically. Then `npm install @upstash/redis`.
//
// Locally (no Redis configured) this falls back to an in-memory Map so you
// can still run `node server.js` on your laptop without setting anything
// up — but that fallback ONLY works for local single-process testing, not
// on Vercel.
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
        console.warn('[storage] KV_REST_API_URL / KV_REST_API_TOKEN not set — falling back to in-memory store. This is fine for local testing but WILL NOT WORK on Vercel.');
    }
} catch (e) {
    console.warn('[storage] @upstash/redis not installed — falling back to in-memory store. Run `npm install @upstash/redis` before deploying to Vercel.');
}

const memoryStore = new Map(); // local-dev-only fallback

async function setTransaction(checkoutRequestId, data) {
    if (!checkoutRequestId) return;
    const record = { ...data, updatedAt: Date.now() };

    if (redis) {
        await redis.set(`txn:${checkoutRequestId}`, JSON.stringify(record), { ex: 3600 }); // expires in 1 hour
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
        return {
            status: 'success',
            userMessage: queryResult.ResultDesc || 'Donation received. Thank you!',
            receiptNumber: items.find((item) => item.Name === 'MpesaReceiptNumber')?.Value,
            amount: items.find((item) => item.Name === 'Amount')?.Value
        };
    }

    if (isPending) {
        return {
            status: 'pending',
            userMessage: 'Waiting for you to complete the payment on your phone.'
        };
    }

    return {
        status: 'failed',
        userMessage: getFriendlyErrorMessage(queryResult.ResultDesc || 'Payment was cancelled or failed.')
    };
}

// ---------------------------------------------------------------------------
// ACCESS TOKEN — also cached in Redis for the same reason as above: a
// module-level variable resets on every cold start on Vercel, which means
// every request could end up minting a brand-new token and hitting
// Safaricom's rate limit (this is very likely part of what caused the 403
// you saw earlier).
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
            return await axios.post(
                `${SAFARICOM_BASE_URL}/mpesa/stkpush/v1/processrequest`,
                stkPayload,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
            );
        } catch (error) {
            const message = String(error?.response?.data?.errorMessage || error?.response?.data?.error || error?.message || '');
            const shouldRetry = attempt < MAX_RETRIES && (
                message.toLowerCase().includes('busy') ||
                message.toLowerCase().includes('timeout') ||
                message.toLowerCase().includes('temporarily') ||
                !error.response
            );

            if (!shouldRetry) throw error;
            await sleep(RETRY_DELAY_MS * (attempt + 1));
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
        res.status(500).json({
            error: "Failed to generate access token",
            details: error.response ? error.response.data : error.message
        });
    }
}

// --- DEBUG ENDPOINT ---
// Inspect exactly what the server currently has stored for a transaction.
// Remove this route before going fully live.
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
        console.log(`[donate] STK push accepted. checkoutRequestId=${checkoutRequestId}`);

        res.status(200).json({
            ...response.data,
            success: true,
            status: 'pending',
            checkoutRequestId
        });
    } catch (error) {
        console.error("STK Push Error:", error.response ? error.response.data : error.message);
        res.status(502).json({
            success: false,
            error: getFriendlyErrorMessage(error),
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
    res.status(200).json({ status: 'ok', storageBackend: redis ? 'redis' : 'in-memory (local-dev fallback)' });
});

// --- CALLBACK WEBHOOK ROUTER ---
app.post('/api/callback', async (req, res) => {
    const callbackData = req.body;
    console.log("=== Incoming M-Pesa Transaction Webhook Callback ===");
    console.log(JSON.stringify(callbackData, null, 2));

    try {
        const stkCallback = callbackData?.Body?.stkCallback;
        if (!stkCallback) {
            console.warn('[callback] Received a POST to /api/callback but it did not contain Body.stkCallback — unexpected shape, nothing stored.');
        } else {
            const checkoutRequestId = stkCallback.CheckoutRequestID;
            const resultCode = Number(stkCallback.ResultCode);
            console.log(`[callback] checkoutRequestId=${checkoutRequestId} resultCode=${resultCode} resultDesc=${stkCallback.ResultDesc}`);

            if (resultCode === 0) {
                const items = stkCallback.CallbackMetadata?.Item || [];
                await setTransaction(checkoutRequestId, {
                    status: 'success',
                    userMessage: 'Donation received. Thank you!',
                    receiptNumber: items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value,
                    amount: items.find((i) => i.Name === 'Amount')?.Value
                });
                console.log(`[callback] Stored SUCCESS for ${checkoutRequestId}`);
            } else {
                await setTransaction(checkoutRequestId, {
                    status: 'failed',
                    userMessage: getFriendlyErrorMessage(stkCallback.ResultDesc)
                });
                console.log(`[callback] Stored FAILED for ${checkoutRequestId}`);
            }
        }
    } catch (e) {
        console.error('[callback] Parse error:', e);
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Secure M-Pesa Backend Server listening on port ${PORT}`);
        console.log(`   MPESA_ENV: ${process.env.MPESA_ENV || 'sandbox'}`);
        console.log(`   CALLBACK_URL: ${CALLBACK_URL}`);
        console.log(`   Storage backend: ${redis ? 'Redis' : 'in-memory (local-dev fallback — will NOT work on Vercel)'}`);
    });
}

module.exports = app;