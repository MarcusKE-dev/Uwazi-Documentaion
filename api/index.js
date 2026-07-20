const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

// Load environment variables locally
// Only require and load dotenv when running locally
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

const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://coping-jockey-portly.ngrok-free.dev/api/callback';

// Set Safaricom Base URL (sandbox vs production)
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

    if (!/^254[1706]\d{8}$/.test(normalized)) return null;
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

function classifyStkStatus(queryResult) {
    const resultCode = normalizeResultCode(queryResult.ResultCode || queryResult.ResponseCode);
    const resultDesc = String(queryResult.ResultDesc || queryResult.ResponseDescription || '').toLowerCase();

    const isSuccess = resultCode === '0' || resultDesc.includes('success') || resultDesc.includes('processed') || resultDesc.includes('accepted') || resultDesc.includes('completed') || resultDesc.includes('paid') || resultDesc.includes('received');
    const isCancelled = resultCode === '1032' || resultDesc.includes('cancel') || resultDesc.includes('user cancelled') || resultDesc.includes('user canceled') || (resultDesc.includes('pin') && resultDesc.includes('incorrect')) || resultDesc.includes('incorrect pin') || resultDesc.includes('wrong pin');
    const isBusy = resultDesc.includes('system is busy') || resultDesc.includes('busy') || resultDesc.includes('try again in few minutes') || resultDesc.includes('try again later');
    const isPending = !isSuccess && !isCancelled && (
        resultCode === '1032' ||
        resultCode === '2001' ||
        resultCode === '1001' ||
        resultDesc.includes('pending') ||
        resultDesc.includes('processing') ||
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
            userMessage: 'Payment is still being processed. Please wait a moment.'
        };
    }

    return {
        status: 'failed',
        userMessage: getFriendlyErrorMessage(queryResult.ResultDesc || 'Payment was cancelled or failed.')
    };
}

async function getAccessToken() {
    const requiredEnv = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET'];
    const missingEnv = requiredEnv.filter((key) => !process.env[key]);

    if (missingEnv.length) {
        throw new Error(`Missing MPesa environment variables: ${missingEnv.join(', ')}`);
    }

    const secret = process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(secret).toString('base64');

    const response = await axios.get(
        `${SAFARICOM_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );

    return response.data.access_token;
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

    try {
        const accessToken = await getAccessToken();
        const queryResult = await queryStkStatus(checkoutRequestId, accessToken);
        const outcome = classifyStkStatus(queryResult);

        return res.json(outcome);
    } catch (error) {
        console.error('Payment query error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ status: 'unknown', message: 'Unable to verify payment status' });
    }
});

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// --- ROOT/HOME ROUTE ---
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        message: 'UWAZI Backend Server is running',
        environment: process.env.NODE_ENV || 'development'
    });
});

// --- CALLBACK WEBHOOK ROUTER ---
app.post('/api/callback', (req, res) => {
    const callbackData = req.body;
    console.log("=== Incoming M-Pesa Transaction Webhook Callback ===");
    console.log(JSON.stringify(callbackData, null, 2));

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
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