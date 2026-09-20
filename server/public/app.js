document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');
  const output = document.getElementById('output');
  const modelSelect = document.getElementById('model');
  const tokenInput = document.getElementById('token');

  tokenInput.value = localStorage.getItem('apiToken') || '';
  tokenInput.addEventListener('input', () => {
    localStorage.setItem('apiToken', tokenInput.value);
  });

  // El listado de modelos sale de GET /providers: la lista vive en el
  // registry del servidor, así una deprecación no obliga a tocar el front.
  async function loadModels() {
    try {
      const res = await fetch('/providers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const providers = (data && data.providers) || [];
      for (const provider of providers) {
        const models = provider.models || [];
        if (models.length === 0) continue;
        const group = document.createElement('optgroup');
        group.label = provider.requiresAuth
          ? `${provider.label} (requiere token)`
          : provider.label;
        for (const model of models) {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          group.appendChild(option);
        }
        modelSelect.appendChild(group);
      }
      if (providers.length === 0) {
        modelSelect.options[0].textContent = 'Automático (no hay proveedores configurados)';
      }
    } catch (err) {
      // Sin la lista, "Automático" sigue funcionando: el servidor elige.
      modelSelect.options[0].textContent = 'Automático (no se pudo cargar la lista de modelos)';
    }
  }

  loadModels();

  clear.addEventListener('click', () => {
    input.value = '';
    output.textContent = '';
  });

  function processEvent(payload) {
    if (payload === '[DONE]') return;
    if (payload.startsWith('{')) {
      try {
        const parsed = JSON.parse(payload);
        if (parsed.error) {
          output.textContent = `Error del proveedor: ${parsed.error}`;
          return;
        }
      } catch {
        // not JSON, append as raw text
      }
    }
    output.textContent += payload;
    output.scrollTop = output.scrollHeight;
  }

  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    output.textContent = '';

    const headers = { 'Content-Type': 'application/json' };
    const body = { messages: [{ role: 'user', content: text }] };
    if (modelSelect.value) body.model = modelSelect.value;
    const token = tokenInput.value.trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        output.textContent = `Error ${res.status}: ${(data && data.error) || res.statusText}`;
        return;
      }

      if (!res.body) {
        output.textContent = await res.text();
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) processEvent(line.slice(6));
          }
        }
      }
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) processEvent(line.slice(6));
      }
    } catch (err) {
      output.textContent = String(err);
    } finally {
      send.disabled = false;
    }
  });
});
