// Wraps a Vercel serverless handler with fire-and-forget Slack error reporting.
// Intercepts console.error calls and uncaught throws during the request.

function postToSlack(webhookUrl, text) {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {}); // silent fail
}

function withErrorReporting(handler) {
  return async (req, res) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    const capturedErrors = [];

    const originalConsoleError = console.error;
    console.error = (...args) => {
      originalConsoleError(...args); // preserve normal Vercel logging
      capturedErrors.push(
        args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      );
    };

    const endpoint = `${req.method} ${req.url}`;
    const ts = new Date().toISOString();

    try {
      await handler(req, res);

      if (webhookUrl && capturedErrors.length > 0) {
        postToSlack(webhookUrl, [
          `⚠️ *${endpoint}* — ${ts}`,
          '```' + capturedErrors.join('\n').slice(0, 500) + '```',
        ].join('\n'));
      }
    } catch (err) {
      if (webhookUrl) {
        const stack = (err.stack ?? err.message ?? String(err)).slice(0, 500);
        const lines = [
          `🚨 *${endpoint}* — ${ts}`,
          `*Error:* ${err.message}`,
        ];
        if (capturedErrors.length > 0) {
          lines.push('*Console errors:*\n```' + capturedErrors.join('\n').slice(0, 300) + '```');
        }
        lines.push('```' + stack + '```');
        postToSlack(webhookUrl, lines.join('\n'));
      }
      throw err; // re-throw so Vercel still logs it
    } finally {
      console.error = originalConsoleError; // always restore
    }
  };
}

module.exports = { withErrorReporting };
