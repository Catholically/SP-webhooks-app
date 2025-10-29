export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST') {
    console.log('Webhook ricevuto:', req.body);
    return res.status(200).json({ 
      success: true, 
      message: 'Webhook ricevuto',
      data: req.body 
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}