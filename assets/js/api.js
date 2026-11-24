window.BlackspotAPI = (() => {
  const base = window.BLACKSPOT_API_URL || 'http://127.0.0.1:8000';
  async function request(path, options = {}) {
    const response = await fetch(base + path, options);
    if (!response.ok) {
      let detail = `Request failed (${response.status})`;
      try { detail = (await response.json()).error || detail; } catch (_) {}
      throw new Error(detail);
    }
    return response.json();
  }
  return {
    get: (path) => request(path),
    post: (path, body) => request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    upload: (path,file) => {
      const form = new FormData();
      form.append('file',file);
      return request(path,{method:'POST',body:form});
    },
  };
})();
