# M-Pesa Payment Integration Guide

## Current Status: ✅ SANDBOX MODE

Your UWAZI donation system is currently integrated with **M-Pesa Sandbox Environment** for testing and development.

---

## Payment Flow

### 1. **User Initiates Payment** (Front-end: `donate.html`)
- User enters phone number (validated format: `0712345678` or `254712345678`)
- User enters donation amount (minimum KSh 1)
- Form submits to `/api/donate` endpoint

### 2. **Backend Validates Request** (`api/index.js`)
- Phone number is normalized to Safaricom format: `254XXXXXXXXXX`
- Amount is validated (must be integer > 0)
- M-Pesa OAuth token is generated using `MPESA_CONSUMER_KEY` and `MPESA_CONSUMER_SECRET`
- STK Push payload is created with:
  - Business shortcode (`MPESA_SHORTCODE`)
  - Password (hash of shortcode + passkey + timestamp)
  - Callback URL for M-Pesa to notify of payment result

### 3. **STK Push Sent to M-Pesa** (`initiateStkPush`)
- Request sent to M-Pesa API:
  - **Sandbox**: `https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest`
  - **Live**: `https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest`
- If M-Pesa API is temporarily busy:
  - Backend retries with **exponential backoff** (1s → 2s → 4s)
  - Maximum 3 attempts before returning error to user

### 4. **User Receives M-Pesa Prompt**
- Phone receives STK push notification
- User enters M-Pesa PIN to authorize
- User cancels (results in failed payment)

### 5. **Payment Status Polling** (Front-end: `donate.html`)
- After successful STK request, front-end starts polling every 5 seconds
- Polls `/api/payment-status/:checkoutRequestId` endpoint
- **Maximum wait time**: 15 minutes (180 attempts × 5 seconds)
- Frontend displays:
  - `⏳ Waiting for payment confirmation...`
  - `✅ Donation received. Thank you! Receipt: [receipt number]`
  - `❌ Payment failed. [reason]`
  - `⏰ Payment confirmation took too long`

### 6. **Backend Queries M-Pesa Status**
- Backend calls `/mpesa/stkpush/v1/query` with the checkout request ID
- M-Pesa returns payment status:
  - `ResultCode: 0` → Success
  - `ResultCode: 1032` → Cancelled by user
  - Other codes → Pending or failed

### 7. **Backend Classifies Result** (`classifyStkStatus`)
- **Success**: Extracts receipt number and amount from response
- **Failed**: Determines failure reason (cancelled, wrong PIN, timeout, etc.)
- **Pending**: User still entering PIN or M-Pesa processing

---

## Sandbox Testing

### Test Phone Number
- **Number**: `254712345678` or `0712345678`
- **Amount**: Any amount (1 KSh - 150,000 KSh typically)
- **M-Pesa PIN**: `1234` (in sandbox environment)

### Test Scenarios
1. **Successful Payment**: Enter PIN correctly → Payment succeeds
2. **Cancelled**: Don't enter PIN, wait for timeout → "Payment cancelled"
3. **Wrong PIN**: Enter incorrect PIN → "Incorrect PIN"
4. **Network Timeout**: Simulate by waiting → Frontend shows timeout message

### Current Environment Variables
```
MPESA_ENV=sandbox                    # Sandbox or production
MPESA_CONSUMER_KEY=***              # From Safaricom Developer Portal
MPESA_CONSUMER_SECRET=***           # From Safaricom Developer Portal
MPESA_SHORTCODE=174379              # Your business shortcode
MPESA_PASSKEY=***                   # From Safaricom Developer Portal
CALLBACK_URL=https://your-domain/api/callback
ALLOWED_ORIGINS=*                   # Allow all origins (restrict in production)
```

---

## Transitioning to Live M-Pesa

### Step 1: Get Live Credentials from Safaricom
1. Contact Safaricom Business Services: [https://developer.safaricom.co.ke](https://developer.safaricom.co.ke)
2. Complete KYC (Know Your Customer) process
3. Request production credentials (Consumer Key, Consumer Secret, Passkey)
4. Get a **production business shortcode**
5. Ensure your organization is approved for:
   - C2B (Customer to Business) payments
   - STK Push transactions

### Step 2: Update Environment Variables in Vercel
In your Vercel project settings → Environment Variables, update:

```bash
MPESA_ENV=production
MPESA_CONSUMER_KEY=[new production key]
MPESA_CONSUMER_SECRET=[new production secret]
MPESA_SHORTCODE=[new production shortcode]
MPESA_PASSKEY=[new production passkey]
CALLBACK_URL=https://uwazi-documentaion.vercel.app/api/callback
ALLOWED_ORIGINS=https://uwazi-documentaion.vercel.app
```

### Step 3: Test Live Integration
1. Deploy code to Vercel (this automatically uses new env vars)
2. Use a **real Kenyan phone number** with M-Pesa account
3. Enter small amount (e.g., KSh 10) to test
4. Verify money is received in your organization's M-Pesa account

### Step 4: Monitor Payments
- Check `/api/callback` webhook logs in Vercel
- M-Pesa sends real-time payment confirmations here
- Implement database logging to store donation records

---

## Security Considerations for Live Payments

### 1. **HTTPS Only**
- ✅ Vercel provides free SSL/TLS certificates
- All sensitive data (tokens, payloads) transmitted over HTTPS

### 2. **OAuth Token Management**
- ✅ Tokens generated per-request (short-lived)
- ✅ Tokens are never stored or logged
- ✅ Tokens are not sent to client-side code

### 3. **Callback Security**
- ⚠️ **TODO**: Add callback signature validation
  - M-Pesa includes `signature` in callback
  - Validate signature using your Consumer Secret
  - Prevents spoofed webhook calls

### 4. **Rate Limiting**
- ⚠️ **TODO**: Add rate limiting on `/api/donate`
  - Prevent same phone from submitting 100 requests/second
  - Use Redis or token bucket algorithm

### 5. **CORS Restrictions**
- ⚠️ Currently set to `*` (allow all origins)
- **For production**: Set to your domain only
  - `ALLOWED_ORIGINS=https://uwazi-documentaion.vercel.app`

### 6. **Audit Logging**
- ⚠️ **TODO**: Log all transactions to database
  - Phone (hashed), amount, timestamp, status, receipt
  - Enables dispute resolution and fraud detection

---

## Known Issues & Improvements

### Current Limitations

1. **No Database Storage**
   - Donations aren't currently saved to a database
   - No donation history or receipts system
   - No duplicate payment detection

2. **Limited Error Recovery**
   - User must retry entire process if network fails
   - No "resume payment" feature
   - Frontend polling times out after 15 minutes

3. **No Refund Mechanism**
   - M-Pesa refunds must be processed manually
   - No automated refund system

### Recommended Improvements Before Live

1. **Database Integration** (Priority: HIGH)
   ```javascript
   // Store each donation attempt
   {
     phone_hash: hash(phone),     // Don't store actual phone
     amount: 100,
     status: 'success',           // pending, success, failed, cancelled
     receipt_number: 'ABC123XYZ',
     timestamp: '2026-07-20T12:14:01Z',
     mpesa_request_id: 'checkout_id'
   }
   ```

2. **Callback Signature Validation** (Priority: HIGH)
   - Validate M-Pesa callback signature before processing
   - Prevents fraudulent payment confirmations

3. **Rate Limiting** (Priority: MEDIUM)
   - 5 requests per minute per phone number
   - Prevents abuse and DoS attacks

4. **Email Receipts** (Priority: MEDIUM)
   - Send receipt email after successful payment
   - Include donation amount, receipt number, timestamp
   - Improves user experience

5. **Donation History Page** (Priority: LOW)
   - Show past donations (date, amount)
   - Requires user authentication

---

## Testing Checklist Before Going Live

- [ ] Sandbox payments work end-to-end
- [ ] "Thank you" message appears after payment
- [ ] Error messages are user-friendly
- [ ] Mobile experience works smoothly
- [ ] Timeout handling works (15-min test)
- [ ] Wrong PIN error is handled correctly
- [ ] Cancelled payment is handled correctly
- [ ] Network errors don't crash the app
- [ ] Live credentials obtained from Safaricom
- [ ] Callback signature validation implemented
- [ ] Rate limiting implemented
- [ ] CORS restricted to your domain
- [ ] First live test with KSh 10 successful
- [ ] Donation appears in your M-Pesa account

---

## Support & Troubleshooting

### M-Pesa API Documentation
- [Safaricom Developer Portal](https://developer.safaricom.co.ke/docs)
- [STK Push Documentation](https://developer.safaricom.co.ke/docs?javascript#stk-push)
- [Query STK Push Status](https://developer.safaricom.co.ke/docs?javascript#query-stk-push-status)

### Common Errors

1. **"M-Pesa is temporarily busy"**
   - M-Pesa API rate limiting or maintenance
   - Backend automatically retries 3 times
   - User can retry after 1-2 minutes

2. **"Failed to generate access token"**
   - Invalid Consumer Key/Secret
   - Check Vercel environment variables
   - Verify credentials with Safaricom

3. **"Payment confirmation took too long"**
   - Normal if network is slow
   - If user already paid, check M-Pesa statement
   - M-Pesa callback webhook might arrive later

4. **"Incorrect M-Pesa PIN"**
   - User entered wrong PIN
   - User can retry (new STK push required)
   - After 3 attempts, M-Pesa blocks for 30 minutes

---

## File Structure

```
api/
├── index.js                    # Main Express server + M-Pesa logic
│   ├── getAccessToken()        # OAuth token generation
│   ├── initiateStkPush()       # Send STK to M-Pesa with retries
│   ├── queryStkStatus()        # Check payment status
│   ├── classifyStkStatus()     # Classify M-Pesa response
│   └── app.post('/api/donate') # Donation endpoint
│
mpesa-donation-backend/
├── donate.html                 # Front-end UI + polling logic
└── .env                        # Local environment (not deployed)

vercel.json                      # Deployment config (includes static files)
```

---

## Questions?

For issues or questions about the payment flow:
1. Check Vercel logs: `vercel logs`
2. Review M-Pesa error codes in API docs
3. Test in sandbox first before going live
4. Contact Safaricom developer support

---

**Last Updated**: 20 July 2026
**Status**: ✅ Sandbox Functional | ⚠️ Production Ready (awaiting credentials)
