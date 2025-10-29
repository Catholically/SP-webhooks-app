xexport default function handler(req, res) {
  if (req.method === 'POST') {
    console.log('Webhook ricevuto:', req.body);
    res.status(200).json({ success: true, data: req.body });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
```

Salva.

Poi fai push:
```
git add .
git commit -m "Use Vercel API routes"
git push
```

Aspetta 2 minuti e prova:
```
Invoke-WebRequest -Uri "https://webhooks.catholically.com/api/webhook" -Method POST -ContentType "application/json" -Body '{"test":"ciao"}'