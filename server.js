require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ─── OTP Session Store ──────────────────────────────────────
const otpSessions = new Map();

// ─── Flutterwave v3 Base URL ──────────────────────────────
const FLW_BASE = 'https://api.flutterwave.com/v3';

// ─── Helper: Flutterwave v3 Request ────────────────────────
async function flwRequest(method, path, body) {
  const secretKey = process.env.FLW_SECRET_KEY;
  
  if (!secretKey) {
    throw new Error('FLW_SECRET_KEY is not set in environment variables!');
  }

  const url = `${FLW_BASE}${path}`;
  const headers = {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };

  console.log(`📡 ${method} ${url}`);
  console.log(`🔑 Using key: ${secretKey.substring(0, 10)}...`);

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  console.log('📨 Response:', JSON.stringify(data));

  if (!res.ok || data.status !== 'success') {
    console.error('❌ Flutterwave API error:', res.status, data);
    const err = new Error(data.message || `FLW HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ─── Health Check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Flutterwave v3 backend running!' });
});

// ─── Generate OTP ──────────────────────────────────────────
app.post('/api/transfers/generate-otp', async (req, res) => {
  try {
    const { phone, email } = req.body;
    
    console.log('📱 Generating OTP...');

    const response = await flwRequest('POST', '/otps', {
      length: 6,
      customer: {
        name: 'Customer',
        phone: phone || '+2348000000000',
        email: email || 'customer@example.com',
      },
      sender: 'NGN Transfer',
      send: 'email',
      medium: ['email'],
      expiry: 300,
    });

    const otpRef = response.data.reference;
    const sessionId = uuidv4();
    otpSessions.set(sessionId, {
      otpRef,
      createdAt: Date.now(),
      attempts: 0,
      validated: false,
    });

    console.log('✅ OTP generated successfully');

    res.json({
      success: true,
      sessionId,
      message: 'OTP sent successfully',
    });
  } catch (err) {
    console.error('❌ Generate OTP error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to generate OTP',
    });
  }
});

// ─── Validate OTP ──────────────────────────────────────────
app.post('/api/transfers/validate-otp', async (req, res) => {
  try {
    const { sessionId, otp } = req.body;
    const session = otpSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or expired',
      });
    }

    session.attempts += 1;

    if (session.attempts > 3) {
      otpSessions.delete(sessionId);
      return res.status(401).json({
        success: false,
        message: 'Too many attempts. Please request a new OTP.',
      });
    }

    console.log('🔐 Validating OTP...');

    const response = await flwRequest('POST', `/otps/${session.otpRef}/validate`, {
      otp: otp,
    });

    if (response.data.valid === true || response.data.valid === 'true') {
      session.validated = true;
      console.log('✅ OTP validated successfully');
      res.json({
        success: true,
        message: 'OTP validated successfully',
      });
    } else {
      console.log('❌ Invalid OTP');
      res.status(401).json({
        success: false,
        message: 'Invalid OTP',
        attemptsRemaining: 3 - session.attempts,
      });
    }
  } catch (err) {
    console.error('❌ Validate OTP error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Invalid OTP',
    });
  }
});

// ─── Initiate Transfer ──────────────────────────────────────
app.post('/api/transfers/initiate', async (req, res) => {
  try {
    console.log('📥 /api/transfers/initiate called');
    const {
      recipient_bank_code,
      recipient_account_number,
      amount,
      description,
      currency = 'NGN',
      otp_session_id,
    } = req.body;

    const session = otpSessions.get(otp_session_id);
    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'OTP session not found. Please request a new OTP.',
      });
    }

    if (!session.validated) {
      return res.status(401).json({
        success: false,
        message: 'OTP not validated. Please validate OTP first.',
      });
    }

    const reference = `txn_${Date.now()}_${uuidv4().slice(0, 8)}`;

    console.log('💸 Initiating transfer...');

    const transferData = await flwRequest('POST', '/transfers', {
      account_bank: recipient_bank_code,
      account_number: recipient_account_number,
      amount: parseFloat(amount),
      narration: description || 'NGN Transfer',
      currency: currency,
      reference: reference,
      debit_currency: currency,
    });

    otpSessions.delete(otp_session_id);

    console.log('✅ Transfer initiated');

    res.json({
      success: true,
      reference: transferData.data.reference,
      transferId: transferData.data.id,
      status: transferData.data.status,
      message: 'Transfer initiated successfully',
    });
  } catch (err) {
    console.error('❌ Transfer error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to initiate transfer',
    });
  }
});

// ─── Get Transfer Status ────────────────────────────────────
app.get('/api/transfers/status', async (req, res) => {
  try {
    const { ref } = req.query;
    const data = await flwRequest('GET', `/transfers/${ref}`);
    
    res.json({
      success: true,
      reference: data.data.reference,
      status: data.data.status,
      amount: data.data.amount,
      currency: data.data.currency,
      recipient: data.data.account_number,
      timestamp: data.data.created_at,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to get transfer status',
    });
  }
});

// ─── List Banks ─────────────────────────────────────────────
app.get('/api/banks', async (req, res) => {
  try {
    const data = await flwRequest('GET', '/banks/NG');
    res.json({
      success: true,
      banks: data.data,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to get banks',
    });
  }
});

// ─── Resend OTP ─────────────────────────────────────────────
app.post('/api/transfers/resend-otp', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = otpSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or expired',
      });
    }

    console.log('📱 Resending OTP...');

    const response = await flwRequest('POST', '/otps', {
      length: 6,
      customer: {
        name: 'Customer',
        phone: '+2348000000000',
        email: 'customer@example.com',
      },
      sender: 'NGN Transfer',
      send: 'email',
      medium: ['email'],
      expiry: 300,
    });

    session.otpRef = response.data.reference;
    session.createdAt = Date.now();
    session.attempts = 0;
    session.validated = false;

    res.json({
      success: true,
      sessionId: sessionId,
      message: 'OTP resent successfully',
    });
  } catch (err) {
    console.error('❌ Resend error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to resend OTP',
    });
  }
});

// ─── Get OTP Status ─────────────────────────────────────────
app.get('/api/transfers/otp-status', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const session = otpSessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or expired',
      });
    }

    res.json({
      success: true,
      sessionId: sessionId,
      validated: session.validated,
      attempts: session.attempts,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to get OTP status',
    });
  }
});

// ─── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Flutterwave v3 backend running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.FLW_ENV || 'sandbox'}`);
  console.log(`🔑 Secret Key: ${process.env.FLW_SECRET_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔑 Public Key: ${process.env.FLW_PUBLIC_KEY ? '✅ Set' : '❌ Missing'}`);
});
