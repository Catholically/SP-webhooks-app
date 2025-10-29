const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  console.log('Webhook ricevuto:', req.body);
  res.status(200).json({ success: true });
});

app.get('/', (req, res) => {
  res.status(200).json({ message: 'Server OK' });
});

module.exports = app;
