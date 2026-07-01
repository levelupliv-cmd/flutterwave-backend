const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

// Listen on 0.0.0.0 (CRITICAL for Railway)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Routes
app.get('/', (req, res) => {
  res.send('🚀 Backend is running!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});
