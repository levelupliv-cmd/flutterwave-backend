require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const otpSessions = new Map();
let _flwToken = null;
let _flwTokenExpiry = 0;

async function getFlwToken() {
  const now = Date.now();
  if (_flwToken && now < _flwTokenExpiry - 60000) return _flwToken;

  const res = await fetch(
    'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.FLW_CLIENT_ID,
        client_secret: process.env.FLW_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    }
  );

  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get token');
  _flwToken = data.access_token;
  _flwTokenExpiry = now + data.expires_in * 1000;
  return _flwToken;
}

const FLW_BASE = process.env.FLW_ENV === 'production'
  ? 'https://api.flutterwave.cloud/f4b/production'
  : 'https://api.flutterwave.cloud/f4b/sandbox';

async function flwRequest(method, path, body) {
  const token = await getFlwToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Trace-Id': uuidv4(),
  };
  if (method !== 'GET') headers['X-Idempotency-Key'] = uuidv4();

  const res = await fetch(`${FLW_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Flutterwave backend running!' });
});

app.post('/api/transfers/initiate', async (req, res) => {
  try {
    const { recipient_bank_code, recipient_account_number, amount, description, sender_account_number, currency = 'NGN' } = req.body;
    const reference = `txn_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const transferData = await flwRequest('POST', '/v4/direct-transfers', {
      action: 'deferred',
      type: 'bank',
      reference,
      narration: description || 'NGN Transfer',
      payment_instruction: {
        source_currency: currency,
        destination_currency: currency,
        amount: { value: parseFloat(amount), applies_to: 'destination_currency' },
        recipient: {
          bank: {
            account_number: recipient_account_number,
            code: recipient_bank_code,
          },
        },
      },
    });

    const transferId = transferData.data.id;
    otpSessions.set(reference, {
      transferId,
      reference,
      amount,
      currency,
      status: 'initiated',
      createdAt: Date.now(),
      attemptsRemaining: 3,
    });

    let otpDelivery = { otpStatus: 'pending', expiresInSeconds: 300, attemptsRemaining: 3 };
    try {
      const otpData = await flwRequest('POST', `/v4/transfers/${transferId}/otp`, { sender_account_number });
      otpDelivery = {
        otpStatus: 'sent',
        expiresInSeconds: otpData.data?.expires_in || 300,
        attemptsRemaining: 3,
        maskedPhone: otpData.data?.masked_phone || null,
        maskedEmail: otpData.data?.masked_email || null,
      };
      otpSessions.get(reference).otpStatus = 'sent';
    } catch (otpErr) {
      otpDelivery.otpStatus = 'failed';
    }

    res.json({ success: true, reference, otpDelivery, transferId });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

app.post('/api/transfers/confirm', async (req, res) => {
  try {
    const { reference, otp } = req.body;
    const session = otpSessions.get(reference);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const finalizeData = await flwRequest('POST', `/v4/transfers/${session.transferId}/finalize`, { otp });
    const status = finalizeData.data?.status === 'SUCCESSFUL' ? 'success' : 'processing';
    otpSessions.delete(reference);

    res.json({ success: true, reference, status });
  } catch (err) {
    const session = otpSessions.get(req.body.reference);
    if (session) session.attemptsRemaining = Math.max(0, (session.attemptsRemaining || 3) - 1);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

app.post('/api/transfers/resend-otp', async (req, res) => {
  try {
    const { reference } = req.body;
    const session = otpSessions.get(reference);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const otpData = await flwRequest('POST', `/v4/transfers/${session.transferId}/otp`, {});
    session.attemptsRemaining = Math.max(0, (session.attemptsRemaining || 3) - 1);

    res.json({
      success: true,
      reference,
      otpDelivery: {
        otpStatus: 'sent',
        expiresInSeconds: otpData.data?.expires_in || 300,
        attemptsRemaining: session.attemptsRemaining,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

app.get('/api/transfers/otp-status', async (req, res) => {
  const { reference } = req.query;
  const session = otpSessions.get(reference);
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  res.json({ success: true, reference, otpStatus: session.otpStatus || 'pending', attemptsRemaining: session.attemptsRemaining ?? 3 });
});

app.get('/api/transfers/status', async (req, res) => {
  try {
    const { ref } = req.query;
    const data = await flwRequest('GET', `/v4/transfers/${ref}`);
    const t = data.data;
    res.json({
      success: true,
      reference: t.reference || ref,
      status: t.status === 'SUCCESSFUL' ? 'success' : 'failed',
      amount: t.amount?.value,
      recipient: t.recipient?.bank?.account_number || '',
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});