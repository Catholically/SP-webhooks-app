xexport default function handler(req, res) {
  if (req.method === 'POST') {
    console.log('Webhook ricevuto:', req.body);
    res.status(200).json({ success: true, data: req.body });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
