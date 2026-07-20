# Vercel Deployment Fix Summary

## Problem

Your site was showing a **500 INTERNAL_SERVER_ERROR** instead of serving the index.html page because:

1. `server.js` was in the root directory, but Vercel needs serverless functions in an `/api` directory
2. The `vercel.json` configuration was routing all requests to `/server.js` instead of to a proper serverless function
3. Missing environment variables were causing the function to crash

## Changes Made

### 1. **Created `/api/index.js`**

- Copied your server code to the proper Vercel serverless function location
- Fixed environment variable paths (changed `__dirname` references to point to the root directory correctly)
- Added a root route `/` that returns server status
- Added global error handler to prevent crashes
- Improved error messages for missing M-Pesa credentials

### 2. **Updated `vercel.json`**

- Changed from `rewrites` to proper Vercel `routes` configuration
- Configured the build to use `@vercel/node` for the API function
- Set up proper routing:
  - `/api/*` → `/api/index.js` (your backend endpoints)
  - `/health` → `/api/index.js` (health check endpoint)
  - Everything else → `/index.html` (static files and SPA routing)

### 3. **Created root `package.json`**

- Added dependencies (axios, cors, dotenv, express)
- This ensures Vercel installs dependencies at the root level

## What You Need To Do

### ✅ Environment Variables

Verify that the following M-Pesa environment variables are set in your Vercel Project Settings:

- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_ENV` (either "sandbox" or "production")
- `CALLBACK_URL` (your callback endpoint URL)
- `ALLOWED_ORIGINS` (comma-separated list of allowed origins)

### ✅ Redeploy to Vercel

1. Push your changes:

   ```bash
   git add .
   git commit -m "Fix Vercel deployment: move server to /api and update configuration"
   git push
   ```

2. Vercel should automatically redeploy, or you can manually trigger a redeploy in your Vercel dashboard

### ✅ Test the Deployment

1. Visit your site URL and confirm you see the index.html page (not an error)
2. Check the health endpoint: `https://your-domain.com/health`
3. Try the donation endpoint and verify M-Pesa STK push works

## If You Still Get Errors

Check the Vercel logs by clicking the "Learn how to fix the error" link in the error message. The logs will show:

- Missing environment variables
- Connection issues with M-Pesa API
- Code errors in the serverless function

The key is now that errors will be logged properly and you can see what's actually failing.

## Files Updated/Created

- ✅ Created `/api/index.js` (Vercel serverless function)
- ✅ Created `/package.json` (root-level dependencies)
- ✅ Updated `/vercel.json` (proper Vercel routing)
