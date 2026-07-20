const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

// Load environment variables locally
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

    // 07xx and 01xx are the valid Safaricom / general mobile ranges
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
// IN-MEMORY TRANSACTION STORE
// The M-Pesa callback is the *authoritative* source of truth. We store the
// outcome as soon as Safaricom tells us via the webhook, and the status
// endpoint reads from here first. This avoids hammering Safaricom's flaky
// query endpoint and avoids ever showing a false "failed" while a payment
// is still genuinely pending.
// In production, swap this Map for Redis or a database table so state
// survives server restarts and works across multiple server instances.
// ---------------------------------------------------------------------------
const transactions = new Map();

function setTransaction(checkoutRequestId, data) {
    if (!checkoutRequestId) return;
    transactions.set(checkoutRequestId, { ...data, updatedAt: Date.now() });
}

// Periodically clear out old entries so the Map doesn't grow forever
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const [id, record] of transactions.entries()) {
        if (record.updatedAt < cutoff) transactions.delete(id);
    }
}, 15 * 60 * 1000).unref();

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
// ACCESS TOKEN — cached, not fetched on every request.
// Calling Safaricom's OAuth endpoint on every donate click AND every poll
// quickly hits their rate limit and returns 403. Tokens last ~1 hour, so we
// reuse one until shortly before it expires.
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    const requiredEnv = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET'];
    const missingEnv = requiredEnv.filter((key) => !process.env[key]);

    if (missingEnv.length) {
        throw new Error(`Missing MPesa environment variables: ${missingEnv.join(', ')}`);
    }

    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const secret = process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(secret).toString('base64');

    const response = await axios.get(
        `${SAFARICOM_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );

    cachedToken = response.data.access_token;
    const expiresInSec = Number(response.data.expires_in) || 3599;
    tokenExpiresAt = Date.now() + (expiresInSec - 60) * 1000; // refresh 60s early

    return cachedToken;
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

// --- INITIATE STK PUSH ENDPOINT ---
app.post('/api/donate', generateToken, async (req, res) => {
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

        // Seed a pending record right away so the status endpoint has
        // something to answer with even before Safaricom's callback arrives.
        setTransaction(checkoutRequestId, {
            status: 'pending',
            userMessage: 'Waiting for you to enter your M-Pesa PIN.'
        });

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
// Reads the callback-driven store first (authoritative). Only if the
// callback hasn't landed yet does it fall back to an active query against
// Safaricom — and even then, "still processing" is reported as pending,
// never as an error, since that's an entirely normal state while the user
// is looking at their phone.
app.get('/api/payment-status/:checkoutRequestId', async (req, res) => {
    const { checkoutRequestId } = req.params;
    const stored = transactions.get(checkoutRequestId);

    if (stored && (stored.status === 'success' || stored.status === 'failed')) {
        return res.json(stored);
    }

    try {
        const accessToken = await getAccessToken();
        const queryResult = await queryStkStatus(checkoutRequestId, accessToken);
        const outcome = classifyStkStatus(queryResult);

        if (outcome.status !== 'pending') {
            setTransaction(checkoutRequestId, outcome);
        }

        return res.json(outcome);
    } catch (error) {
        const data = error.response ? error.response.data : null;
        const errorCode = data?.errorCode || '';
        const errorMessage = String(data?.errorMessage || error.message || '');

        // Safaricom returns this while the transaction genuinely hasn't
        // resolved yet — treat it as pending, not a failure.
        if (errorCode === '500.001.1001' || /processed|pending/i.test(errorMessage)) {
            return res.json({ status: 'pending', userMessage: 'Waiting for you to complete the payment on your phone.' });
        }

        console.error('Payment query error:', data || error.message);
        // Fall back to whatever we know rather than reporting a hard error
        return res.json(stored || { status: 'pending', userMessage: 'Still checking...' });
    }
});

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// --- CALLBACK WEBHOOK ROUTER ---
app.post('/api/callback', (req, res) => {
    const callbackData = req.body;
    console.log("=== Incoming M-Pesa Transaction Webhook Callback ===");
    console.log(JSON.stringify(callbackData, null, 2));

    try {
        const stkCallback = callbackData?.Body?.stkCallback;
        if (stkCallback) {
            const checkoutRequestId = stkCallback.CheckoutRequestID;
            const resultCode = Number(stkCallback.ResultCode);

            if (resultCode === 0) {
                const items = stkCallback.CallbackMetadata?.Item || [];
                setTransaction(checkoutRequestId, {
                    status: 'success',
                    userMessage: 'Donation received. Thank you!',
                    receiptNumber: items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value,
                    amount: items.find((i) => i.Name === 'Amount')?.Value
                });
            } else {
                setTransaction(checkoutRequestId, {
                    status: 'failed',
                    userMessage: getFriendlyErrorMessage(stkCallback.ResultDesc)
                });
            }
        }
    } catch (e) {
        console.error('Callback parse error:', e);
    }

    // Always acknowledge with 200 so Safaricom doesn't keep retrying
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Secure M-Pesa Backend Server listening on port ${PORT}`));
}

module.exports = app;