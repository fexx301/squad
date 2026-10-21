try { process.loadEnvFile(); } catch {}
const { serve } = await import('../src/server.js');
serve({ onConnected: (d) => console.log('connected:', d) });
