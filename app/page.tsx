export default function HomePage() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>SP Webhooks API</h1>
      <p>Webhook endpoints are available at:</p>
      <ul>
        <li><code>/api/ping</code> - Health check endpoint</li>
        <li><code>/api/webhooks/spedirepro</code> - SpedirePro webhook</li>
        <li><code>/api/webhooks/orders-updated</code> - Orders updated webhook</li>
      </ul>
    </main>
  );
}
