// Prototype helper before the bot exists: print a one-time connect link for a member.
// Usage: node scripts/link.js lead Lead   (server must not be running; it reloads the store on start)
try { process.loadEnvFile(); } catch {}
const { connectUrl } = await import('../src/server.js');
const [memberId = 'lead', label = memberId] = process.argv.slice(2);
console.log(connectUrl(memberId, label));
