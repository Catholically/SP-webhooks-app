const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  console.log('Webhook ricevuto:', req.body);
  res.json({ success: true });
});

app.listen(3000, () => {
  console.log('Server in ascolto sulla porta 3000');
});