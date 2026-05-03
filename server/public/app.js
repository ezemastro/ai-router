document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');
  const output = document.getElementById('output');

  clear.addEventListener('click', () => {
    input.value = '';
    output.textContent = '';
  });

  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    output.textContent = '';

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
      });

      if (!res.ok) {
        output.textContent = `Error: ${res.status} ${res.statusText}`;
        return;
      }

      if (!res.body) {
        output.textContent = await res.text();
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output.textContent += dec.decode(value);
        output.scrollTop = output.scrollHeight;
      }
    } catch (err) {
      output.textContent = String(err);
    } finally {
      send.disabled = false;
    }
  });
});
